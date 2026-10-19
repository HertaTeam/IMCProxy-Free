/**
 * 反作弊基础设施：向量、世界模型、实体追踪、配置。
 *
 * 移植自 ravenxd 的 keystrokesmod/anticheats（作者 xia__mc，参考 Nova-Committee/CheatDetector）。
 * 与原版的区别：这里的"客户端"是经过代理的真实 MC 1.8.9 客户端，
 * 所有状态都从双向封包里重建，因此部分检查是近似实现（依赖区块/实体的检查会跳过未知方块）。
 */

/* ------------------------------------------------------------------ 向量 */

export class Vec3 {
  constructor(
    public x: number = 0,
    public y: number = 0,
    public z: number = 0
  ) {}

  clone(): Vec3 {
    return new Vec3(this.x, this.y, this.z);
  }

  add(o: Vec3): Vec3 {
    return new Vec3(this.x + o.x, this.y + o.y, this.z + o.z);
  }

  subtract(o: Vec3): Vec3 {
    return new Vec3(this.x - o.x, this.y - o.y, this.z - o.z);
  }

  distanceTo(o: Vec3): number {
    return Math.hypot(this.x - o.x, this.y - o.y, this.z - o.z);
  }

  /** 只算水平距离（原版 PlayerMove.getXzTickSpeed） */
  xzDistanceTo(o: Vec3): number {
    return Math.hypot(this.x - o.x, this.z - o.z);
  }

  equals(o: Vec3): boolean {
    return this.x === o.x && this.y === o.y && this.z === o.z;
  }

  toString(): string {
    return `${this.x.toFixed(2)},${this.y.toFixed(2)},${this.z.toFixed(2)}`;
  }
}

/** 原版 PlayerMove 的工具函数 */
export const PlayerMove = {
  isNoMove(motion: Vec3): boolean {
    return motion.x === 0 && motion.z === 0;
  },
  isInvalidMotion(motion: Vec3): boolean {
    return Math.abs(motion.x) >= 3.9 || Math.abs(motion.y) >= 3.9 || Math.abs(motion.z) >= 3.9;
  },
  getXzTickSpeed(last: Vec3, current: Vec3): number {
    return last.xzDistanceTo(current);
  },
  getXzSecSpeed(last: Vec3, current: Vec3): number {
    return this.getXzTickSpeed(last, current) * 20;
  },
  predictedMotion(motion: number, ticks: number): number {
    let predicted = motion;
    for (let i = 0; i < ticks; i++) predicted = (predicted - 0.08) * 0.98;
    return predicted;
  },
};

/* ------------------------------------------------------------------ 方块 */

export interface BlockState {
  id: number;
  meta: number;
}

/** 常见"不是完整方块"的方块 id（用于 BlockUtils.isFullBlock 的近似判断） */
const NON_FULL_BLOCKS = new Set<number>([
  0, 6, 8, 9, 10, 11, 26, 27, 28, 30, 31, 32, 37, 38, 39, 40, 50, 51, 55, 59, 63, 64, 65, 66, 68, 69, 70, 71, 72,
  75, 76, 77, 78, 83, 84, 85, 90, 92, 93, 94, 96, 101, 102, 104, 105, 106, 107, 111, 113, 115, 116, 117, 118, 119,
  120, 127, 131, 132, 138, 139, 140, 141, 142, 143, 144, 145, 146, 147, 148, 149, 150, 151, 152, 154, 157, 158, 160,
  161, 162, 163, 164, 165, 166, 167, 168, 169, 170, 171, 175, 176, 177, 178, 181, 182, 183, 184, 185, 186, 187, 188,
  189, 190, 191, 192, 193, 194, 195, 196, 197, 198, 199, 200, 201, 202, 203, 204, 205, 206, 207, 208, 209,
]);

export const BlockUtils = {
  isAir(block: BlockState | null): boolean {
    return block !== null && block.id === 0;
  },
  isFullBlock(block: BlockState | null): boolean {
    if (!block) return false;
    return block.id !== 0 && !NON_FULL_BLOCKS.has(block.id);
  },
};

/**
 * 世界模型：从 1.8 的区块 / 方块变更封包重建一个粗糙的方块表。
 * 没收到过的位置返回 null（未知），调用方必须把它当成"不确定"而不是空气。
 */
export class WorldModel {
  /** key = `x,y,z` */
  private blocks = new Map<string, BlockState>();
  private loadedChunks = new Set<string>();
  private dimension = 0;

  reset(): void {
    this.blocks.clear();
    this.loadedChunks.clear();
  }

  setDimension(dimension: number): void {
    this.dimension = dimension;
  }

  getDimension(): number {
    return this.dimension;
  }

  private key(x: number, y: number, z: number): string {
    return `${x},${y},${z}`;
  }

  private chunkKey(cx: number, cz: number): string {
    return `${cx},${cz}`;
  }

  hasChunk(cx: number, cz: number): boolean {
    return this.loadedChunks.has(this.chunkKey(cx, cz));
  }

