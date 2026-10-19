/**
 * 全部检查的实现，逐条对照原项目 checks/ 目录。
 *
 * 与原版的差异（都是数据来源导致，公式未改）：
 *  - 客户端 motion 用位置差近似（原版直接读 entity.motionX/Y/Z）
 *  - isSilent() 用潜行近似（1.8 没有 silent 状态）
 *  - AutoClickerA 修正了原版恒真/恒假的 CPS 公式，改为 15000/窗口
 *  - 需要世界方块的检查使用代理重建的区块表，未知位置直接跳过（不误报）
 */
import { Check, type TRPlayer } from "./engine.js";
import {
  ADVANCED_DEFAULTS,
  BlockUtils,
  PlayerMove,
  Vec3,
  type AntiCheatConfig,
  type CheckGates,
} from "./core.js";
import { CollisionWorld } from "./simulation/physics.js";
import { predictNextPositions } from "./simulation/PredictEngine.js";

const A = ADVANCED_DEFAULTS;

/* ------------------------------------------------------------ 移动检查 */

export class BlinkA extends Check {
  constructor(player: TRPlayer, private gates: CheckGates, private toggles: Record<string, boolean>) {
    super("BlinkA", player);
  }
  getAlertBuffer(): number {
    return A.blinkAlertBuffer;
  }
  isDisabled(): boolean {
    return !this.gates.movement || !this.toggles.BlinkA;
  }
  _onTick(): void {
    const p = this.player;
    if (p.lastPos === null || p.hasSetback) return;
    const allowed = A.blinkMaxDistance * p.speedMul + p.fallDistance + p.config.threshold;
    if (p.lastPos.distanceTo(p.currentPos) > allowed) this.flag();
  }
}

export class FlyA extends Check {
  constructor(player: TRPlayer, private gates: CheckGates, private toggles: Record<string, boolean>) {
    super("FlyA", player);
  }
  getAlertBuffer(): number {
    return A.flyAAlertBuffer;
  }
  isDisabled(): boolean {
    return !this.gates.movement || !this.toggles.FlyA;
  }
  _onTick(): void {
    const p = this.player;
    if (PlayerMove.isInvalidMotion(p.currentMotion)) return;
    if (PlayerMove.isNoMove(p.currentMotion) || p.currentOnGround) return;
    if (p.lastMotion.y === 0 && p.currentMotion.y === 0) {
      this.flag(`Invalid Y-motion: ${p.currentMotion.y.toFixed(2)}  onGround=${p.currentOnGround}`);
    }
  }
}

export class SpeedA extends Check {
  private hasJumped = false;
  private jumpTick = 0;
  constructor(player: TRPlayer, private gates: CheckGates, private toggles: Record<string, boolean>) {
    super("SpeedA", player);
  }
  getAlertBuffer(): number {
    return A.speedAAlertBuffer;
  }
  isDisabled(): boolean {
    return !this.gates.movement || !this.toggles.SpeedA;
  }
  _onJump(): void {
    this.hasJumped = true;
  }
  _onTick(): void {
    const p = this.player;
    if (this.hasJumped && !p.jumping) {
      this.hasJumped = false;
      this.jumpTick = A.speedAAfterJumpJumpTick;
      return;
    }
    if (this.jumpTick > 0) this.jumpTick--;

    if (p.lastPos === null || p.hasSetback || !p.currentOnGround || !p.lastOnGround || p.state.inWater) return;

    let maxSecSpeed: number;
    if (this.jumpTick > 0) maxSecSpeed = A.speedAAfterJumpSpeed;
    else if (p.currentSprint) maxSecSpeed = A.speedASprintingSpeed;
    else if (p.state.sneaking) maxSecSpeed = A.speedASilentSpeed;
    else maxSecSpeed = A.speedAWalkSpeed;

    const speed = PlayerMove.getXzSecSpeed(p.lastPos, p.currentPos);
    const possible = maxSecSpeed * p.speedMul + p.config.threshold;
    if (speed > possible) this.flag(`Current: ${speed.toFixed(2)}  Max: ${possible.toFixed(2)}`);
  }
}

export class SpeedB extends Check {
  constructor(player: TRPlayer, private gates: CheckGates, private toggles: Record<string, boolean>) {
    super("SpeedB", player);
  }
  getAlertBuffer(): number {
    return A.speedBAlertBuffer;
  }
  isDisabled(): boolean {
    return !this.gates.movement || !this.toggles.SpeedB;
  }
  _onTick(): void {
    const p = this.player;
    if (p.currentSprint && p.state.food <= 6) this.flag(`sprinting with food=${p.state.food}`);
  }
}

