/**
 * 反作弊总入口：把代理双向封包喂给移植过来的检查。
 *
 * 只做"参考显示"：违规会同时输出到 imcp 控制台和玩家游戏内聊天栏，
 * 但**不会**踢人、不会改包。
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

/** 每个玩家的运行时状态 */
interface PlayerSession {
  player: TRPlayer;
  gates: CheckGates;
  toggles: Record<string, boolean>;
  checks: ReturnType<typeof registerAllChecks>;
  ticker: NodeJS.Timeout;
  /** 挥手动效剩余 tick（1.8 的 isSwingInProgress 会持续几 tick） */
  swingTicks: number;
}

export class AntiCheatManager {
  private readonly logger = new Logger("AntiCheat");
  private readonly config: AntiCheatConfig;
  private readonly world = new WorldModel();
  private readonly entities = new EntityTracker();
  private readonly sessions = new Map<string, PlayerSession>();
  private readonly deserializer = createDeserializer({
    state: states.PLAY,
    isServer: false, // -> toClient
    version: "1.8.9",
    customPackets: null,
    noErrorLogging: true,
  } as any);

  /** 把告警送到游戏内聊天栏（由 ReverseProxy 注入） */
  private chatSink: ((player: string, text: string) => void) | null = null;
  private blocked = false;

  constructor(config: Partial<AntiCheatConfig> = {}) {
    this.config = {
      ...DEFAULT_ANTICHEAT_CONFIG,
      ...config,
      checks: { ...(config.checks ?? {}) },
    };
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }

  getConfig(): AntiCheatConfig {
    return this.config;
  }

  setChatSink(sink: (player: string, text: string) => void): void {
    this.chatSink = sink;
  }

  registerPlayer(name: string): void {
    if (!this.config.enabled || this.sessions.has(name)) return;
    const toggles = resolveCheckToggles(this.config);
    const gates: CheckGates = {
      combat: toggles.AutoBlockA || toggles.AutoClickerA || toggles.NoSlowA || toggles.ReachA,
      movement: true,
      scaffolding: toggles.ScaffoldA || toggles.ScaffoldB || toggles.ScaffoldC,
      simulation: toggles.Simulation,
      experimental: this.config.experimental,
    };

    const player = new TRPlayer(name, this.config, this.world, this.entities, (p, check, vl, extra) =>
      this.emitAlert(p, check, vl, extra)
    );
    const checks = registerAllChecks(player, gates, toggles);
    const ticker = setInterval(() => {
      if (this.blocked) return;
      this.entities.tick();
      try {
        player.tick();
      } catch (err) {
        this.logger.debug(`[${name}] tick failed: ${(err as Error).message}`);
      }
    }, 50);

    this.sessions.set(name, { player, gates, toggles, checks, ticker, swingTicks: 0 });
  }

  removePlayer(name: string): void {
    const session = this.sessions.get(name);
    if (!session) return;
    clearInterval(session.ticker);
    this.sessions.delete(name);
  }

  shutdown(): void {
    for (const name of [...this.sessions.keys()]) this.removePlayer(name);
    this.world.reset();
    this.entities.clear();
  }

  /** 某个检查分组是否至少有一个子检查开着 */
  private toggleGroup(check: CheckName): boolean {
    const toggles = resolveCheckToggles(this.config);
    return toggles[check] === true;
  }

  /* ------------------------------------------------------- 客户端 → 服务端 */

