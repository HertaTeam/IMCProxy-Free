/**
 * TRPlayer / Check / CheckManager —— 与原项目 anticheats 包一一对应的移植。
 *
 * 数据来源：代理双向封包重建出来的"客户端状态"。
 * 与原版的差别只在数据来源，检查公式保持一致。
 */
import { Logger } from "../../logger.js";
import {
  ADVANCED_DEFAULTS,
  Vec3,
  PlayerMove,
  WorldModel,
  EntityTracker,
  type AntiCheatConfig,
  type CheckName,
} from "./core.js";

export type GameType = "survival" | "creative" | "adventure" | "spectator";

/** 客户端上报的状态（由封包更新） */
export interface ClientState {
  pos: Vec3;
  rot: { pitch: number; yaw: number };
  onGround: boolean;
  sprinting: boolean;
  sneaking: boolean;
  usingItem: boolean;
  swing: boolean;
  heldItemId: number;
  heldItemCount: number;
  heldItemIsBlock: boolean;
  /** 服务端下发的最近一次位置（NoFallA 用） */
  serverPos: Vec3;
  inWater: boolean;
  onLadder: boolean;
  hurtTime: number;
  gameType: GameType;
  flying: boolean;
  food: number;
  speedAmplifier: number;
  jumpAmplifier: number;
  ticksSinceSneak: number;
  aboveVoidTicks: number;
  fastTick: number;
}

export function createClientState(): ClientState {
  return {
    pos: new Vec3(0, 0, 0),
    rot: { pitch: 0, yaw: 0 },
    onGround: true,
    sprinting: false,
    sneaking: false,
    usingItem: false,
    swing: false,
    heldItemId: 0,
    heldItemCount: 0,
    heldItemIsBlock: false,
    serverPos: new Vec3(0, 0, 0),
    inWater: false,
    onLadder: false,
    hurtTime: 0,
    gameType: "survival",
    flying: false,
    food: 20,
    speedAmplifier: -1,
    jumpAmplifier: -1,
    ticksSinceSneak: 9999,
    aboveVoidTicks: 0,
    fastTick: 0,
  };
}

export type AlertSink = (player: string, check: string, violations: number, extra: string) => void;

export class Check {
  public violations = 0;
  protected readonly logger = new Logger("AntiCheat");

  constructor(
    public readonly checkName: string,
    public readonly player: TRPlayer
  ) {}

  getAlertBuffer(): number {
    return 10;
  }

  isDisabled(): boolean {
    return false;
  }

  /** 违规计数 + 告警（对应原版 flag()） */
  protected flag(extra = ""): void {
    if (this.player.manager.disableTick > 0) return;
    if (this.isDisabled()) return;
    this.violations++;
    if (this.player.alertBuffer && this.violations % Math.max(1, this.getAlertBuffer()) !== 0) return;
    this.player.alert(this.checkName, this.violations, extra);
  }

  _onTick(): void {}
  _onJump(): void {}
  _onPlaceBlock(): void {}
  _onGameTypeChange(): void {}
  _onTeleport(): void {}
}

/** 每个玩家一个实例：维护 current/last 快照、历史、tick 调度 */
export class TRPlayer {
  public readonly manager: CheckManager;
  public readonly world: WorldModel;
  public readonly entities: EntityTracker;
  public readonly config: AntiCheatConfig;
  public readonly state: ClientState;
  public readonly alertBuffer: boolean;
  private readonly alertSink: AlertSink;
  public readonly name: string;

  public currentPos = new Vec3();
  public currentMotion = new Vec3();
  public currentRot = { pitch: 0, yaw: 0 };
  public currentOnGround = true;
  public currentSprint = false;
  public currentSwing = false;
  public currentUsingItem = false;

  public lastPos = new Vec3();
  public lastMotion = new Vec3();
  public lastRot = { pitch: 0, yaw: 0 };
  public lastOnGround = true;
  public lastOnGround2 = true;
  public lastSprint = false;
  public lastSwing = false;
  public lastUsingItem = false;