export class SpeedC extends Check {
  constructor(player: TRPlayer, private gates: CheckGates, private toggles: Record<string, boolean>) {
    super("SpeedC", player);
  }
  getAlertBuffer(): number {
    return A.speedCAlertBuffer;
  }
  isDisabled(): boolean {
    return !this.gates.movement || !this.toggles.SpeedC;
  }
  _onTick(): void {
    const p = this.player;
    if (!p.currentSprint) return;
    const index = Math.min(Math.floor(p.config.latency / 50) + 1, 19);
    const speed = PlayerMove.getXzTickSpeed(p.posHistory[index] ?? p.currentPos, p.currentPos);
    if (speed === 0) {
      this.flag(`MotionX:${p.currentMotion.x.toFixed(2)} MotionZ:${p.currentMotion.z.toFixed(2)}`);
    }
  }
}

export class NoFallA extends Check {
  constructor(player: TRPlayer, private gates: CheckGates, private toggles: Record<string, boolean>) {
    super("NoFallA", player);
  }
  getAlertBuffer(): number {
    return A.noFallAAlertBuffer;
  }
  isDisabled(): boolean {
    return !this.gates.movement || !this.toggles.NoFallA;
  }
  _onTick(): void {
    const p = this.player;
    if (p.state.flying) return;
    const deltaX = Math.abs(p.state.serverPos.x - p.lastPos.x);
    const deltaY = p.lastPos.y - p.state.serverPos.y;
    const deltaZ = Math.abs(p.state.serverPos.z - p.lastPos.z);
    if (!(deltaY >= 5 && deltaX <= 10 && deltaZ <= 10 && deltaY <= 40)) return;

    const overVoid = p.overVoid();
    if (overVoid === null) return; // 世界数据不足，跳过
    if (overVoid) return;
    const fall = p.getFallDistanceToGround();
    if (fall > 3) this.flag(`fallDistance=${fall.toFixed(2)}`);
  }
}

export class GroundSpoofA extends Check {
  constructor(player: TRPlayer, private gates: CheckGates, private toggles: Record<string, boolean>) {
    super("GroundSpoofA", player);
  }
  getAlertBuffer(): number {
    return A.groundSpoofAAlertBuffer;
  }
  isDisabled(): boolean {
    return !this.gates.movement || !this.toggles.GroundSpoofA;
  }
  static checkBlocks(p: TRPlayer, groundY: number): boolean | null {
    const x = p.currentPos.x;
    const z = p.currentPos.z;
    const center = p.world.isAirAt(x, groundY, z);
    const below = p.world.isAirAt(x, groundY - 1, z);
    if (center === null || below === null) return null;
    if (!center || !below) return false;

    const dx = Math.floor(x);
    const dz = Math.floor(z);
    const neighbors: Array<[number, number]> = [
      [dx + 1, dz],
      [dx + 1, dz - 1],
      [dx - 1, dz],
      [dx - 1, dz + 1],
      [dx, dz - 1],
      [dx - 1, dz - 1],
      [dx, dz + 1],
      [dx + 1, dz + 1],
    ];
    let count = 0;
    for (const [nx, nz] of neighbors) {
      const air = p.world.isAirAt(nx, groundY, nz);
      if (air === null) return null;
      if (air) count++;
    }
    return count >= 8;
  }
  _onTick(): void {
    const p = this.player;
    if (!(p.lastOnGround2 && p.lastOnGround && p.currentOnGround)) return;
    const groundY = Math.floor(p.currentPos.y) - 1;
    const result = GroundSpoofA.checkBlocks(p, groundY);
    if (result === null) return;
    if (result) {
      this.flag("spoof onGround=true");
      p.currentOnGround = false;
    }
  }
}

