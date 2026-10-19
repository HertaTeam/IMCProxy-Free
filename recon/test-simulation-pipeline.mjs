// 完整预测反作弊走完整链路（封包 → manager → Simulation）的验证
//  A. 合法行走轨迹喂进去：不能有任何 Simulation 违规
//  B. 喂一次不可能位移：必须报 Simulation
import { AntiCheatManager } from '../build/reverse_proxy/anticheat/index.js';
import { CollisionWorld, SimulatedPlayer } from '../build/reverse_proxy/anticheat/simulation/physics.js';
import { Vec3 } from '../build/reverse_proxy/anticheat/core.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chats = [];
const ac = new AntiCheatManager({
  enabled: true,
  threshold: 1.0,
  latency: 600,
  vlClearTicks: 0, // 测试期间不清 VL
  alertBuffer: false,
  experimental: false,
  console: false,
  inGameChat: true,
  checks: {
    AutoBlockA: false, AutoClickerA: false, NoSlowA: false, ReachA: false,
    BlinkA: false, FlyA: false, GroundSpoofA: false, GroundSpoofB: false, MotionA: false, NoFallA: false,
    SpeedA: false, SpeedB: false, SpeedC: false,
    ScaffoldA: false, ScaffoldB: false, ScaffoldC: false,
    Simulation: true,
  },
});
ac.setChatSink((p, t) => chats.push(t));
ac.registerPlayer('SimBot');

// 造一块平地（y<=63 石头）
const world = ac.worldModel();
for (let cx = -2; cx <= 2; cx++) {
  for (let cz = -2; cz <= 2; cz++) {
    world.markChunkLoaded(cx, cz);
    for (let x = cx * 16; x < cx * 16 + 16; x++) {
      for (let z = cz * 16; z < cz * 16 + 16; z++) {
        for (let y = 60; y <= 63; y++) world.setBlock(x, y, z, 1, 0);
      }
    }
  }
}
const collision = new CollisionWorld(world);

// 用同一套物理生成"合法"轨迹
const truth = new SimulatedPlayer(
  collision,
  new Vec3(0.5, 64, 0.5),
  new Vec3(0, 0, 0),
  true,
  45,
  0,
  { moveForward: 1, moveStrafe: 0, jump: false, sneak: false },
  { movementSpeed: 0.1, speedAmplifier: -1, jumpAmplifier: -1, sprinting: false, usingItem: false }
);

await sleep(1700); // 过 disableTick 热身

const sendPos = (pos, onGround) =>
  ac.handleClientPacket('SimBot', { x: pos.x, y: pos.y, z: pos.z, onGround, yaw: 45, pitch: 0 }, { name: 'position', state: 'play' });

// 先报一次起始位置
sendPos(truth.pos, true);
await sleep(60);

for (let tick = 0; tick < 20; tick++) {
  truth.onUpdate();
  sendPos(truth.pos, truth.onGround);
  await sleep(50);
}

const legalViolations = { ...(ac.status()[0]?.violations ?? {}) };

// 不可能位移：直接横向瞬移 1.5 格（不触发 3.9 的瞬移忽略阈值）
const cheated = new Vec3(truth.pos.x + 1.5, truth.pos.y, truth.pos.z);
sendPos(cheated, true);
await sleep(60);
sendPos(new Vec3(cheated.x + 0.2, cheated.y, cheated.z), true);
await sleep(250);

const finalViolations = { ...(ac.status()[0]?.violations ?? {}) };

console.log('===== A. 合法轨迹（不能误报）=====');
console.log('  违规:', JSON.stringify(legalViolations));
console.log('===== B. 不可能位移（必须抓到）=====');
console.log('  违规:', JSON.stringify(finalViolations));
console.log('  聊天栏告警:', chats.length);
chats.slice(0, 3).forEach((c) => console.log('    ' + c.slice(0, 120)));

const noFalsePositive = !('Simulation' in legalViolations);
const caught = 'Simulation' in finalViolations;
console.log(`===== A: ${noFalsePositive ? 'PASS' : 'FAIL'}   B: ${caught ? 'PASS' : 'FAIL'} =====`);

ac.shutdown();
process.exit(noFalsePositive && caught ? 0 : 1);
