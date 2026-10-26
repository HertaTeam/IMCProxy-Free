import mcp from "minecraft-protocol";
import { Logger } from "../logger.js";

const { createDeserializer, createSerializer, states } = mcp;

/**
 * nameprotect：把自己在**客户端界面**上的名字换成自定义名称。
 *
 * 覆盖位置（与原版客户端一致）：
 *   - 玩家列表 / Tab（player_info 0x38）
 *   - 聊天栏，含被 @ 提及（chat 0x02）
 *   - 计分板（scoreboard_* 0x3B/0x3C/0x3E）
 *
 * 关键点：**只改"服务端 → 客户端"方向的封包**。
 * 发给服务端的封包一个字节都不动，这个设置本身也从不发给服务器或回传客户端。
 *
 * 长度限制（重要）：
 *   MC 1.8 的字符串字段有硬上限，超了客户端会直接断线，例如
 *   `The received string length is longer than maximum allowed (36 > 16)`。
 *   所以每个字段替换后都会按协议上限截断，超限就直接放弃该字段的替换。
 */

export interface NameProtectOptions {
  enabled: boolean;
  /** 客户端上显示的自定义名称 */
  name: string;
  /** 是否作用于玩家列表 */
  playlist: boolean;
  /** 是否作用于聊天栏（含被提及） */
  chat: boolean;
  /** 是否作用于计分板 */
  scoreboard: boolean;
}

const CHAT_PACKET = "chat";
const PLAYLIST_PACKET = "player_info";
const SCOREBOARD_PACKETS = new Set(["scoreboard_objective", "scoreboard_score", "scoreboard_team"]);

/** MC 1.8 各字段的字符串上限（字符数，不是字节数） */
const LIMIT = {
  playerName: 16,
  objectiveDisplay: 32,
  teamName: 16,
  teamDisplay: 32,
  teamPrefix: 16,
  teamSuffix: 16,
  scoreEntity: 40,
  chat: 32767,
} as const;