export class GroundSpoofB extends Check {
  constructor(player: TRPlayer, private gates: CheckGates, private toggles: Record<string, boolean>) {
    super("GroundSpoofB", player);
  }
  getAlertBuffer(): number {
    return A.groundSpoofBAlertBuffer;
  }
  isDisabled(): boolean {
    return !this.gates.movement || !this.toggles.GroundSpoofB;
  }
  static checkBlocks(p: TRPlayer, groundY: number): boolean | null {
    const x = p.currentPos.x;
    const z = p.currentPos.z;
    const center = p.world.getBlock(x, groundY, z);
    if (center === null) return null;
    if (!BlockUtils.isFullBlock(center)) return false;

    const dx = Math.floor(x);
    const dz = Math.floor(z);
    const neighbors: Array<[number, number]> = [
      [dx + 1, dz],
      [dx + 1, dz - 1],
      [dx - 1, dz],
      [dx - 1, dz + 1],
      [dx, dz - 1],
      [dx - 1, dz - 1],
      [dx, dz + 1],
      [dx + 1, dz + 1],
    ];
    let count = 0;
    for (const [nx, nz] of neighbors) {
      const block = p.world.getBlock(nx, groundY, nz);
      if (block === null) return null;
      if (BlockUtils.isFullBlock(block)) count++;
    }
    return count >= 8;
  }
  _onTick(): void {
    const p = this.player;
    if (p.currentOnGround) return;
    if (Math.floor(p.currentPos.y) !== p.currentPos.y) return;
    const result = GroundSpoofB.checkBlocks(p, Math.floor(p.currentPos.y) - 1);
    if (result === null) return;
    if (result) {
      this.flag("spoof onGround=false");
      p.currentOnGround = true;
    }
  }
}

const JUMP_MOTIONS = [
  0.41159999516010254, -0.08506399504327788, -0.08336271676487925, -0.0816954640195993, -0.08006155629742463,
  -0.07846032669852913, -0.07689112166107052, -0.07535330069443089, -0.07384623611779237, -0.07236931280394177,
  -0.07092192792819801,
];
const JUMP_MOTIONS_1 = [
  0.5095999912261959, -0.08702399309539816, -0.08528351489334113, -0.08357784622212827, -0.0819062908918066,
  -0.08026816663620898, -0.07866280483447859, -0.07708955023816295, -0.07554776070376615, -0.07403680693065001,
  -0.07255607220417704, -0.07110495214399076, -0.0696828544573303,
];
const JUMP_MOTIONS_2 = [
  0.6076000164985658, -0.0889839917316434, -0.08720431359424546, -0.08546022898565087, -0.08375102603596235,
  -0.08207600711266715, -0.0804344885358894, -0.07882580029933772, -0.07724928579683382, -0.07570430155431032,
  -0.0741902169671691, -0.0727064140428918, -0.07125228714879878, -0.06982724276485225, -0.06843069924140427,
];

/** 原版 bed / slime_block 的方块 id */
const IGNORED_BLOCK_IDS = new Set([26, 165]);

export class MotionA extends Check {
  private readyToJump = false;
  private disableTicks = 0;
  constructor(player: TRPlayer, private gates: CheckGates, private toggles: Record<string, boolean>) {
    super("MotionA", player);
  }
  getAlertBuffer(): number {
    return A.motionAAlertBuffer;
  }
  isDisabled(): boolean {
    return !this.gates.movement || !this.toggles.MotionA || !this.gates.experimental;
  }
  private possibleMotions(): number[] | null {
    const amp = this.player.state.jumpAmplifier;
    if (amp === -1) return JUMP_MOTIONS;
    if (amp === 0) return JUMP_MOTIONS_1;
    if (amp === 1) return JUMP_MOTIONS_2;
    return null;
  }
  private eligible(): boolean {
    const p = this.player;
    if (PlayerMove.isInvalidMotion(p.currentMotion)) return false;
    if (p.state.inWater || p.state.onLadder || p.state.hurtTime > 0) return false;
    const standing = p.world.getBlock(p.currentPos.x, p.currentPos.y, p.currentPos.z);
    if (!BlockUtils.isFullBlock(standing)) return false;
    if (standing && IGNORED_BLOCK_IDS.has(standing.id)) return false;
    return true;
  }
  _onTick(): void {
    if (this.disableTicks > 0) {
      this.disableTicks--;
      this.readyToJump = false;
      return;
    }
    if (!this.eligible()) {
      this.readyToJump = false;
      return;
    }
    if (this.player.currentOnGround && !this.readyToJump) this.readyToJump = true;
    if (!this.readyToJump) return;

    const tick = this.player.offGroundTicks - 1;
    if (tick < 0) return;
    const motions = this.possibleMotions();
    if (!motions) {
      this.readyToJump = false;
      return;
    }
    const should = motions[tick];
    if (should === undefined) {
      this.readyToJump = false;
      return;
    }
    const current = this.player.currentMotion.y;
    if (Math.abs(current - should) > 0.01) {
      this.flag(`Invalid jump motion at tick ${tick}. should: ${should.toFixed(2)}  current: ${current.toFixed(2)}`);
    }
  }
}

