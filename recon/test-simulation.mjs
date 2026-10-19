// 完整预测反作弊（PredictEngine 移植）的验证：
//  A. 用引擎跑合法轨迹（输入取自枚举集合），逐 tick 预测必须命中真实落点（不自伤）
//  B. 构造一个不可能出现的位移，必须所有候选都够不着（能抓）
import { WorldModel, Vec3 } from '../build/reverse_proxy/anticheat/core.js';
import { CollisionWorld, SimulatedPlayer } from '../build/reverse_proxy/anticheat/simulation/physics.js';
import { predictNextPositions } from '../build/reverse_proxy/anticheat/simulation/PredictEngine.js';

// 平地世界：y <= 63 全是石头
const world = new WorldModel();
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

const downcast = (sim, motion, sneaking = false) => ({
  pos: sim.pos.clone(),
  motion: motion.clone(),
  onGround: sim.onGround,
  yaw: sim.yaw,
  pitch: sim.pitch,
  sprinting: sim.sprinting,
  sneaking,
  usingItem: false,
  speedAmplifier: -1,
  jumpAmplifier: -1,
});

function runCase(label, input, sprinting, ticks = 25) {
  const sim = new SimulatedPlayer(
    collision,
    new Vec3(0.5, 64, 0.5),
    new Vec3(0, 0, 0),
    true,
    30,
    0,
    input,
    { movementSpeed: 0.1, speedAmplifier: -1, jumpAmplifier: -1, sprinting, usingItem: false }
  );

  let worst = 0;
  let misses = 0;
  for (let tick = 0; tick < ticks; tick++) {
    const candidates = predictNextPositions(downcast(sim, sim.motion), collision);
    sim.onUpdate();
    let best = Infinity;
    for (const c of candidates) best = Math.min(best, c.distanceTo(sim.pos));
    worst = Math.max(worst, best);
    if (best > 1.0) misses++;
  }
  console.log(`  ${label.padEnd(28)} 最差偏差=${worst.toFixed(6)}  超阈值=${misses}/${ticks}`);
  return { worst, misses };
}

console.log('===== A. 合法轨迹（不能误报）=====');
const walk = runCase('走路 forward=1 strafe=1', { moveForward: 1, moveStrafe: 1, jump: false, sneak: false }, false);
const sprint = runCase('疾跑 forward=1 strafe=0', { moveForward: 1, moveStrafe: 0, jump: false, sneak: false }, true);
const sneak = runCase('潜行 forward=1 strafe=0', { moveForward: 0.3, moveStrafe: 0, jump: false, sneak: true }, false);
const jump = runCase('疾跑跳 forward=1 jump', { moveForward: 1, moveStrafe: 0, jump: true, sneak: false }, true);

// ---- B. 不可能的位移 ----
const probe = new SimulatedPlayer(
  collision,
  new Vec3(0.5, 64, 0.5),
  new Vec3(0, 0, 0),
  true,
  30,
  0,
  { moveForward: 1, moveStrafe: 0, jump: false, sneak: false },
  { movementSpeed: 0.1, speedAmplifier: -1, jumpAmplifier: -1, sprinting: false, usingItem: false }
);
probe.onUpdate();
const candidates = predictNextPositions(downcast(probe, probe.motion), collision);
const cheated = new Vec3(probe.pos.x + 1.5, probe.pos.y, probe.pos.z);
let bestCheat = Infinity;
for (const c of candidates) bestCheat = Math.min(bestCheat, c.distanceTo(cheated));

console.log('===== B. 不可能位移（必须抓到）=====');
console.log(`  候选数: ${candidates.length}   最近候选偏差: ${bestCheat.toFixed(4)} 格（阈值 1.0）`);

const passA = [walk, sprint, sneak, jump].every((r) => r.misses === 0 && r.worst < 0.02);
const passB = bestCheat > 1.0;
console.log(`===== A: ${passA ? 'PASS' : 'FAIL'}   B: ${passB ? 'PASS' : 'FAIL'} =====`);
process.exit(passA && passB ? 0 : 1);
