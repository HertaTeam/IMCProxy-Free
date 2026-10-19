/**
 * 反作弊总入口 —— 检测目标是**服务器上的其他玩家**（和原版 ravenxd Anticheat 一致），
 * 不是走代理的这位玩家自己。
 *
 * 数据来源全部是服务端 → 客户端的实体封包：
 *   named_entity_spawn / rel_entity_move / entity_move_look / entity_teleport / entity_look
 *   entity_metadata（疾跑·潜行·使用物品标志）/ animation（挥手）/ entity_status（受伤）
 *   player_info（uuid → 名字）/ entity_destroy / respawn
 *
 * 告警同时输出到 imcp 控制台和本机玩家聊天栏；**不踢人、不改包**。
 */
import mcp from "minecraft-protocol";
import { Logger, color } from "../../logger.js";
import {
  DEFAULT_ANTICHEAT_CONFIG,
  EntityTracker,
  Vec3,
  WorldModel,
  resolveCheckToggles,
  type AntiCheatConfig,
  type CheckGates,
  type CheckName,
} from "./core.js";
import { TRPlayer, type GameType } from "./engine.js";
import { registerAllChecks } from "./checks.js";

const { createDeserializer, states } = mcp;

/** 其他玩家的运行时会话 */
interface TrackedPlayer {
  entityId: number;
  uuid: string;
  name: string;
  player: TRPlayer;
  gates: CheckGates;
  toggles: Record<string, boolean>;
  checks: ReturnType<typeof registerAllChecks>;
  /** 服务端下发的位置（也是 TRPlayer 的输入） */
  pos: Vec3;
  yaw: number;
  pitch: number;
  onGround: boolean;
  sprinting: boolean;
  sneaking: boolean;
  usingItem: boolean;
  /** 挥手动画剩余 tick */
  swingTicks: number;
  /** 最近一次收到移动包的时间 */
  lastMoveAt: number;
  /** 连续多少次移动包都被"环境不确定"跳过 */
  skipped: number;
}

/**
 * 其他玩家的判定阈值倍数。
 * 原因是实体包按需下发、还可能被客户端插值，误差比本地玩家大得多，
 * 用和本地一样的 1.0 会大量误报。
 */
const OTHER_THRESHOLD_MULTIPLIER = 1.5;

/** 实体 metadata 里的标志位（1.8 flags：0x02 潜行 / 0x08 疾跑 / 0x10 使用物品） */
const FLAG_SNEAKING = 0x02;
const FLAG_SPRINTING = 0x08;
const FLAG_USING_ITEM = 0x10;

export class AntiCheatManager {
  private readonly logger = new Logger("AntiCheat");
  private readonly config: AntiCheatConfig;
  private readonly world = new WorldModel();
  private readonly entities = new EntityTracker();
  private readonly tracked = new Map<number, TrackedPlayer>();
  /** uuid → 玩家名（player_info 提供） */
  private readonly names = new Map<string, string>();
  private readonly deserializer = createDeserializer({
    state: states.PLAY,
    isServer: false, // -> toClient
    version: "1.8.9",
    customPackets: null,
    noErrorLogging: true,
  } as any);

  private ticker: NodeJS.Timeout | null = null;
  private blocked = false;
  private chatSink: ((player: string, text: string) => void) | null = null;

  constructor(config: Partial<AntiCheatConfig> = {}) {
    this.config = {
      ...DEFAULT_ANTICHEAT_CONFIG,
      ...config,
      checks: { ...(config.checks ?? {}) },
    };
    this.ticker = setInterval(() => this.tickAll(), 50);
    this.ticker.unref?.();
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }

  getConfig(): AntiCheatConfig {
    return this.config;
  }

  worldModel(): WorldModel {
    return this.world;
  }

  /** 测试 / 调试：当前被追踪的其他玩家 */
  trackedPlayers(): Array<{ entityId: number; name: string }> {
    return [...this.tracked.values()].map((t) => ({ entityId: t.entityId, name: t.name }));
  }

  sessionChecks(entityId: number): ReturnType<typeof registerAllChecks> | null {
    return this.tracked.get(entityId)?.checks ?? null;
  }

  /** 兼容旧调用：本地玩家不再参与检测 */
  registerPlayer(_name: string): void {
    /* no-op：检测目标是服务器上的其他玩家 */
  }

  removePlayer(_name: string): void {
    /* no-op */
  }

  setChatSink(sink: (player: string, text: string) => void): void {
    this.chatSink = sink;
  }

  setBlocked(blocked: boolean): void {
    this.blocked = blocked;
  }

  shutdown(): void {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
    this.tracked.clear();
    this.names.clear();
    this.world.reset();
    this.entities.clear();
  }

  /* ------------------------------------------------------- 服务端 → 客户端 */