/* ------------------------------------------------------------ 战斗检查 */

export class AutoBlockA extends Check {
  private needToCheck = false;
  constructor(player: TRPlayer, private gates: CheckGates, private toggles: Record<string, boolean>) {
    super("AutoBlockA", player);
  }
  getAlertBuffer(): number {
    return A.autoBlockAAlertBuffer;
  }
  isDisabled(): boolean {
    return !this.gates.combat || !this.toggles.AutoBlockA;
  }
  /** 服务端动画封包：自己挥手且视线内有落点 → 需要检查 */
  onSelfAnimation(): void {
    this.needToCheck = true;
  }
  /** 服务端实体移动封包：自己在格挡还命中 → 不可能命中 */
  onSelfEntityMove(): void {
    const p = this.player;
    const blocking = p.state.usingItem && p.state.heldItemId !== 0;
    if (this.needToCheck && blocking) this.flag("Impossible hit.");
  }
}

export class AutoClickerA extends Check {
  private clicks: number[] = [];
  constructor(player: TRPlayer, private gates: CheckGates, private toggles: Record<string, boolean>) {
    super("AutoClickerA", player);
  }
  getAlertBuffer(): number {
    return 2;
  }
  isDisabled(): boolean {
    return !this.gates.combat || !this.toggles.AutoClickerA;
  }
  onSelfAnimation(): void {
    const now = Date.now();
    this.clicks.push(now);
    if (this.clicks.length > 15) this.clicks.shift();
    if (this.clicks.length === 15) {
      const elapsed = now - this.clicks[0];
      if (elapsed > 0) {
        const cps = 15000 / elapsed;
        if (cps >= 15) {
          this.flag(`High cps: ${cps.toFixed(1)}`);
          this.clicks = [];
        }
      }
    }
  }
}

export class NoSlowA extends Check {
  private static readonly SLOW_SPEED = [2.56, 1.92, 1.6, 1.4, 1.36, 1.26, 1.18, 1.16];
  private itemUseTick = 0;
  private disableTick = 0;
  constructor(player: TRPlayer, private gates: CheckGates, private toggles: Record<string, boolean>) {
    super("NoSlowA", player);
  }
  getAlertBuffer(): number {
    return A.noSlowAAlertBuffer;
  }
  isDisabled(): boolean {
    return !this.gates.combat || !this.toggles.NoSlowA;
  }
  _onTick(): void {
    const p = this.player;
    if (!p.currentUsingItem || !p.lastUsingItem) {
      this.itemUseTick = 0;
      return;
    }
    if (p.jumping) {
      this.disableTick = A.noSlowAInJumpDisableTick;
      return;
    }
    if (this.disableTick > 0) {
      this.disableTick--;
      return;
    }
    const secSpeed = PlayerMove.getXzSecSpeed(p.lastPos, p.currentPos);
    const max = NoSlowA.SLOW_SPEED[this.itemUseTick] ?? NoSlowA.SLOW_SPEED[NoSlowA.SLOW_SPEED.length - 1];
    const possible = max * p.speedMul + p.config.threshold;
    if (secSpeed > possible) this.flag(`Current: ${secSpeed.toFixed(2)}  Max: ${possible.toFixed(2)}`);
    if (this.itemUseTick < NoSlowA.SLOW_SPEED.length - 1) this.itemUseTick++;
  }
}

export class ReachA extends Check {
  constructor(player: TRPlayer, private gates: CheckGates, private toggles: Record<string, boolean>) {
    super("*ReachA*", player);
  }
  getAlertBuffer(): number {
    return A.reachAAlertBuffer;
  }
  isDisabled(): boolean {
    return !this.gates.combat || !this.toggles.ReachA || !this.gates.experimental;
  }
  /** 挥手的上升沿 → 延迟 reachACheckDelay*50ms 再判定（与原版一致） */
  onSwingStart(): void {
    if (this.isDisabled()) return;
    setTimeout(() => {
      const p = this.player;
      const nearest = p.entities.nearestLiving(p.currentPos, null, 6);
      if (!nearest) return;
      if (nearest.entity.hurtTime < 10 - A.reachACheckDelay) return;
      if (nearest.distance < 6 && nearest.distance > A.reachADefaultReach) {
        this.flag(`target: ${nearest.entity.name}  distance: ${nearest.distance.toFixed(2)}`);
      }
    }, A.reachACheckDelay * 50);
  }
}