  handleClientPacket(name: string, packet: any, meta: any): void {
    const session = this.sessions.get(name);
    if (!session || !this.config.enabled) return;
    if (!packet || typeof packet !== "object") return;
    const state = session.player.state;

    try {
      switch (meta?.name) {
        case "position":
        case "position_look": {
          if (typeof packet.x === "number" && typeof packet.y === "number" && typeof packet.z === "number") {
            const nextPos = new Vec3(packet.x, packet.y, packet.z);
            // 完整预测反作弊是包驱动的：一个移动包 = 一个客户端 tick
            session.checks.simulation.onMovePacket(
              nextPos,
              Boolean(packet.onGround),
              typeof packet.yaw === "number" ? packet.yaw : state.rot.yaw,
              typeof packet.pitch === "number" ? packet.pitch : state.rot.pitch
            );
            state.pos = nextPos;
          }
          if (typeof packet.onGround === "boolean") state.onGround = packet.onGround;
          if (typeof packet.yaw === "number") state.rot.yaw = packet.yaw;
          if (typeof packet.pitch === "number") state.rot.pitch = packet.pitch;
          break;
        }
        case "look": {
          if (typeof packet.yaw === "number") state.rot.yaw = packet.yaw;
          if (typeof packet.pitch === "number") state.rot.pitch = packet.pitch;
          if (typeof packet.onGround === "boolean") state.onGround = packet.onGround;
          break;
        }
        case "flying": {
          if (typeof packet.onGround === "boolean") state.onGround = packet.onGround;
          break;
        }
        case "entity_action": {
          const action = packet.actionId ?? packet.action;
          if (action === 0) {
            state.sneaking = true;
            state.ticksSinceSneak = 0;
          } else if (action === 1) state.sneaking = false;
          else if (action === 3) state.sprinting = true;
          else if (action === 4) state.sprinting = false;
          break;
        }
        case "client_command": {
          const action = packet.actionId;
          if (action === 0) {
            state.sneaking = true;
            state.ticksSinceSneak = 0;
          } else if (action === 1) state.sneaking = false;
          else if (action === 3) state.sprinting = true;
          else if (action === 4) state.sprinting = false;
          break;
        }
        case "arm_animation": {
          session.swingTicks = 6;
          state.swing = true;
          // 自己客户端挥手 → 点击速率 + 命中检测（1.8 服务端不会回显自己的动画）
          session.checks.autoClicker.onSelfAnimation();
          session.checks.autoBlock.onSelfAnimation();
          break;
        }
        case "block_place": {
          session.swingTicks = Math.max(session.swingTicks, 6);
          session.player.notifyPlaceBlock();
          break;
        }
        case "use_item": {
          state.usingItem = true;
          break;
        }
        case "block_dig": {
          if (packet.status === 5) state.usingItem = false;
          if (packet.status === 0 || packet.status === 2) state.usingItem = true;
          break;
        }
        case "held_item_slot": {
          // 物品本身由 window_items / set_slot 更新，这里只记录切换
          break;
        }
        case "use_entity": {
          // 攻击目标：交给 ReachA 的距离判定，不做额外处理
          break;
        }
      }
    } catch (err) {
      this.logger.debug(`[${name}] client packet ${meta?.name} failed: ${(err as Error).message}`);
    }
  }

  /* ------------------------------------------------------- 服务端 → 客户端 */

