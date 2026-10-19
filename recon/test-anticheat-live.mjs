// 端到端：真实客户端连代理 → 反作弊告警应同时出现在控制台和该玩家聊天栏
import { spawn } from 'node:child_process';
import mc from 'minecraft-protocol';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const proxy = spawn(process.execPath, ['build/reverse_proxy/index.js'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, IMC_AUTO_LOGIN: 'off', IMC_BROWSER_LOGIN: 'off', IRC_AUTO_LOGIN: 'off', DEBUG: 'false' },
});

let consoleOut = '';
proxy.stdout.on('data', (d) => (consoleOut += d.toString()));
proxy.stderr.on('data', (d) => (consoleOut += d.toString()));

await sleep(2500);

const chats = [];
const client = mc.createClient({ host: '127.0.0.1', port: 25565, username: 'ACBot', version: '1.8.9', auth: 'offline' });
client.on('chat', (p) => {
  const text = typeof p.message === 'string' ? p.message : JSON.stringify(p.message);
  chats.push(text);
});
client.on('error', () => {});
client.on('end', () => {});

await sleep(3000); // 等进服 + 过 30 tick 热身

// 触发 ScaffoldC：85° 俯仰角放方块（重复几次，避免客户端自身的 look 包覆盖俯仰角）
const pos = client.entity?.position ?? { x: 0, y: 64, z: 0 };
const x = Math.floor(pos.x) + 0.5;
const y = Math.floor(pos.y);
const z = Math.floor(pos.z) + 0.5;
for (let i = 0; i < 5; i++) {
  try {
    client.write('position_look', { x, y, z, yaw: 0, pitch: 85, onGround: true });
    client.write('arm_animation', {});
    client.write('block_place', { location: { x: Math.floor(x), y: y - 1, z: Math.floor(z) }, direction: 1, heldItem: { present: false }, cursorX: 0.5, cursorY: 0.5, cursorZ: 0.5, blocking: false });
  } catch (err) {
    console.log('  write failed: ' + err.message);
  }
  await sleep(120);
}

await sleep(1200);

// 控制台 /anticheat
proxy.stdin.write('/anticheat\n');
await sleep(900);

try { client.end(); } catch {}
await sleep(300);
try { proxy.kill(); } catch {}
await sleep(300);

const clean = consoleOut.replace(/\u001b\[[0-9;]*m/g, '');
const consoleAlerts = clean.split(/\r?\n/).filter((l) => l.includes('failed') && l.includes('AntiCheat'));
const chatAlerts = chats.filter((c) => c.includes('failed'));
const commandShowsPlayer = clean.includes('ACBot') && clean.includes('Anti-cheat');

console.log('===== 控制台告警 =====');
console.log(`  条数: ${consoleAlerts.length}`);
consoleAlerts.slice(0, 4).forEach((l) => console.log('  ' + l.trim()));

console.log('===== 游戏内聊天栏告警 =====');
console.log(`  条数: ${chatAlerts.length}`);
chatAlerts.slice(0, 4).forEach((c) => console.log('  ' + c.slice(0, 110)));

console.log('===== /anticheat 命令 =====');
console.log(`  输出包含玩家名与标题: ${commandShowsPlayer}`);
const acSection = clean.split(/\r?\n/).filter((l) => /Anti-cheat|VL |violations|ACBot|failed/.test(l));
console.log('  /anticheat 输出片段:');
acSection.slice(-14).forEach((l) => console.log('    ' + l.trim()));

const pass = consoleAlerts.length > 0 && chatAlerts.length > 0 && commandShowsPlayer;
console.log(`===== 总体: ${pass ? 'PASS' : 'FAIL'} =====`);
process.exit(pass ? 0 : 1);