/* ------------------------------------------------------------ 搭桥检查 */

export class ScaffoldA extends Check {
  constructor(player: TRPlayer, private gates: CheckGates, private toggles: Record<string, boolean>) {
    super("*ScaffoldA*", player);
  }
  getAlertBuffer(): number {
    return A.scaffoldAAlertBuffer;
  }
  isDisabled(): boolean {
    return !this.gates.scaffolding || !this.toggles.ScaffoldA || !this.gates.experimental;
  }
  _onPlaceBlock(): void {
    if (!this.player.currentSwing) this.flag("no valid swing.");
  }
}

export class ScaffoldB extends Check {
  constructor(player: TRPlayer, private gates: CheckGates, private toggles: Record<string, boolean>) {
    super("ScaffoldB", player);
  }
  getAlertBuffer(): number {
    return A.scaffoldBAlertBuffer;
  }
  isDisabled(): boolean {
    return !this.gates.scaffolding || !this.toggles.ScaffoldB;
  }
  _onTick(): void {
    const p = this.player;
    if (!p.currentSwing) return;
    if (!(p.currentRot.pitch >= 70)) return;
    if (!(p.state.heldItemIsBlock && p.state.heldItemId !== 0)) return;
    if (!(p.state.fastTick >= 20)) return;
    if (!(p.state.ticksSinceSneak >= 30)) return;
    if (!(p.state.aboveVoidTicks >= 20)) return;

    const baseY = Math.floor(p.currentPos.y) - 2;
    let overAir = true;
    for (let i = 0; i < 4; i++) {
      const air = p.world.isAirAt(p.currentPos.x, baseY - i, p.currentPos.z);
      if (air === null) return; // 世界数据不足
      if (!air) {
        overAir = false;
        break;
      }
    }
    if (overAir) this.flag();
  }
}

export class ScaffoldC extends Check {
  constructor(player: TRPlayer, private gates: CheckGates, private toggles: Record<string, boolean>) {
    super("ScaffoldC", player);
  }
  getAlertBuffer(): number {
    return 2;
  }
  isDisabled(): boolean {
    return !this.gates.scaffolding || !this.toggles.ScaffoldC;
  }
  _onPlaceBlock(): void {
    if (this.player.currentRot.pitch === 85.0) this.flag("Backwards rotation.");
  }
}

/* ------------------------------------------------------------ 预测检查 */

/**
 * Simulation：完整预测反作弊（移植 PredictEngine）。
 *
 * 每来一个移动封包 = 客户端一个 tick：
 *   1) 先用上一 tick 生成的 72 个候选落点比对新位置，全都够不着才判定异常
 *   2) 再用本次位移为新状态生成下一批候选
 * 瞬移、世界数据缺失、速度异常时整轮跳过，避免误报。
 */
export class Simulation extends Check {
  private readonly collision: CollisionWorld;
  private pending: Vec3[] = [];
  private lastPos: Vec3 | null = null;
  private skipped = 0;

  constructor(player: TRPlayer, private gates: CheckGates, private toggles: Record<string, boolean>) {
    super("Simulation", player);
    this.collision = new CollisionWorld(player.world);
  }

  getAlertBuffer(): number {
    return A.simulationAlertBuffer;
  }

  isDisabled(): boolean {
    return !this.gates.simulation || !this.toggles.Simulation;
  }