  public lastOnGroundPos = new Vec3();
  public lastOnGroundPos2 = new Vec3();
  public lastInLiquidPos = new Vec3();
  public lastOnLiquidGroundPos = new Vec3();

  public posHistory: Vec3[] = [];
  public motionHistory: Vec3[] = [];
  public sprintHistory: boolean[] = [];

  public offGroundTicks = 0;
  public speedMul = 1;
  /** 覆盖 config.threshold（其他玩家的实体包稀疏，阈值要放宽） */
  public thresholdOverride?: number;
  public jumping = false;
  public hasSetback = false;
  public upTime = 0;
  public gameType: GameType = "survival";
  public lastGameType: GameType = "survival";
  public fallDistance = 0;
  public lastFallDistance = 0;
  public ticksExisted = 0;
  public lastSneakTick = 0;
  public aboveVoidTicks = 0;
  public fastTick = 0;
  /** 上 tick 的主手物品数量，用于识别"放方块" */
  private lastHeldCount = 0;
  /** 本 tick 是否已经派发过 place 事件 */
  private placeDispatched = false;

  constructor(name: string, config: AntiCheatConfig, world: WorldModel, entities: EntityTracker, sink: AlertSink) {
    this.name = name;
    this.config = config;
    this.world = world;
    this.entities = entities;
    this.alertSink = sink;
    this.alertBuffer = config.alertBuffer;
    this.state = createClientState();
    this.posHistory = Array.from({ length: 20 }, () => new Vec3());
    this.motionHistory = Array.from({ length: 20 }, () => new Vec3());
    this.sprintHistory = Array.from({ length: 20 }, () => false);
    this.manager = new CheckManager(this);
  }

  alert(check: string, violations: number, extra: string): void {
    this.alertSink(this.name, check, violations, extra);
  }

  /** 封包侧标记：本 tick 有一次方块放置 */
  notifyPlaceBlock(): void {
    if (this.placeDispatched) return;
    this.placeDispatched = true;
    // 放方块是包驱动的，先把"当前视角/挥手"同步成最新值，
    // 否则 ScaffoldA/C 读到的是上一 tick 的旧数据
    this.currentRot = { ...this.state.rot };
    this.currentSwing = this.state.swing;
    this.manager.onPlaceBlock();
  }

  notifyJump(): void {
    this.jumping = true;
  }

  /** 每个 tick 调用一次（50ms），对应原版 TRPlayer.update() */
  tick(): void {
    this.placeDispatched = false;
    const s = this.state;

    this.currentPos = s.pos.clone();
    this.currentRot = { ...s.rot };
    this.currentOnGround = s.onGround;
    this.currentSprint = s.sprinting;
    this.currentUsingItem = s.usingItem;
    this.currentSwing = s.swing;

    // 原版读的是客户端 motionX/Y/Z；代理侧用位置差近似
    this.currentMotion = this.currentPos.subtract(this.lastPos);
    this.fallDistance = this.lastFallDistance + Math.max(0, this.lastPos.y - this.currentPos.y);
    if (this.currentOnGround) {
      this.fallDistance = 0;
      this.offGroundTicks = 0;
    } else {
      this.offGroundTicks++;
    }

    // speedMul：原版 getAIMoveSpeed() * 10，基础 1.0，加速药水 (amp*0.2+1)
    this.speedMul = s.speedAmplifier >= 0 ? s.speedAmplifier * 0.2 + 1 : 1;

    this.pushHistory();
    this.updatePositions();

    this.manager.update();

    this.lastPos = this.currentPos;
    this.lastMotion = this.currentMotion;
    this.lastRot = this.currentRot;
    this.lastSprint = this.currentSprint;
    this.lastSwing = this.currentSwing;
    this.lastOnGround2 = this.lastOnGround;
    this.lastOnGround = this.currentOnGround;
    this.lastUsingItem = this.currentUsingItem;
    this.lastGameType = this.gameType;
    this.lastFallDistance = this.fallDistance;
    this.lastHeldCount = this.state.heldItemCount;
    this.upTime++;
    this.ticksExisted++;
    this.state.ticksSinceSneak++;
    this.state.fastTick++;
    this.tryToClearVL();

    // 原版 EntityUtils.isOnPlaceBlock：主手方块数量 -1
    if (this.state.heldItemIsBlock && this.lastHeldCount > 0 && this.state.heldItemCount === this.lastHeldCount - 1) {
      this.notifyPlaceBlock();
    }
    // 主手为空时的 swing 状态复位由封包处理
    this.state.swing = false;
  }

