// 预测引擎性能基准：每个移动包 72 次模拟的耗时
import { WorldModel, Vec3 } from '../build/reverse_proxy/anticheat/core.js';
import { CollisionWorld } from '../build/reverse_proxy/anticheat/simulation/physics.js';
import { predictNextPositions } from '../build/reverse_proxy/anticheat/simulation/PredictEngine.js';

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
const state = {
  pos: new Vec3(0.5, 64, 0.5),
  motion: new Vec3(0.2, 0, 0),
  onGround: true,
  yaw: 45,
  pitch: 0,
  sprinting: true,
  sneaking: false,
  usingItem: false,
  speedAmplifier: -1,
  jumpAmplifier: -1,
};

predictNextPositions(state, collision); // 预热

const iterations = 500;
const started = process.hrtime.bigint();
let total = 0;
for (let i = 0; i < iterations; i++) total += predictNextPositions(state, collision).length;
const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

console.log(`迭代: ${iterations}  候选/次: ${total / iterations}`);
console.log(`总耗时: ${elapsedMs.toFixed(1)}ms`);
console.log(`单次: ${(elapsedMs / iterations).toFixed(3)}ms`);
console.log(`20 tick/s 单玩家占用: ${((elapsedMs / iterations) * 20).toFixed(2)}ms/s`);
process.exit(elapsedMs / iterations < 5 ? 0 : 1);
