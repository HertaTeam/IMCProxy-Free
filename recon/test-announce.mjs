// 验证公告刷屏：控制台每 3 秒一次 + 进服后游戏内聊天栏也能收到
import { spawn } from 'node:child_process';
import mc from 'minecraft-protocol';

const proxy = spawn(process.execPath, ['build/reverse_proxy/index.js'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, IMC_AUTO_LOGIN: 'off', IMC_BROWSER_LOGIN: 'off', IRC_AUTO_LOGIN: 'off' },
});

let consoleOut = '';
proxy.stdout.on('data', (d) => (consoleOut += d.toString()));
proxy.stderr.on('data', (d) => (consoleOut += d.toString()));

await new Promise((r) => setTimeout(r, 2500));

const chats = [];
const client = mc.createClient({
  host: '127.0.0.1',
  port: 25565,
  username: 'SpamTest',
  version: '1.8.9',
  auth: 'offline',
});
client.on('chat', (p) => {
  const text = typeof p.message === 'string' ? p.message : JSON.stringify(p.message);
  chats.push(text);
});
client.on('error', () => {});
client.on('end', () => {});

await new Promise((r) => setTimeout(r, 9000));

try { client.end(); } catch {}
await new Promise((r) => setTimeout(r, 300));
try { proxy.kill(); } catch {}
await new Promise((r) => setTimeout(r, 300));

const clean = consoleOut.replace(/\u001b\[[0-9;]*m/g, '');
const noticeLines = clean.split(/\r?\n/).filter((l) => l.includes('暂停制作新内容') || l.includes('1131093494'));

console.log('===== 控制台刷屏 =====');
console.log(`  命中公告行数: ${noticeLines.length}`);
noticeLines.slice(0, 8).forEach((l) => console.log('  ' + l.trim()));

console.log('===== 游戏内聊天栏 =====');
console.log(`  收到聊天包: ${chats.length}`);
[...new Set(chats)].slice(0, 6).forEach((c) => console.log('  ' + c.slice(0, 120)));

process.exit(0);