  handleServerPacket(_localPlayer: string, data: Buffer): void {
    if (!this.config.enabled) return;
    let parsed: any;
    try {
      parsed = this.deserializer.parsePacketBuffer(data);
    } catch {
      return;
    }
    const packetName: string | undefined = parsed?.data?.name;
    const params: any = parsed?.data?.params;
    if (!packetName || !params) return;

    try {
      this.updateWorld(packetName, params);
      this.entities2(packetName, params);
      this.updateTracked(packetName, params);
    } catch (err) {
      this.logger.debug(`anticheat packet ${packetName} failed: ${(err as Error).message}`);
    }
  }

  /** 本地玩家的封包不再用于检测（保留接口，避免调用方改动） */
  handleClientPacket(_name: string, _packet: any, _meta: any): void {
    /* 检测目标是其他玩家 */
  }

  private updateWorld(packetName: string, params: any): void {
    switch (packetName) {
      case "map_chunk": {
        const cx = params.x;
        const cz = params.z;
        if (typeof cx !== "number" || typeof cz !== "number") return;
        const bitMap = Array.isArray(params.bitMap) ? params.bitMap : null;
        this.world.loadChunkData(cx, cz, params.chunkData, bitMap, params.skyLightSent !== false);
        break;
      }
      case "map_chunk_bulk": {
        const chunks = Array.isArray(params.chunks) ? params.chunks : [];
        for (const chunk of chunks) {
          if (typeof chunk?.x === "number") {
            this.world.loadChunkData(chunk.x, chunk.z, chunk.chunkData, null, params.skyLightSent !== false);
          }
        }
        break;
      }
      case "block_change": {
        const loc = params.location;
        if (!loc) return;
        const type = typeof params.type === "number" ? params.type : 0;
        this.world.setBlock(loc.x, loc.y, loc.z, type >> 4, type & 0x0f);
        break;
      }
      case "multi_block_change": {
        const records = Array.isArray(params.records) ? params.records : [];
        const cx = params.chunkX;
        const cz = params.chunkZ;
        if (typeof cx !== "number" || typeof cz !== "number") return;
        for (const record of records) {
          if (typeof record?.horizontalPos !== "number") continue;
          const pos = record.horizontalPos;
          const x = cx * 16 + (pos >> 4);
          const z = cz * 16 + (pos & 0x0f);
          this.world.setBlock(x, record.y, z, record.blockId >> 4, record.blockId & 0x0f);
        }
        break;
      }
      case "respawn": {
        // 换世界：所有实体都会重发，先清空
        this.world.reset();
        this.entities.clear();
        this.tracked.clear();
        if (typeof params.dimension === "number") this.world.setDimension(params.dimension);
        break;
      }
    }
  }

  /** 通用实体追踪（ReachA 需要受伤时间） */
  private entities2(packetName: string, params: any): void {
    const id = params.entityId;
    switch (packetName) {
      case "named_entity_spawn": {
        this.entities.upsert(id, {
          uuid: params.playerUUID,
          pos: new Vec3(params.x / 32, params.y / 32, params.z / 32),
          yaw: params.yaw,
          pitch: params.pitch,
          isLiving: true,
        });
        break;
      }
      case "spawn_entity_living": {
        this.entities.upsert(id, {
          type: String(params.type),
          pos: new Vec3(params.x, params.y, params.z),
          yaw: params.yaw,
          pitch: params.pitch,
          isLiving: true,
        });
        break;
      }
      case "spawn_entity": {
        this.entities.upsert(id, {
          type: String(params.type ?? "object"),
          pos: new Vec3(params.x, params.y, params.z),
          isLiving: false,
        });
        break;
      }
      case "rel_entity_move":
      case "entity_move_look": {
        const e = this.entities.get(id);
        if (!e) return;
        e.pos = new Vec3(
          e.pos.x + (params.dX ?? 0) / 32,
          e.pos.y + (params.dY ?? 0) / 32,
          e.pos.z + (params.dZ ?? 0) / 32
        );
        if (typeof params.yaw === "number") e.yaw = params.yaw;
        if (typeof params.pitch === "number") e.pitch = params.pitch;
        break;
      }
      case "entity_look": {
        const e = this.entities.get(id);
        if (!e) return;
        if (typeof params.yaw === "number") e.yaw = params.yaw;
        if (typeof params.pitch === "number") e.pitch = params.pitch;
        break;
      }
      case "entity_teleport": {
        const e = this.entities.get(id);
        if (!e) return;
        e.pos = new Vec3(params.x / 32, params.y / 32, params.z / 32);
        break;
      }
      case "entity_destroy": {
        const ids = Array.isArray(params.entityIds) ? params.entityIds : [];
        for (const entityId of ids) this.entities.remove(entityId);
        break;
      }
      case "entity_status": {
        if (params.entityStatus === 2) this.entities.markHurt(id);
        break;
      }
    }
  }