/** 按 UTF-16 长度截断（和 MC 的 String.length 判定完全一致） */
function clampTo(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

export class NameProtector {
  private logger = new Logger("NameProtect");
  private deserializer = createDeserializer({
    state: states.PLAY,
    // 注意：createDeserializer 的 isServer 语义与 createSerializer 相反
    isServer: false, // -> toClient
    version: "1.8.9",
    customPackets: null,
    // 运行时支持，类型定义里没有
    noErrorLogging: true,
  } as any);
  private serializer = createSerializer({
    state: states.PLAY,
    isServer: true, // -> toClient
    version: "1.8.9",
    customPackets: null,
  });

  private resolveOptions: () => NameProtectOptions;
  private resolveDisplayName: () => string;
  /** 需要被替换掉的原名（客户端名 + 服务端看到的随机 ID 名） */
  private names: string[];
  private warned = false;
  private warnedTooLong = false;

  constructor(resolveOptions: () => NameProtectOptions, resolveDisplayName: () => string, names: string[]) {
    this.resolveOptions = resolveOptions;
    this.resolveDisplayName = resolveDisplayName;
    this.names = names.filter((n) => typeof n === "string" && n.length > 0);

    // 配置里的名字太长时只提示一次；实际替换会按字段上限截断
    const configured = this.resolveDisplayName();
    if (configured.length > LIMIT.playerName && this.options.enabled) {
      this.warnedTooLong = true;
      this.logger.warn(
        `Display name is ${configured.length} chars; player list allows ${LIMIT.playerName}. ` +
          `It will be truncated to avoid a client kick (set a shorter nameProtect.name to avoid this).`
      );
    }
  }

  private get options(): NameProtectOptions {
    return this.resolveOptions();
  }

  isEnabled(): boolean {
    return this.options.enabled && this.resolveDisplayName().length > 0 && this.names.length > 0;
  }

  private touches(packetName: string): boolean {
    if (this.options.playlist && packetName === PLAYLIST_PACKET) return true;
    if (this.options.chat && packetName === CHAT_PACKET) return true;
    if (this.options.scoreboard && SCOREBOARD_PACKETS.has(packetName)) return true;
    return false;
  }

  /**
   * 把字符串里的原名都换成显示名。
   * @param max 该字段的协议上限；替换后超限会被截断
   * @returns null = 没有变化
   */
  private replace(text: unknown, displayName: string, max: number): string | null {
    if (typeof text !== "string" || !text) return null;
    let out = text;
    for (const name of this.names) {
      if (out.includes(name)) out = out.split(name).join(displayName);
    }
    if (out === text) return null;
    return clampTo(out, max);
  }

  /**
   * 服务端 → 客户端封包入口。
   * 返回新的 buffer；不需要改写时原样返回入参（保持零拷贝转发）。
   */
  rewrite(data: Buffer): Buffer {
    if (!this.isEnabled()) return data;

    const displayName = this.resolveDisplayName();
    // 配置的名字本身超长时，列表里只能用截断版本
    const listName = clampTo(displayName, LIMIT.playerName);
    const packetId = data[0];
    // 只处理可能含玩家名的几个包：0x02 chat / 0x38 player_info / 0x3B-0x3E scoreboard
    if (packetId !== 0x02 && packetId !== 0x38 && packetId !== 0x3b && packetId !== 0x3c && packetId !== 0x3e) {
      return data;
    }

    let parsed: any;
    try {
      parsed = this.deserializer.parsePacketBuffer(data);
    } catch {
      return data;
    }

    const packetName: string | undefined = parsed?.data?.name;
    const params: any = parsed?.data?.params;
    if (typeof packetName !== "string" || !params) return data;
    if (!this.touches(packetName)) return data;

    let changed = false;
    try {
      changed = this.apply(packetName, params, displayName, listName);
    } catch (err) {
      if (!this.warned) {
        this.warned = true;
        this.logger.warn(`Rewrite failed, forwarding untouched: ${(err as Error).message}`);
      }
      return data;
    }
    if (!changed) return data;

    let buffer: Buffer;
    try {
      buffer = this.serializer.createPacketBuffer({ name: packetName, params });
    } catch (err) {
      if (!this.warned) {
        this.warned = true;
        this.logger.warn(`Re-encode failed, forwarding untouched: ${(err as Error).message}`);
      }
      return data;
    }

    // 最后再兜一次底：重新编码的包如果比原包畸形（长度超限）就丢弃改写
    if (buffer.length > data.length + 512) {
      if (!this.warned) {
        this.warned = true;
        this.logger.warn("Rewrite produced an oversized packet, forwarding untouched.");
      }
      return data;
    }
    return buffer;
  }

  /** @returns 是否发生了改动 */
  private apply(packetName: string, params: any, displayName: string, listName: string): boolean {
    let changed = false;

    if (packetName === PLAYLIST_PACKET) {
      if (!Array.isArray(params.data)) return false;
      for (const entry of params.data) {
        // 玩家列表的 name 只有 16 字符，必须用截断后的名字
        const replaced = this.replace(entry?.name, listName, LIMIT.playerName);
        if (replaced !== null) {
          entry.name = replaced;
          changed = true;
        }
        const display = this.replace(entry?.displayName, listName, LIMIT.playerName);
        if (display !== null) {
          entry.displayName = display;
          changed = true;
        }
      }
      return changed;
    }

    if (packetName === CHAT_PACKET) {
      const replaced = this.replace(params.message, displayName, LIMIT.chat);
      if (replaced !== null) {
        params.message = replaced;
        changed = true;
      }
      return changed;
    }

    if (packetName === "scoreboard_score") {
      const replaced = this.replace(params.itemName, displayName, LIMIT.scoreEntity);
      if (replaced !== null) {
        params.itemName = replaced;
        changed = true;
      }
      return changed;
    }

    if (packetName === "scoreboard_objective") {
      const replaced = this.replace(params.displayText, displayName, LIMIT.objectiveDisplay);
      if (replaced !== null) {
        params.displayText = replaced;
        changed = true;
      }
      return changed;
    }

    if (packetName === "scoreboard_team") {
      const players: unknown = params.players;
      if (Array.isArray(players)) {
        for (let i = 0; i < players.length; i++) {
          const replaced = this.replace(players[i], displayName, LIMIT.scoreEntity);
          if (replaced !== null) {
            players[i] = replaced;
            changed = true;
          }
        }
      }
      const limits: Record<string, number> = {
        prefix: LIMIT.teamPrefix,
        suffix: LIMIT.teamSuffix,
        name: listName.length <= LIMIT.teamName ? listName.length : LIMIT.teamName,
      };
      for (const key of ["prefix", "suffix", "name"] as const) {
        const replaced = this.replace(params[key], key === "name" ? listName : displayName, limits[key]);
        if (replaced !== null) {
          params[key] = replaced;
          changed = true;
        }
      }
      return changed;
    }

    return false;
  }
}