  handleServerPacket(name: string, data: Buffer): void {
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
      this.updateEntities(packetName, params);
      this.updateSelfState(name, packetName, params);
    } catch (err) {
      this.logger.debug(`[${name ?? "-"}] server packet ${packetName} failed: ${(err as Error).message}`);
    }
  }

  private updateWorld(packetName: string, params: any): void {
    switch (packetName) {
      case "map_chunk": {
        const cx = params.x;
        const cz = params.z;
        if (typeof cx !== "number" || typeof cz !== "number") return;
        const bitMap = Array.isArray(params.bitMap) ? params.bitMap : null;
        const sky = params.skyLightSent !== false;
        this.world.loadChunkData(cx, cz, params.chunkData, bitMap, sky);
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
        this.world.reset();
        if (typeof params.dimension === "number") this.world.setDimension(params.dimension);
        break;
      }
    }
  }

  private updateEntities(packetName: string, params: any): void {
    const id = params.entityId;
    switch (packetName) {
      case "named_entity_spawn": {
        this.entities.upsert(id, {
          uuid: params.playerUUID,
          pos: new Vec3(params.x, params.y, params.z),
          yaw: params.yaw,
          pitch: params.pitch,
          isLiving: true,
          name: params.playerUUID ? `player-${String(params.playerUUID).slice(0, 8)}` : undefined,
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
      case "spawn_entity":
      case "spawn_entity_experience_orb": {
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
        e.pos = new Vec3(e.pos.x + (params.dX ?? 0) / 32, e.pos.y + (params.dY ?? 0) / 32, e.pos.z + (params.dZ ?? 0) / 32);
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
        e.pos = new Vec3(params.x, params.y, params.z);
        if (typeof params.yaw === "number") e.yaw = params.yaw;
        if (typeof params.pitch === "number") e.pitch = params.pitch;
        break;
      }
      case "entity_velocity": {
        // 只用于保持实体存活，不做物理积分
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

  private updateSelfState(name: string, packetName: string, params: any): void {
    const session = this.sessions.get(name);
    if (!session) return;
    const state = session.player.state;

    switch (packetName) {
      case "position": {
        // 服务端传送/校正
        if (typeof params.x === "number") {
          state.serverPos = new Vec3(params.x, params.y, params.z);
          state.pos = new Vec3(params.x, params.y, params.z);
          session.player.hasSetback = true;
          setTimeout(() => (session.player.hasSetback = false), 400);
        }
        break;
      }
      case "login": {
        state.gameType = gameModeName(params.gameMode);
        break;
      }
      case "respawn": {
        state.gameType = gameModeName(params.gameMode);
        break;
      }
      case "abilities": {
        if (typeof params.flags === "number") state.flying = (params.flags & 0x02) !== 0;
        break;
      }
      case "update_health": {
        if (typeof params.food === "number") state.food = params.food;
        break;
      }
      case "entity_effect": {
        if (params.entityId !== undefined && params.effectId === undefined) break;
        if (params.effectId === 1) state.speedAmplifier = params.amplifier ?? 0;
        if (params.effectId === 8) state.jumpAmplifier = params.amplifier ?? 0;
        break;
      }
      case "remove_entity_effect": {
        if (params.effectId === 1) state.speedAmplifier = -1;
        if (params.effectId === 8) state.jumpAmplifier = -1;
        break;
      }
      case "animation": {
        // 服务端广播的挥手动画：给 AutoBlockA / AutoClickerA 用
        session.checks.autoBlock.onSelfAnimation();
        session.checks.autoClicker.onSelfAnimation();
        state.swing = true;
        session.swingTicks = 6;
        break;
      }
      case "rel_entity_move":
      case "entity_move_look": {
        // 自己实体的移动封包 → AutoBlockA 的"不可能命中"
        session.checks.autoBlock.onSelfEntityMove();
        break;
      }
      case "entity_teleport": {
        session.checks.autoBlock.onSelfEntityMove();
        break;
      }
    }

    // 挥手上升沿 → ReachA
    if (session.player.currentSwing && !session.player.lastSwing) {
      session.checks.reach.onSwingStart();
    }
  }

  /* ------------------------------------------------------------- 告警输出 */

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

  /** 世界模型（测试 / 调试用） */
  worldModel(): WorldModel {
    return this.world;
  }

  /** 某个玩家的检查实例（测试用） */
  sessionChecks(player: string): ReturnType<typeof registerAllChecks> | null {
    return this.sessions.get(player)?.checks ?? null;
  }

  /** 控制台 /anticheat 用 */
  status(): Array<{ player: string; violations: Record<string, number> }> {    return [...this.sessions.entries()].map(([name, session]) => ({
      player: name,
      violations: session.player.manager.violations(),
    }));
  }

  clearViolations(): void {
    for (const [, session] of this.sessions) {
      session.player.manager.onCustomAction((check) => (check.violations = 0));
    }
  }

  /** 关服/调试用：暂停/恢复 tick */
  setBlocked(blocked: boolean): void {
    this.blocked = blocked;
  }
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

export { DEFAULT_ANTICHEAT_CONFIG, resolveCheckToggles, color };
export type { AntiCheatConfig, CheckName };
