// logs/ 文件夹：每次运行一个 logs-<时间戳>.txt
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const root = process.argv[2] || process.cwd();
const rootAbs = path.resolve(root); // 先定成绝对路径：后面会 chdir
const entry = path.resolve(rootAbs, 'build/reverse_proxy/index.js');

let pass = 0, fail = 0;
const ok = (c, l) => { console.log(`${c ? '  PASS' : '  FAIL'}  ${l}`); c ? pass++ : fail++; };

const NO_BROWSER = {
  ...process.env,
  IMC_AUTO_LOGIN: 'off',
  IMC_BROWSER_LOGIN: 'off',
  IRC_AUTO_LOGIN: 'off',
};

function runIn(cwd, input, ms = 4500) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [entry], { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: NO_BROWSER });
    let out = '';
    p.stdout.on('data', (d) => (out += d.toString()));
    p.stderr.on('data', (d) => (out += d.toString()));
    setTimeout(() => { if (input) p.stdin.write(input); }, 1500);
    setTimeout(() => {
      p.kill();
      resolve(out.replace(/\u001b\[[0-9;]*m/g, ''));
    }, ms);
  });
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'imcp-logs-'));
const logsDir = path.join(tmp, 'logs');
const listLogs = () =>
  fs.existsSync(logsDir)
    ? fs.readdirSync(logsDir).filter((n) => /^logs-.*\.txt$/.test(n)).sort()
    : [];

console.log('--- 1. 启动创建 logs/ 与日志文件 ---');
ok(!fs.existsSync(logsDir), '测试目录原本没有 logs/');
let out = await runIn(tmp, '/help\n');
ok(fs.existsSync(logsDir), 'logs/ 已自动创建');
const first = listLogs();
ok(first.length === 1, `生成了 1 个日志文件（实际 ${first.length}）`);
console.log('    文件名: ' + first.join(', '));
ok(/^logs-\d{8}-\d{6}\.txt$/.test(first[0] ?? ''), '文件名是 logs-<时间戳>.txt');
ok(/Log file/i.test(out), '启动输出里显示了日志路径');

console.log('\n--- 2. 日志内容 ---');
const text1 = fs.readFileSync(path.join(logsDir, first[0]), 'utf8');
const lines = text1.split(/\r?\n/);
console.log('    前 6 行:');
lines.slice(0, 6).forEach((l) => console.log('      ' + l.slice(0, 100)));
ok(/log started at/.test(text1), '有开始标记');
// 注意：Windows 上 kill() 是强杀，exit 钩子不执行，所以集成测试这里不断言收尾标记。
// 收尾标记由 closeRunLog() 负责，下面用单元测试单独验证。
ok(/Eaglercraft Reverse Proxy/.test(text1), '记录了启动分节标题');
ok(/Config file/.test(text1), '记录了配置文件路径');
ok(/Tab completes command names/.test(text1), '记录了 /help 的输出');
ok(!/\x1b\[/.test(text1), '日志文件里没有 ANSI 颜色码');
ok(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s+INFO\s/m.test(text1), '日志文件行首是完整时间戳 + 级别');

console.log('\n--- 3. 每次运行一个独立文件 ---');
await new Promise((r) => setTimeout(r, 1100)); // 让时间戳至少差 1 秒
out = await runIn(tmp, '');
const second = listLogs();
ok(second.length === 2, `第二次运行后共 2 个文件（实际 ${second.length}）`);
ok(second[0] !== second[1], '两个文件名不同');

console.log('\n--- 4. 旧日志自动裁剪（保留最近 50 份）---');
for (let i = 0; i < 60; i++) {
  fs.writeFileSync(path.join(logsDir, `logs-2020010${(i % 9) + 1}-00000${i % 10}.txt`), 'old\n', 'utf8');
}
const before = listLogs().length;
out = await runIn(tmp, '');
const after = listLogs();
ok(before > 50, `裁剪前有 ${before} 份`);
ok(after.length <= 50, `运行后裁剪到 ${after.length} 份（≤50）`);
ok(out.length > 0, '进程正常跑了');

console.log('\n--- 5. logs/ 已在 .gitignore 里 ---');
const gi = path.resolve(rootAbs, '.gitignore');
if (fs.existsSync(gi)) {
  ok(/^logs\/$/m.test(fs.readFileSync(gi, 'utf8')), '.gitignore 含 logs/');
} else {
  console.log('  SKIP  .gitignore 不在这个目录');
}

console.log('\n--- 6. closeRunLog 写收尾标记（单元级）---');
{
  const unitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'imcp-logunit-'));
  const prevCwd = process.cwd();
  process.chdir(unitDir); // startRunLog 用的是 cwd
  try {
    const loggerMod = await import(pathToFileURL(path.resolve(rootAbs, 'build/logger.js')).href);
    const file = loggerMod.startRunLog('logs', 50);
    ok(typeof file === 'string' && fs.existsSync(file), 'startRunLog 返回并创建了文件');
    ok(loggerMod.getLogFilePath() === file, 'getLogFilePath 返回同一路径');

    const log = new loggerMod.Logger('UnitTest');
    log.info('hello from unit test');
    log.warn('a warning');
    loggerMod.closeRunLog();
    ok(loggerMod.getLogFilePath() === null, 'close 之后路径清空');

    const body = fs.readFileSync(file, 'utf8');
    ok(/hello from unit test/.test(body), 'info 写进了文件');
    ok(/a warning/.test(body), 'warn 写进了文件');
    ok(/log stopped at/.test(body), 'closeRunLog 写了收尾标记');
    ok(!/\x1b\[/.test(body), '单元日志也没有颜色码');
  } finally {
    process.chdir(prevCwd);
    fs.rmSync(unitDir, { recursive: true, force: true });
  }
}

try {
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
} catch (err) {
  console.log(`  （临时目录清理失败，忽略：${err.code}）`);
}
console.log(`\n===== ${pass} passed, ${fail} failed =====`);
process.exit(fail ? 1 : 0);