  /* ------------------------------------------------------ 其他玩家追踪 */

  private updateTracked(packetName: string, params: any): void {
    switch (packetName) {
      case "player_info": {
        // action 0 = add player
        if (params.action !== 0) return;
        const entries = Array.isArray(params.data) ? params.data : [];
        for (const entry of entries) {
          // 1.8 里字段名是大写 UUID
          const uuid = entry?.UUID ?? entry?.uuid;
          if (uuid && typeof entry.name === "string") this.names.set(uuid, entry.name);
        }
        // 名字后到的情况：补上
        for (const tracked of this.tracked.values()) {
          const resolved = this.names.get(tracked.uuid);
          if (resolved && tracked.name !== resolved) tracked.name = resolved;
        }
        break;
      }
      case "named_entity_spawn": {
        const uuid: string = params.playerUUID ?? "";
        if (!uuid) return;
        // 1.8 的生成包坐标是 i32 定点数（×32）
        this.ensureTracked(
          params.entityId,
          uuid,
          new Vec3(params.x / 32, params.y / 32, params.z / 32),
          params.yaw ?? 0,
          params.pitch ?? 0
        );
        break;
      }
      case "rel_entity_move":
      case "entity_move_look": {
        const tracked = this.tracked.get(params.entityId);
        if (!tracked) return;
        const next = new Vec3(
          tracked.pos.x + (params.dX ?? 0) / 32,
          tracked.pos.y + (params.dY ?? 0) / 32,
          tracked.pos.z + (params.dZ ?? 0) / 32
        );
        if (typeof params.yaw === "number") tracked.yaw = params.yaw;
        if (typeof params.pitch === "number") tracked.pitch = params.pitch;
        this.applyMove(tracked, next);
        break;
      }
      case "entity_teleport": {
        const tracked = this.tracked.get(params.entityId);
        if (!tracked) return;
        if (typeof params.yaw === "number") tracked.yaw = params.yaw;
        if (typeof params.pitch === "number") tracked.pitch = params.pitch;
        this.applyMove(tracked, new Vec3(params.x / 32, params.y / 32, params.z / 32));
        break;
      }
      case "entity_metadata": {
        const tracked = this.tracked.get(params.entityId);
        if (!tracked) return;
        const flags = readFlags(params.metadata);
        if (flags !== null) {
          tracked.sprinting = (flags & FLAG_SPRINTING) !== 0;
          tracked.sneaking = (flags & FLAG_SNEAKING) !== 0;
          tracked.usingItem = (flags & FLAG_USING_ITEM) !== 0;
        }
        break;
      }
      case "animation": {
        const tracked = this.tracked.get(params.entityId);
        if (!tracked) return;
        if (params.animation !== 0 && params.animation !== undefined) return; // 0 = 挥手
        tracked.swingTicks = 6;
        tracked.checks.autoClicker.onSelfAnimation();
        tracked.checks.autoBlock.onSelfAnimation();
        break;
      }
      case "entity_destroy": {
        const ids = Array.isArray(params.entityIds) ? params.entityIds : [];
        for (const id of ids) this.removeTracked(id);
        break;
      }
    }
  }

  private ensureTracked(entityId: number, uuid: string, pos: Vec3, yaw: number, pitch: number): void {
    if (this.tracked.has(entityId)) return;
    const name = this.names.get(uuid) ?? `player-${String(uuid).slice(0, 8)}`;
    const toggles = resolveCheckToggles(this.config);
    const gates: CheckGates = {
      combat: toggles.AutoBlockA || toggles.AutoClickerA || toggles.NoSlowA || toggles.ReachA,
      movement: true,
      scaffolding: toggles.ScaffoldA || toggles.ScaffoldB || toggles.ScaffoldC,
      simulation: toggles.Simulation,
      experimental: this.config.experimental,
    };

    const tr = new TRPlayer(name, this.config, this.world, this.entities, (player, check, vl, extra) => {
      // 名字可能后来才由 player_info 补上，告警时取最新
      const current = this.tracked.get(entityId)?.name ?? player;
      this.emitAlert(current, check, vl, extra);
    });
    // 其他玩家的实体包稀疏且会被插值，阈值放宽，避免误报
    tr.thresholdOverride = this.config.threshold * OTHER_THRESHOLD_MULTIPLIER;
    tr.state.gameType = "survival" as GameType;
    tr.state.food = 20; // 看不到别人的饥饿值，避免 SpeedB 误报
    tr.state.pos = pos.clone();
    tr.state.serverPos = pos.clone();

    const checks = registerAllChecks(tr, gates, toggles);
    const tracked: TrackedPlayer = {
      entityId,
      uuid,
      name,
      player: tr,
      gates,
      toggles,
      checks,
      pos: pos.clone(),
      yaw,
      pitch,
      onGround: true,
      sprinting: false,
      sneaking: false,
      usingItem: false,
      swingTicks: 0,
      lastMoveAt: 0,
      skipped: 0,
    };
    this.tracked.set(entityId, tracked);
    this.logger.debug(`tracking other player "${name}" (entity ${entityId})`);

    // 先跑一轮对齐历史，避免第一 tick 的巨大位移
    tr.tick();
  }

