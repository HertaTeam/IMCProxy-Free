// 反作弊改成"检测其他玩家"后的验证：
//  A. 本地玩家（走代理的人）自己移动 → 不应触发任何检查
//  B. 其他玩家正常走路 → 不误报
//  C. 其他玩家加速 / 瞬移 → 必须抓到，且告警里带的是那个玩家的名字
import mcp from 'minecraft-protocol';
import { AntiCheatManager } from '../build/reverse_proxy/anticheat/index.js';

const { createSerializer, states } = mcp;
const serializer = createSerializer({ state: states.PLAY, isServer: true, version: '1.8.9', customPackets: null });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chats = [];
const ac = new AntiCheatManager({
  enabled: true,
  threshold: 1.0,
  latency: 600,
  vlClearTicks: 0,
  alertBuffer: false,
  experimental: false,
  console: false,
  inGameChat: true,
  checks: {},
});
ac.setChatSink((player, text) => chats.push(`${player} | ${text}`));

// 平地世界
const world = ac.worldModel();
for (let cx = -8; cx <= 8; cx++) {
  for (let cz = -8; cz <= 8; cz++) {
    world.markChunkLoaded(cx, cz);
    for (let x = cx * 16; x < cx * 16 + 16; x++) {
      for (let z = cz * 16; z < cz * 16 + 16; z++) {
        for (let y = 60; y <= 63; y++) world.setBlock(x, y, z, 1, 0);
      }
    }
  }
}

const server = (name, params) => ac.handleServerPacket('LocalPlayer', serializer.createPacketBuffer({ name, params }));
const client = (name, params) => ac.handleClientPacket('LocalPlayer', params, { name, state: 'play' });

const UUID = '11111111-2222-3333-4444-555555555555';
const OTHER_ID = 42;

// 注册其他玩家
server('player_info', { action: 0, data: [{ UUID, name: 'Cheater', properties: [] }] });
server('named_entity_spawn', {
  entityId: OTHER_ID,
  playerUUID: UUID,
  // 1.8 生成包坐标是 i32 定点数（×32）
  x: 0.5 * 32, y: 64 * 32, z: 0.5 * 32, yaw: 0, pitch: 0, currentItem: 0, metadata: [],
});
server('entity_metadata', { entityId: OTHER_ID, metadata: [{ key: 0, type: 0, value: 8 }] }); // 疾跑标志

// A. 本地玩家狂飙（不该被抓，因为检测对象是别人）
for (let i = 0; i < 10; i++) {
  client('position', { x: i * 3, y: 64, z: 0, onGround: true });
}
await sleep(300);

// B. 其他玩家正常走路：每 tick 0.2 格（4 格/秒）
let x = 0.5;
for (let i = 0; i < 12; i++) {
  x += 0.2;
  server('rel_entity_move', { entityId: OTHER_ID, dX: Math.round(0.2 * 32), dY: 0, dZ: 0 });
  await sleep(50);
}
const afterWalk = JSON.parse(JSON.stringify(ac.status()));

// C. 其他玩家加速：每 tick 1 格（20 格/秒）
for (let i = 0; i < 12; i++) {
  server('rel_entity_move', { entityId: OTHER_ID, dX: 32, dY: 0, dZ: 0 });
  await sleep(50);
}
const afterSpeed = JSON.parse(JSON.stringify(ac.status()));

// D. 其他玩家瞬移 15 格（rel_entity_move 是 i8，只有 ±3.97 格，所以用 teleport 包）
const teleportX = x + 12 + 15;
server('entity_teleport', { entityId: OTHER_ID, x: teleportX * 32, y: 64 * 32, z: 0.5 * 32, yaw: 0, pitch: 0 });
await sleep(200);
const afterBlink = JSON.parse(JSON.stringify(ac.status()));

// E. 其他玩家静止后突然横移 2.5 格（预测会把动量算进去，这种突变必须抓）
for (let i = 0; i < 4; i++) {
  server('rel_entity_move', { entityId: OTHER_ID, dX: 0, dY: 0, dZ: 0 });
  await sleep(60);
}
server('rel_entity_move', { entityId: OTHER_ID, dX: 80, dY: 0, dZ: 0 }); // 2.5 格
await sleep(80);
server('rel_entity_move', { entityId: OTHER_ID, dX: 0, dY: 0, dZ: 0 });
await sleep(200);
const afterFly = JSON.parse(JSON.stringify(ac.status()));

const violationsOf = (list) => list.find((e) => e.player === 'Cheater')?.violations ?? {};

console.log('===== A. 本地玩家移动（不该检测）=====');
console.log('  追踪列表:', JSON.stringify(ac.trackedPlayers()));
console.log('  本地玩家有记录:', afterWalk.some((e) => e.player === 'LocalPlayer'));

console.log('===== B. 其他玩家正常走路 =====');
console.log('  违规:', JSON.stringify(violationsOf(afterWalk)));

console.log('===== C. 其他玩家 20 格/秒 =====');
console.log('  违规:', JSON.stringify(violationsOf(afterSpeed)));

console.log('===== D. 其他玩家瞬移 15 格 =====');
console.log('  违规:', JSON.stringify(violationsOf(afterBlink)));

console.log('===== E. 其他玩家静止后瞬间横移 2.5 格 =====');
console.log('  违规:', JSON.stringify(violationsOf(afterFly)));
const sim = ac.sessionChecks(OTHER_ID)?.simulation;
console.log('  Simulation 统计:', JSON.stringify(sim?.debugStats?.()));

console.log('===== 告警样本 =====');
chats.slice(0, 4).forEach((c) => console.log('  ' + c.slice(0, 130)));

const noSelfCheck = !afterWalk.some((e) => e.player === 'LocalPlayer');
const walkClean = Object.keys(violationsOf(afterWalk)).length === 0;
const speedCaught = ['SpeedA', 'BlinkA', 'Simulation'].some((k) => k in violationsOf(afterSpeed));
const blinkCaught = 'BlinkA' in violationsOf(afterBlink);
const physicsCaught = 'Simulation' in violationsOf(afterFly);

console.log('===== 结论 =====');
console.log(`  A 不检测自己: ${noSelfCheck ? 'PASS' : 'FAIL'}`);
console.log(`  B 正常走路不误报: ${walkClean ? 'PASS' : 'FAIL'}`);
console.log(`  C 加速被抓: ${speedCaught ? 'PASS' : 'FAIL'}`);
console.log(`  D 瞬移被抓: ${blinkCaught ? 'PASS' : 'FAIL'}`);
console.log(`  E 物理预测抓到: ${physicsCaught ? 'PASS' : 'FAIL'}`);
const pass = noSelfCheck && walkClean && speedCaught && blinkCaught && physicsCaught;
console.log(`  总体: ${pass ? 'PASS' : 'FAIL'}`);

ac.shutdown();
process.exit(pass ? 0 : 1);