  private updatePositions(): void {
    if (this.currentOnGround) {
      this.lastOnGroundPos2 = this.lastOnGroundPos;
      this.lastOnGroundPos = this.currentPos;
      this.jumping = false;
      if (this.state.inWater) this.lastOnLiquidGroundPos = this.currentPos;
    }
    if (this.state.inWater) this.lastInLiquidPos = this.currentPos;
    this.gameType = this.state.gameType;
  }

  private pushHistory(): void {
    this.posHistory.pop();
    this.posHistory.unshift(this.currentPos);
    this.motionHistory.pop();
    this.motionHistory.unshift(this.currentMotion);
    this.sprintHistory.pop();
    this.sprintHistory.unshift(this.currentSprint);
  }

  private tryToClearVL(): void {
    const clear = this.config.vlClearTicks;
    if (clear <= 0) return;
    if (this.upTime % clear === 0) this.manager.onCustomAction((check) => (check.violations = 0));
  }

  /** 原版 Utils.getFallDistance 的代理版：用世界模型向下扫 */
  getFallDistanceToGround(): number {
    const d = this.world.getFallDistance(this.currentPos.x, this.currentPos.y, this.currentPos.z);
    return d < 0 ? -1 : d;
  }

  overVoid(): boolean | null {
    return this.world.overVoid(this.state.serverPos.x, this.state.serverPos.y, this.state.serverPos.z);
  }
}

/** 与原项目 CheckManager 对应 */
export class CheckManager {
  public disableTick = 30;
  private preChecks: Check[] = [];
  private normalChecks: Check[] = [];
  private postChecks: Check[] = [];

  constructor(public readonly player: TRPlayer) {}

  registerPre(check: Check): void {
    this.preChecks.push(check);
  }

  register(check: Check): void {
    this.normalChecks.push(check);
  }

  registerPost(check: Check): void {
    this.postChecks.push(check);
  }

  all(): Check[] {
    return [...this.preChecks, ...this.normalChecks, ...this.postChecks];
  }

  update(): void {
    if (this.disableTick > 0) this.disableTick--;

    const p = this.player;
    if (p.gameType !== p.lastGameType) {
      for (const check of this.all()) check._onGameTypeChange();
    }

    // 原版：创造 / 旁观 / 飞行时整体跳过
    if (p.gameType === "creative" || p.gameType === "spectator") return;
    if (p.state.flying) return;

    if (p.lastOnGround && !p.currentOnGround) this.onJump();

    for (const check of this.preChecks) this.run(check);
    for (const check of this.normalChecks) this.run(check);
    for (const check of this.postChecks) this.run(check);
  }

  private run(check: Check): void {
    try {
      check._onTick();
    } catch (err) {
      this.player.alert(check.checkName, check.violations, `check crashed: ${(err as Error).message}`);
    }
  }

  onJump(): void {
    this.player.jumping = true;
    for (const check of this.all()) check._onJump();
  }

  onPlaceBlock(): void {
    for (const check of this.all()) check._onPlaceBlock();
  }

  onCustomAction(action: (check: Check) => void): void {
    for (const check of this.all()) action(check);
  }

  violations(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const check of this.all()) {
      if (check.violations > 0) out[check.checkName] = check.violations;
    }
    return out;
  }
}

/** 供检查使用的常量集合 */
export const AntiCheatConstants = {
  ...ADVANCED_DEFAULTS,
  noMove: PlayerMove.isNoMove,
  invalidMotion: PlayerMove.isInvalidMotion,
  xzSecSpeed: PlayerMove.getXzSecSpeed,
  xzTickSpeed: PlayerMove.getXzTickSpeed,
};

export type { CheckName };