  private applyMove(tracked: TrackedPlayer, next: Vec3): void {
    const previous = tracked.pos;
    tracked.pos = next.clone();
    tracked.lastMoveAt = Date.now();

    // 预测反作弊：一个移动包 = 一个 tick（用服务端下发的位置推演）
    tracked.checks.simulation.onMovePacket(next, tracked.onGround, tracked.yaw, tracked.pitch);

    tracked.player.state.pos = next.clone();
    const dx = next.x - previous.x;
    const dy = next.y - previous.y;
    const dz = next.z - previous.z;
    tracked.onGround = this.inferOnGround(next, dy);
    tracked.player.state.onGround = tracked.onGround;
    void dx;
    void dz;
  }

  /**
   * 其他玩家的 onGround 不会下发，只能推断：
   * 垂直方向没动、而且脚下有实心方块 → 认为站在地上。
   */
  private inferOnGround(pos: Vec3, dy: number): boolean {
    if (dy > 0.0001) return false;
    const below = this.world.getBlock(pos.x, pos.y - 0.05, pos.z);
    if (!below) return dy >= -0.0001;
    return below.id !== 0;
  }

  private removeTracked(entityId: number): void {
    const tracked = this.tracked.get(entityId);
    if (!tracked) return;
    this.tracked.delete(entityId);
    this.logger.debug(`stopped tracking "${tracked.name}"`);
  }

  /* --------------------------------------------------------------- tick */

  private tickAll(): void {
    if (!this.config.enabled || this.blocked) return;
    this.entities.tick();

    for (const tracked of this.tracked.values()) {
      const tr = tracked.player;
      // 把追踪到的状态同步给 TRPlayer（它负责 current/last/history）
      tr.state.pos = tracked.pos.clone();
      tr.state.rot.yaw = tracked.yaw;
      tr.state.rot.pitch = tracked.pitch;
      tr.state.onGround = tracked.onGround;
      tr.state.sprinting = tracked.sprinting;
      tr.state.sneaking = tracked.sneaking;
      tr.state.usingItem = tracked.usingItem;
      tr.state.swing = tracked.swingTicks > 0;
      tr.state.serverPos = tracked.pos.clone();

      if (tracked.swingTicks > 0) tracked.swingTicks--;

      try {
        tr.tick();
      } catch (err) {
        this.logger.debug(`[${tracked.name}] tick failed: ${(err as Error).message}`);
      }
    }
  }

  /* ------------------------------------------------------------- 告警 */

  private emitAlert(playerName: string, check: string, violations: number, extra: string): void {
    const suffix = extra ? ` ${extra}` : "";
    const line = `[${playerName}] failed ${check} (VL:${violations})${suffix}`;
    if (this.config.console) this.logger.warn(line);

    if (this.config.inGameChat && this.chatSink) {
      const chat = `§b§lTR§r §f${playerName} §7failed §e${check} §7(VL:${violations})${extra ? ` §8${extra}` : ""}`;
      try {
        this.chatSink(playerName, chat);
      } catch {
        /* 聊天栏不可用时忽略 */
      }
    }
  }

  /** 控制台 /anticheat 用 */
  status(): Array<{ player: string; violations: Record<string, number> }> {
    return [...this.tracked.values()].map((t) => ({
      player: t.name,
      violations: t.player.manager.violations(),
    }));
  }

  clearViolations(): void {
    for (const tracked of this.tracked.values()) {
      tracked.player.manager.onCustomAction((check) => (check.violations = 0));
    }
  }
}

/** 从 entity_metadata 里取 flags（index 0） */
function readFlags(metadata: unknown): number | null {
  if (!Array.isArray(metadata)) return null;
  for (const entry of metadata) {
    if (!entry || typeof entry !== "object") continue;
    const key = (entry as any).key;
    if (key !== 0) continue;
    const value = (entry as any).value;
    if (typeof value === "number") return value;
    if (value && typeof value === "object" && typeof (value as any).value === "number") return (value as any).value;
  }
  return null;
}

function gameModeName(mode: unknown): GameType {
  switch (mode) {
    case 1:
      return "creative";
    case 2:
      return "adventure";
    case 3:
      return "spectator";
    default:
      return "survival";
  }
}

export { DEFAULT_ANTICHEAT_CONFIG, resolveCheckToggles, color, gameModeName };
export type { AntiCheatConfig, CheckName };