  /** 手动标记区块已加载（测试 / 上游未发区块数据但确认存在时用） */
  markChunkLoaded(cx: number, cz: number): void {
    this.loadedChunks.add(this.chunkKey(cx, cz));
  }

  isChunkLoadedAt(x: number, z: number): boolean {
    return this.hasChunk(Math.floor(x / 16), Math.floor(z / 16));
  }

  getBlock(x: number, y: number, z: number): BlockState | null {
    if (y < 0 || y > 255) return null;
    return this.blocks.get(this.key(Math.floor(x), Math.floor(y), Math.floor(z))) ?? null;
  }

  /** 未知方块返回 null；确认是空气返回 true */
  isAirAt(x: number, y: number, z: number): boolean | null {
    const block = this.getBlock(x, y, z);
    if (!block) return this.isChunkLoadedAt(x, z) ? true : null;
    return block.id === 0;
  }

  setBlock(x: number, y: number, z: number, id: number, meta: number): void {
    if (y < 0 || y > 255) return;
    this.blocks.set(this.key(x, y, z), { id, meta });
  }

  /** 1.8 区块数据包：每个 section = short blockCount + 8192B 方块 + 2048B 天光 + 2048B 方块光 */
  loadChunkData(cx: number, cz: number, chunkData: Buffer, bitMap: number[] | null, skyLightSent: boolean): void {
    if (!Buffer.isBuffer(chunkData) || chunkData.length === 0) return;
    const sections: number[] = [];
    if (Array.isArray(bitMap)) {
      for (const b of bitMap) sections.push(b);
    } else {
      colorsOf(chunkData.length).forEach((m) => sections.push(m));
    }

    let offset = 0;
    for (const sectionY of sections) {
      if (offset + 2 > chunkData.length) break;
      offset += 2; // blockCount
      const blocksLen = 8192;
      if (offset + blocksLen > chunkData.length) break;
      for (let i = 0; i < 4096; i++) {
        const value = chunkData.readUInt16LE(offset + i * 2);
        const id = value >> 4;
        const meta = value & 0x0f;
        if (id === 0) continue;
        const localX = i & 0x0f;
        const localZ = (i >> 4) & 0x0f;
        const localY = i >> 8;
        this.setBlock(cx * 16 + localX, sectionY * 16 + localY, cz * 16 + localZ, id, meta);
      }
      offset += blocksLen;
      offset += 2048; // block light
      if (skyLightSent) offset += 2048;
    }
    this.loadedChunks.add(this.chunkKey(cx, cz));
  }

  /** 扫描从 y 向下的第一个非空气方块，返回落差；找不到返回 -1（原版 getFallDistance） */
  getFallDistance(x: number, y: number, z: number): number {
    const start = Math.floor(y);
    for (let i = start; i >= 0; i--) {
      const air = this.isAirAt(x, i, z);
      if (air === null) return -1; // 未知就放弃，避免误判
      if (!air) return y - i;
    }
    return -1;
  }

  /** 从 y 向下扫到 0 全是空气 → 判断为"在虚空上方" */
  overVoid(x: number, y: number, z: number): boolean | null {
    for (let i = Math.floor(y); i >= 0; i--) {
      const air = this.isAirAt(x, i, z);
      if (air === null) return null;
      if (!air) return false;
    }
    return true;
  }
}

/** 从区块长度反推有哪些 section（bitMap 缺失时的兜底） */
function colorsOf(length: number): number[] {
  const perSection = 2 + 8192 + 2048 + 2048;
  const count = Math.floor(length / perSection);
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(i);
  return out;
}

/* ---------------------------------------------------------------- 实体 */

export interface TrackedEntity {
  id: number;
  uuid: string;
  name: string;
  type: string;
  pos: Vec3;
  yaw: number;
  pitch: number;
  hurtTime: number;
  isLiving: boolean;
}

/** 追踪服务端下发的实体（ReachA / 目标距离用） */
export class EntityTracker {
  private entities = new Map<number, TrackedEntity>();

  clear(): void {
    this.entities.clear();
  }

  remove(id: number): void {
    this.entities.delete(id);
  }

  upsert(id: number, patch: Partial<TrackedEntity>): void {
    const existing = this.entities.get(id);
    if (existing) {
      Object.assign(existing, patch);
      return;
    }
    if (patch.pos || patch.name) {
      this.entities.set(id, {
        id,
        uuid: patch.uuid ?? "",
        name: patch.name ?? `entity-${id}`,
        type: patch.type ?? "unknown",
        pos: patch.pos ?? new Vec3(),
        yaw: patch.yaw ?? 0,
        pitch: patch.pitch ?? 0,
        hurtTime: patch.hurtTime ?? 0,
        isLiving: patch.isLiving ?? true,
      });
    }
  }

  markHurt(id: number): void {
    const e = this.entities.get(id);
    if (e) e.hurtTime = 10;
  }

  /** 每 tick 递减 hurtTime（原版 10 → 0） */
  tick(): void {
    for (const e of this.entities.values()) {
      if (e.hurtTime > 0) e.hurtTime--;
    }
  }

