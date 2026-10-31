import mcp from "minecraft-protocol";
import { Logger } from "../logger.js";
import { profileFor, type ProtocolProfile } from "./ProtocolProfile.js";

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
 * 两种字段，处理方式不同（这是之前客户端被踢的原因）：
 *   1) 纯字符串字段（玩家名 / 队伍名 / 计分项名）→ 直接替换，超长按协议上限截断
 *   2) JSON 聊天组件字段（chat / 计分板显示文本 / 队伍前后缀）→ 解析组件、
 *      只替换组件里的文本节点、再序列化；**绝不按字符截断 JSON**，
 *      否则客户端会报 MalformedJsonException / Unterminated string 并断开。
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
const SCOREBOARD_PACKETS = new Set([
  "scoreboard_objective",
  "scoreboard_score",
  "scoreboard_team",
  "teams",
]);

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

/** 组件里允许替换的文本键 */
const COMPONENT_TEXT_KEYS = new Set(["text", "displayName", "prefix", "suffix"]);

/** 按 UTF-16 长度截断（和 MC 的 String.length 判定完全一致） */
function clampTo(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

function looksLikeJson(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

export class NameProtector {
  private logger = new Logger("NameProtect");
  private deserializerInstance: any = null;
  private serializerInstance: any = null;

  private get deserializer(): any {
    if (!this.deserializerInstance) {
      this.deserializerInstance = createDeserializer({
        state: states.PLAY,
        isServer: false,
        version: this.profile.version,
        customPackets: null,
        noErrorLogging: true,
      } as any);
    }
    return this.deserializerInstance;
  }

  private get serializer(): any {
    if (!this.serializerInstance) {
      this.serializerInstance = createSerializer({
        state: states.PLAY,
        isServer: true,
        version: this.profile.version,
        customPackets: null,
      });
    }
    return this.serializerInstance;
  }

  private resolveOptions: () => NameProtectOptions;
  private resolveDisplayName: () => string;
  /** 需要被替换掉的原名（客户端名 + 服务端看到的随机 ID 名） */
  private names: string[];
  private warned = false;

  private readonly profile: ProtocolProfile;

  constructor(
    resolveOptions: () => NameProtectOptions,
    resolveDisplayName: () => string,
    names: string[],
    profile?: ProtocolProfile
  ) {
    this.profile = profile ?? profileFor("1.8.9");
    this.resolveOptions = resolveOptions;
    this.resolveDisplayName = resolveDisplayName;
    this.names = names.filter((n) => typeof n === "string" && n.length > 0);

    const configured = this.resolveDisplayName();
    if (configured.length > LIMIT.playerName && this.resolveOptions().enabled) {
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

  /** 纯字符串替换：换完按字段上限截断 */
  private replacePlain(text: unknown, displayName: string, max: number): string | null {
    if (typeof text !== "string" || !text) return null;
    let out = text;
    for (const name of this.names) {
      if (out.includes(name)) out = out.split(name).join(displayName);
    }
    if (out === text) return null;
    return clampTo(out, max);
  }

  /**
   * JSON 聊天组件替换：解析 → 只改文本节点 → 重新序列化。
   * 放不下时先把名字按剩余空间截短再试，仍然放不下才放弃该字段（返回 null），
   * 绝不截断 JSON 本身。
   */
  private replaceComponent(jsonText: unknown, displayName: string, max: number): string | null {
    if (typeof jsonText !== "string" || !jsonText) return null;

    if (!looksLikeJson(jsonText)) {
      // 极少数服务器在这里放纯文本
      return this.replacePlain(jsonText, displayName, max);
    }

    const attempt = (name: string): string | null => {
      let parsed: any;
      try {
        parsed = JSON.parse(jsonText);
      } catch {
        // 原包本身不是合法 JSON：原样不动
        return null;
      }
      if (!this.walkComponent(parsed, name)) return null;
      try {
        return JSON.stringify(parsed);
      } catch {
        return null;
      }
    };

    const full = attempt(displayName);
    if (full === null) return null;
    if (full.length <= max) return full;

    // 放不下：逐步缩短名字，直到能塞进字段上限
    for (let length = displayName.length - 1; length >= 1; length--) {
      const shortened = displayName.slice(0, length);
      if (shortened === displayName) continue;
      const candidate = attempt(shortened);
      if (candidate !== null && candidate.length <= max) return candidate;
    }

    this.warnOnce(
      `Rewritten component does not fit the ${max}-char field even after shortening the name; keeping the original.`
    );
    return null;
  }

  /** 递归替换组件里的文本；返回是否发生改动 */
  private walkComponent(node: any, displayName: string): boolean {
    if (node === null || typeof node !== "object") return false;
    let changed = false;

    if (Array.isArray(node)) {
      for (const item of node) {
        if (this.walkComponent(item, displayName)) changed = true;
      }
      return changed;
    }

    for (const key of Object.keys(node)) {
      const value = node[key];
      if (COMPONENT_TEXT_KEYS.has(key) && typeof value === "string") {
        let out = value;
        for (const name of this.names) {
          if (out.includes(name)) out = out.split(name).join(displayName);
        }
        if (out !== value) {
          node[key] = out;
          changed = true;
        }
      } else if (key === "extra" || key === "with") {
        if (this.walkComponent(value, displayName)) changed = true;
      }
    }
    return changed;
  }

  /** 改写后的 params 里凡是"看起来像 JSON"的字符串都必须能解析，否则视为危险 */
  private allJsonFieldsValid(value: unknown, depth = 0): boolean {
    if (depth > 6) return true;
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return true;
      try {
        JSON.parse(trimmed);
        return true;
      } catch {
        return false;
      }
    }
    if (Array.isArray(value)) return value.every((item) => this.allJsonFieldsValid(item, depth + 1));
    if (value && typeof value === "object") {
      return Object.values(value as Record<string, unknown>).every((item) =>
        this.allJsonFieldsValid(item, depth + 1)
      );
    }
    return true;
  }

  private warnOnce(message: string): void {
    if (this.warned) return;
    this.warned = true;
    this.logger.warn(message);
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
    const ids = this.profile.ids;
    if (
      packetId !== ids.chat &&
      packetId !== ids.playerInfo &&
      packetId !== ids.objective &&
      packetId !== ids.score &&
      packetId !== ids.team
    ) {
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
      this.warnOnce(`Rewrite failed, forwarding untouched: ${(err as Error).message}`);
      return data;
    }
    if (!changed) return data;

    // 兜底：任何被改写的 JSON 字段只要解析不了，就整包放弃改写
    if (!this.allJsonFieldsValid(params)) {
      this.warnOnce("Rewritten packet would contain invalid JSON, forwarding untouched.");
      return data;
    }

    let buffer: Buffer;
    try {
      buffer = this.serializer.createPacketBuffer({ name: packetName, params });
    } catch (err) {
      this.warnOnce(`Re-encode failed, forwarding untouched: ${(err as Error).message}`);
      return data;
    }

    // 兜底：重新编码的包异常膨胀就丢弃改写
    if (buffer.length > data.length + 512) {
      this.warnOnce("Rewrite produced an oversized packet, forwarding untouched.");
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
        // 玩家列表的 name 是纯字符串，上限 16
        const replaced = this.replacePlain(entry?.name, listName, LIMIT.playerName);
        if (replaced !== null) {
          entry.name = replaced;
          changed = true;
        }
        // displayName 是 JSON 聊天组件（不是纯字符串），上限宽松；绝不能按名字长度截断
        const display = this.replaceComponent(entry?.displayName, displayName, LIMIT.chat);
        if (display !== null) {
          entry.displayName = display;
          changed = true;
        }
      }
      return changed;
    }

    if (packetName === CHAT_PACKET) {
      const replaced = this.replaceComponent(params.message, displayName, LIMIT.chat);
      if (replaced !== null) {
        params.message = replaced;
        changed = true;
      }
      return changed;
    }

    if (packetName === "scoreboard_score") {
      // itemName / entityName 都是纯字符串
      for (const key of ["itemName", "entityName", "scoreName"] as const) {
        if (typeof params[key] !== "string") continue;
        const replaced = this.replacePlain(params[key], displayName, LIMIT.scoreEntity);
        if (replaced !== null) {
          params[key] = replaced;
          changed = true;
        }
      }
      return changed;
    }

    if (packetName === "scoreboard_objective") {
      const replaced = this.replaceComponent(params.displayText, displayName, LIMIT.objectiveDisplay);
      if (replaced !== null) {
        params.displayText = replaced;
        changed = true;
      }
      return changed;
    }

    if (packetName === "scoreboard_team" || packetName === "teams") {
      // 注意 1.8 的字段含义：team = 内部队伍 ID（纯字符串，不动），
      // name = 客户端显示的队伍名（JSON 组件，上限 32）。
      const componentFields: Array<[string, number]> = [
        ["name", LIMIT.teamDisplay],
        ["displayName", LIMIT.teamDisplay],
        ["prefix", LIMIT.teamPrefix],
        ["suffix", LIMIT.teamSuffix],
      ];
      for (const [key, max] of componentFields) {
        const replaced = this.replaceComponent(params[key], displayName, max);
        if (replaced !== null) {
          params[key] = replaced;
          changed = true;
        }
      }

      const players: unknown = params.players;
      if (Array.isArray(players)) {
        for (let i = 0; i < players.length; i++) {
          const replaced = this.replacePlain(players[i], displayName, LIMIT.scoreEntity);
          if (replaced !== null) {
            players[i] = replaced;
            changed = true;
          }
        }
      }
      return changed;
    }

    return false;
  }
}
