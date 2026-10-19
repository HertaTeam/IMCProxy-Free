// 反作弊移植的回归测试：用合成封包驱动全部检查，验证告警能到控制台 + 聊天栏
import mcp from 'minecraft-protocol';
import { AntiCheatManager } from '../build/reverse_proxy/anticheat/index.js';

const { createSerializer, states } = mcp;
const serializer = createSerializer({
  state: states.PLAY,
  isServer: true, // -> toClient
  version: '1.8.9',
  customPackets: null,
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chats = [];
const ac = new AntiCheatManager({
  enabled: true,
  threshold: 1.0,
  latency: 600,
  vlClearTicks: 6000,
  alertBuffer: false, // 每次都告警，便于断言
  experimental: true,
  console: true,
  inGameChat: true,
  checks: {},
});

ac.setChatSink((player, text) => chats.push(`${player}: ${text}`));
ac.registerPlayer('TestBot');

const serverPacket = (name, params) => ac.handleServerPacket('TestBot', serializer.createPacketBuffer({ name, params }));
const clientPacket = (name, params) => ac.handleClientPacket('TestBot', params, { name, state: 'play' });

// 等过 30 tick 的 disableTick 热身
await sleep(1700);

// --- SpeedA：贴地疾跑，每 tick 0.4 格（8 格/秒，超过 5.612 + 1.0）
let x = 0;
for (let i = 0; i < 30; i++) {
  x += 0.4;
  clientPacket('position', { x, y: 64, z: 0, onGround: true });
  await sleep(50);
}

// --- FlyA：持续滞空且垂直位移恒为 0，水平仍在移动
for (let i = 0; i < 4; i++) {
  x += 0.2;
  clientPacket('position', { x, y: 70, z: 0, onGround: false });
  await sleep(55);
}
await sleep(120);

// --- SpeedB：疾跑 + 饥饿值 6
clientPacket('entity_action', { actionId: 3 });
serverPacket('update_health', { health: 20, food: 6, foodSaturation: 0 });
await sleep(200);

// --- ScaffoldC：先挥手，再以 85° 俯仰角放方块
clientPacket('position_look', { x, y: 64, z: 0, yaw: 0, pitch: 85, onGround: true });
clientPacket('arm_animation', {});
clientPacket('block_place', { location: { x: 0, y: 0, z: 0 }, direction: 1, heldItem: {}, cursorX: 0.5, cursorY: 0.5, cursorZ: 0.5 });
await sleep(150);

// --- AutoClickerA：15 次挥手挤在 300ms 内
for (let i = 0; i < 20; i++) {
  clientPacket('arm_animation', {});
  await sleep(15);
}
await sleep(200);

const status = ac.status();
const violations = status[0]?.violations ?? {};
const consoleLines = [];

console.log('===== 违规统计 =====');
console.log(JSON.stringify(violations, null, 2));
console.log('===== 聊天栏告警（前 6 条）=====');
chats.slice(0, 6).forEach((c) => console.log('  ' + c));
console.log(`聊天栏告警总数: ${chats.length}`);

const expected = ['SpeedA', 'FlyA', 'SpeedB', 'AutoClickerA'];
const missing = expected.filter((name) => !(name in violations));
const hasScaffold = 'ScaffoldC' in violations;

console.log('===== 结论 =====');
console.log(`  必检项 ${expected.join(', ')}: ${missing.length === 0 ? '全部命中' : '缺失 ' + missing.join(', ')}`);
console.log(`  ScaffoldC(85° 放方块): ${hasScaffold ? '命中' : '未命中'}`);
console.log(`  聊天栏输出: ${chats.length > 0 ? '正常' : '无输出'}`);
console.log(`  总体: ${missing.length === 0 && chats.length > 0 ? 'PASS' : 'FAIL'}`);

ac.shutdown();
process.exit(missing.length === 0 && chats.length > 0 ? 0 : 1);
