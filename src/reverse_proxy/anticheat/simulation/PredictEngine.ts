/**
 * PredictEngine 的 TypeScript 移植（原项目 utils/phys/PredictEngine.java）。
 *
 * 原版做法是直接继承 EntityPlayer 然后调用 vanilla 的 onLivingUpdate()；
 * 这里换成 SimulatedPlayer（physics.ts 里复刻的 1.8 物理），
 * 语义保持一致：sync() 同步状态 → 枚举输入 → onUpdate() 推算下一 tick 落点。
 *
 * 关键差异：代理是按"收到移动封包"来算 tick 的，所以状态由 Simulation 检查
 * 从封包快照里传进来，而不是读每 50ms 定时器刷新的 TRPlayer。
 */
import { Vec3 } from "../core.js";
import {
  CollisionWorld,
  SimulatedPlayer,
  buildMovementInputs,
  type MovementInputState,
} from "./physics.js";

/** 一次移动封包对应的预测输入状态 */
export interface PredictionState {
  pos: Vec3;
  /** 本 tick 位移（= 新位置 - 上次位置） */
  motion: Vec3;
  onGround: boolean;
  yaw: number;
  pitch: number;
  sprinting: boolean;
  sneaking: boolean;
  usingItem: boolean;
  speedAmplifier: number;
  jumpAmplifier: number;
}

export class PredictEngine {
  private sim: SimulatedPlayer;
  public unreliable = false;

  constructor(
    private readonly state: PredictionState,
    private readonly world: CollisionWorld
  ) {
    this.sim = this.createSim();
  }

  private createSim(): SimulatedPlayer {
    const s = this.state;
    return new SimulatedPlayer(
      this.world,
      s.pos,
      this.safeMotion(),
      s.onGround,
      s.yaw,
      s.pitch,
      { moveForward: 0, moveStrafe: 0, jump: false, sneak: s.sneaking },
      {
        movementSpeed: 0.1,
        speedAmplifier: s.speedAmplifier,
        jumpAmplifier: s.jumpAmplifier,
        sprinting: s.sprinting,
        usingItem: s.usingItem,
      }
    );
  }

  /** 位置差当速度；瞬移/异常速度直接标记不可信 */
  private safeMotion(): Vec3 {
    const m = this.state.motion;
    if (Math.abs(m.x) >= 3.9 || Math.abs(m.y) >= 3.9 || Math.abs(m.z) >= 3.9) {
      this.unreliable = true;
      return new Vec3();
    }
    return m.clone();
  }

  /** 对应 PredictEngine.sync() */
  sync(): void {
    this.sim = this.createSim();
  }

  setMovementInput(input: MovementInputState): void {
    this.sim.input = { ...input };
  }

  setSprinting(sprinting: boolean): void {
    this.sim.sprinting = sprinting;
  }

  /** 对应 PredictEngine.onUpdate()：推演一个 tick */
  onUpdate(): void {
    this.sim.onUpdate();
  }

  pos(): Vec3 {
    return this.sim.pos.clone();
  }

  isReliable(): boolean {
    return !this.unreliable && this.sim.reliable;
  }

  /** 对应 PredictEngine.clone() */
  clone(): PredictEngine {
    const copy = Object.create(PredictEngine.prototype) as PredictEngine;
    (copy as any).state = this.state;
    (copy as any).world = this.world;
    (copy as any).unreliable = this.unreliable;
    (copy as any).sim = this.sim.clip();
    return copy;
  }
}

/**
 * 一个 tick 的全部预测落点：
 * 3×3 移动方向 × 跳跃 × 潜行（36）× 疾跑 2 种 = 72 个候选位置。
 */
export function predictNextPositions(state: PredictionState, world: CollisionWorld): Vec3[] {
  const engine = new PredictEngine(state, world);
  if (!engine.isReliable()) return [];

  const results: Vec3[] = [];
  for (const input of buildMovementInputs()) {
    for (const sprinting of [true, false]) {
      const clone = engine.clone();
      clone.setMovementInput(input);
      clone.setSprinting(sprinting);
      clone.onUpdate();
      if (clone.isReliable()) results.push(clone.pos());
    }
  }
  return results;
}