  get(id: number): TrackedEntity | undefined {
    return this.entities.get(id);
  }

  living(): TrackedEntity[] {
    return [...this.entities.values()].filter((e) => e.isLiving);
  }

  /** 距离给定点最近的存活实体（排除自己） */
  nearestLiving(pos: Vec3, excludeId: number | null, maxDistance: number): { entity: TrackedEntity; distance: number } | null {
    let best: { entity: TrackedEntity; distance: number } | null = null;
    for (const e of this.entities.values()) {
      if (!e.isLiving || e.id === excludeId) continue;
      const d = e.pos.distanceTo(pos);
      if (d > maxDistance) continue;
      if (!best || d < best.distance) best = { entity: e, distance: d };
    }
    return best;
  }
}

/* ---------------------------------------------------------------- 配置 */

export type CheckName =
  | "AutoBlockA"
  | "AutoClickerA"
  | "NoSlowA"
  | "ReachA"
  | "BlinkA"
  | "FlyA"
  | "GroundSpoofA"
  | "GroundSpoofB"
  | "MotionA"
  | "NoFallA"
  | "SpeedA"
  | "SpeedB"
  | "SpeedC"
  | "ScaffoldA"
  | "ScaffoldB"
  | "ScaffoldC"
  | "Simulation";

/** 原项目 Anticheat 模块的分组开关 */
export interface CheckGates {
  combat: boolean;
  movement: boolean;
  scaffolding: boolean;
  simulation: boolean;
  experimental: boolean;
}

/** 与原项目 AdvancedConfig / Anticheat 模块设置一一对应 */
export interface AntiCheatConfig {
  enabled: boolean;
  /** 移动阈值（方块），对应 Anticheat.threshold */
  threshold: number;
  /** 延迟补偿（ms），对应 Anticheat.latency，用于 SpeedC 历史索引 */
  latency: number;
  /** 每多少 tick 清一次 VL；-1 = 不清 */
  vlClearTicks: number;
  /** false = 每次都告警（对应 noAlertBuffer = true） */
  alertBuffer: boolean;
  /** 实验性检查（ReachA / MotionA / ScaffoldA） */
  experimental: boolean;
  /** 是否把告警打到 imcp 控制台 */
  console: boolean;
  /** 是否把告警打到游戏内聊天栏 */
  inGameChat: boolean;
  /** 每个检查的开关；缺省用默认值 */
  checks: Partial<Record<CheckName, boolean>>;
}

/** 原版 AdvancedConfig 的数值 */
export const ADVANCED_DEFAULTS = {
  blinkAlertBuffer: 10,
  blinkMaxDistance: 8,
  noSlowAAlertBuffer: 20,
  noSlowAInJumpDisableTick: 4,
  speedAAlertBuffer: 30,
  speedAAfterJumpJumpTick: 10,
  speedAAfterJumpSpeed: 7.4,
  speedASprintingSpeed: 5.612,
  speedASilentSpeed: 1.295,
  speedAWalkSpeed: 4.317,
  speedBAlertBuffer: 10,
  speedCAlertBuffer: 10,
  groundSpoofAAlertBuffer: 15,
  groundSpoofBAlertBuffer: 15,
  autoBlockAAlertBuffer: 1,
  motionAAlertBuffer: 10,
  reachAAlertBuffer: 4,
  reachADefaultReach: 3.5,
  reachACheckDelay: 2,
  flyAAlertBuffer: 30,
  scaffoldAAlertBuffer: 30,
  scaffoldBAlertBuffer: 10,
  noFallAAlertBuffer: 3,
  simulationAlertBuffer: 10,
};

/** 默认开哪些检查（与原项目 CheckManager 注册 + 模块默认开关一致） */
export const DEFAULT_CHECK_TOGGLES: Record<CheckName, boolean> = {
  AutoBlockA: true,
  AutoClickerA: true,
  NoSlowA: true,
  ReachA: false, // 需要 experimental
  BlinkA: true,
  FlyA: true,
  GroundSpoofA: true,
  GroundSpoofB: true,
  MotionA: false, // 需要 experimental，且原项目标注 unfinished
  NoFallA: true,
  SpeedA: true,
  SpeedB: true,
  SpeedC: true,
  ScaffoldA: false, // 需要 experimental
  ScaffoldB: true,
  ScaffoldC: true,
  Simulation: true, // 完整预测（PredictEngine 移植）：72 种输入枚举
};

export const DEFAULT_ANTICHEAT_CONFIG: AntiCheatConfig = {
  enabled: true,
  threshold: 1.0,
  latency: 600,
  vlClearTicks: 6000,
  alertBuffer: true,
  experimental: false,
  console: true,
  inGameChat: true,
  checks: {},
};

export function resolveCheckToggles(config: AntiCheatConfig): Record<CheckName, boolean> {
  const out = { ...DEFAULT_CHECK_TOGGLES };
  for (const [name, value] of Object.entries(config.checks ?? {})) {
    if (typeof value === "boolean" && name in out) out[name as CheckName] = value;
  }
  return out;
}