  /** 由 AntiCheatManager 在每个移动封包上调用 */
  onMovePacket(pos: Vec3, onGround: boolean, yaw: number, pitch: number): void {
    if (this.isDisabled() || this.player.manager.disableTick > 0) {
      this.lastPos = pos;
      this.pending = [];
      return;
    }

    const previous = this.lastPos;
    this.lastPos = pos.clone();
    if (!previous) return;

    const motion = pos.subtract(previous);
    // 瞬移 / 传送 / 掉线重连：整轮重置
    if (Math.abs(motion.x) >= 3.9 || Math.abs(motion.y) >= 3.9 || Math.abs(motion.z) >= 3.9) {
      this.pending = [];
      this.skipped++;
      return;
    }
    if (!this.player.world.isChunkLoadedAt(pos.x, pos.z)) {
      this.pending = [];
      this.skipped++;
      return;
    }
    if (this.unsafeEnvironment(pos, motion, onGround)) {
      this.pending = [];
      this.skipped++;
      return;
    }

    // 1) 结算上一批预测
    if (this.pending.length > 0) {
      let best = Number.POSITIVE_INFINITY;
      for (const candidate of this.pending) {
        const d = candidate.distanceTo(pos);
        if (d < best) best = d;
      }
      if (best > this.player.config.threshold) {
        this.flag(`offset ${best.toFixed(4)} blocks (${this.pending.length} candidates, none matched)`);
      }
    }

    // 2) 为下一 tick 生成候选
    const state = this.player.state;
    this.pending = predictNextPositions(
      {
        pos,
        motion,
        onGround,
        yaw,
        pitch,
        sprinting: state.sprinting,
        sneaking: state.sneaking,
        usingItem: state.usingItem,
        speedAmplifier: state.speedAmplifier,
        jumpAmplifier: state.jumpAmplifier,
      },
      this.collision
    );
  }

  /** 调试用：被跳过（无世界数据/瞬移）的移动包数 */
  skippedMoves(): number {
    return this.skipped;
  }

  /**
   * 预测引擎只模拟"标准方块地面"上的移动。
   * 遇到水/岩浆/梯子/台阶楼梯等非整方块、以及明显不是跳跃能产生的上升位移
   * （击退、爆炸、载具、传送门），直接跳过这一 tick，避免误报。
   */
  private unsafeEnvironment(pos: Vec3, motion: Vec3, onGround: boolean): boolean {
    const world = this.player.world;
    const fx = Math.floor(pos.x);
    const fy = Math.floor(pos.y);
    const fz = Math.floor(pos.z);

    const feet = world.getBlock(fx, fy, fz);
    const head = world.getBlock(fx, fy + 1, fz);
    const below = world.getBlock(fx, fy - 1, fz);

    const liquidOrLadder = (block: { id: number } | null): boolean =>
      block !== null && (block.id === 8 || block.id === 9 || block.id === 10 || block.id === 11 || block.id === 65);

    if (liquidOrLadder(feet) || liquidOrLadder(head)) return true;

    // 脚下的方块不是整方块（台阶/楼梯/栅栏/告示牌…）→ 碰撞形状无法精确复刻
    if (below && below.id !== 0 && !BlockUtils.isFullBlock(below)) return true;

    // 站立方块本身也不是整方块
    if (feet && feet.id !== 0 && !BlockUtils.isFullBlock(feet)) return true;

    // 非跳跃能产生的上升速度（击退 / 爆炸 / 载具）
    if (!onGround && motion.y > 0.55) return true;

    return false;
  }

  _onTick(): void {
    // 预测是包驱动的，不走定时 tick
  }
}

/** 创建全部检查并注册到 manager（顺序与原版 CheckManager.create 一致） */
export function registerAllChecks(
  player: TRPlayer,
  gates: CheckGates,
  toggles: Record<string, boolean>
): {
  checks: Check[];
  autoBlock: AutoBlockA;
  autoClicker: AutoClickerA;
  reach: ReachA;
  simulation: Simulation;
} {
  const autoBlock = new AutoBlockA(player, gates, toggles);
  const autoClicker = new AutoClickerA(player, gates, toggles);
  const reach = new ReachA(player, gates, toggles);
  const simulation = new Simulation(player, gates, toggles);

  const pre: Check[] = [
    new GroundSpoofA(player, gates, toggles),
    new GroundSpoofB(player, gates, toggles),
  ];
  const normal: Check[] = [
    new FlyA(player, gates, toggles),
    new BlinkA(player, gates, toggles),
    new SpeedA(player, gates, toggles),
    new SpeedB(player, gates, toggles),
    new NoSlowA(player, gates, toggles),
    autoBlock,
    new MotionA(player, gates, toggles),
    reach,
    new ScaffoldA(player, gates, toggles),
    new ScaffoldB(player, gates, toggles),
    new ScaffoldC(player, gates, toggles),
    new NoFallA(player, gates, toggles),
    autoClicker,
  ];
  const post: Check[] = [simulation];

  for (const c of pre) player.manager.registerPre(c);
  for (const c of normal) player.manager.register(c);
  for (const c of post) player.manager.registerPost(c);

  return { checks: [...pre, ...normal, ...post], autoBlock, autoClicker, reach, simulation };
}

export type { AntiCheatConfig };
