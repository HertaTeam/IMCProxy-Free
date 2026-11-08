// 配置命令回归：每个键独立命令 + 类型校验 + 非法值不写盘
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const root = process.argv[2];
const configPath = root + '/config.json';

function run(commands) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['build/reverse_proxy/index.js'], {
      cwd: root,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, IMC_AUTO_LOGIN: 'off', IMC_BROWSER_LOGIN: 'off', IRC_AUTO_LOGIN: 'off' },
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    commands.forEach(([text, at]) => setTimeout(() => child.stdin.write(text + '\n'), at));
    setTimeout(() => {
      child.kill();
      resolve(out.replace(/\u001b\[[0-9;]*m/g, ''));
    }, commands[commands.length - 1][1] + 900);
  });
}

const before = JSON.parse(fs.readFileSync(configPath, 'utf8'));

const output = await run([
  ['/tcpport', 2400],
  ['/tcpport abc', 2900],
  ['/tcpport 70000', 3300],
  ['/proxy tcpPort 1234', 3700],
  ['/overlay.mode fast', 4100],
  ['/overlay.mode bedwars', 4500],
  ['/overlay.decorateTab on', 4900],
  ['/settings overlay', 5300],
]);

const lines = output.split(/\r?\n/);
const has = (re) => lines.some((line) => re.test(line));
const show = (re, count = 2) => {
  const index = lines.findIndex((line) => re.test(line));
  if (index < 0) return [];
  return lines.slice(index, index + count).map((line) => line.trim());
};

let pass = true;
const check = (label, ok, extra = '') => {
  if (!ok) pass = false;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
};

check('单独命令可查看当前值', has(/INFO\s+Console\s+\/tcpPort/) && has(/type: integer/), JSON.stringify(show(/INFO\s+Console\s+\/tcpPort/)));
check('非数字被拒绝', has(/Invalid value for "tcpPort": expected a number/), JSON.stringify(show(/Invalid value for "tcpPort": expected a number/)));
check('超范围被拒绝', has(/must be <= 65535/), JSON.stringify(show(/must be <= 65535/)));
check('旧 /proxy 命令已移除', has(/Unknown command|\/proxy/), JSON.stringify(show(/Unknown command/)));
check('枚举非法值被拒绝', has(/Invalid value for "overlay.mode"/), JSON.stringify(show(/Invalid value for "overlay.mode"/)));
check('枚举合法值被接受', has(/overlay\.mode = bedwars/), JSON.stringify(show(/overlay\.mode = bedwars/)));
check('布尔命令可用', has(/overlay\.decorateTab = true/), JSON.stringify(show(/overlay\.decorateTab/)));
check('/settings 只读列出', has(/── overlay/), JSON.stringify(show(/── overlay/, 5)));

const after = JSON.parse(fs.readFileSync(configPath, 'utf8'));
check('非法值没有写入 config.json', after.tcpPort === before.tcpPort, `tcpPort ${before.tcpPort} -> ${after.tcpPort}`);

// 还原测试中改动的值
after.overlay = after.overlay ?? {};
after.overlay.mode = before.overlay?.mode ?? 'auto';
after.overlay.decorateTab = before.overlay?.decorateTab ?? true;
fs.writeFileSync(configPath, JSON.stringify(after, null, 2) + '\n', 'utf8');

console.log(`===== ${root.split(/[\\/]/).pop()} 总体: ${pass ? 'PASS' : 'FAIL'} =====`);
process.exit(pass ? 0 : 1);
