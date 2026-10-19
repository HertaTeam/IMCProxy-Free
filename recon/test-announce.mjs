// 公告刷屏：间隔应为 10 秒；enabled=false 时应完全不刷
import { spawn } from 'node:child_process';
import { startAnnounce } from '../build/reverse_proxy/Announce.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- A. 默认配置：10 秒一次 ----
const proxy = spawn(process.execPath, ['build/reverse_proxy/index.js'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, IMC_AUTO_LOGIN: 'off', IMC_BROWSER_LOGIN: 'off', IRC_AUTO_LOGIN: 'off', DEBUG: 'false' },
});
let out = '';
proxy.stdout.on('data', (d) => (out += d.toString()));
proxy.stderr.on('data', (d) => (out += d.toString()));

await sleep(12500);
try { proxy.kill(); } catch {}
await sleep(400);

const clean = out.replace(/\u001b\[[0-9;]*m/g, '');
const hits = clean.split(/\r?\n/).filter((l) => l.includes('本项目已暂停制作新内容'));
const times = hits.map((l) => l.slice(0, 8));
const seconds = times.map((t) => {
  const [h, m, s] = t.split(':').map(Number);
  return h * 3600 + m * 60 + s;
});
const gaps = [];
for (let i = 1; i < seconds.length; i++) gaps.push(seconds[i] - seconds[i - 1]);

console.log('===== A. 默认配置（announce.enabled=true, intervalMs=10000）=====');
console.log('  公告次数:', hits.length);
console.log('  时间点:', times.join(' '));
console.log('  间隔(秒):', gaps.join(' '));
const intervalLine = clean.split(/\r?\n/).find((l) => l.includes('Announce spam every'));
console.log('  启动提示:', intervalLine ? intervalLine.trim().slice(0, 90) : '(无)');

// ---- B. 关闭刷屏 ----
const calls = [];
const stub = { broadcastChat: (t) => calls.push(t) };
const timer = startAnnounce(stub, { enabled: false, intervalMs: 10000, console: false, inGameChat: true });
await sleep(400);
if (timer) clearInterval(timer);

console.log('===== B. announce.enabled = false =====');
console.log('  startAnnounce 返回:', timer === null ? 'null（未启动）' : '定时器（错误）');
console.log('  推送次数:', calls.length);

const intervalOk = hits.length >= 2 && gaps.every((g) => g >= 9 && g <= 11);
const disabledOk = timer === null && calls.length === 0;
console.log(`===== A: ${intervalOk ? 'PASS' : 'FAIL'}   B: ${disabledOk ? 'PASS' : 'FAIL'} =====`);
process.exit(intervalOk && disabledOk ? 0 : 1);
