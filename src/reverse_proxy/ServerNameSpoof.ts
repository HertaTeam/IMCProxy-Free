import mcp from "minecraft-protocol";
import { Logger } from "../logger.js";

const { createDeserializer, createSerializer, states } = mcp;

/**
 * 服务器名伪装：把服务端发给客户端的文字里出现的指定词（默认 "imc"）
 * 替换成自定义词（默认 "heypixel"）。
 *
 * 处理位置（服务端 → 客户端方向）：
 *   - 聊天栏        chat (0x02)
 *   - Tab 头部/尾部 player_list_header_footer (0x47)
 *   - 计分板        scoreboard_objective / scoreboard_score / scoreboard_team (0x3B/0x3C/0x3E)
 *   - 标题          title (0x45)
 *   - 服务器品牌    custom_payload "MC|Brand" (0x3F)
 *
 * 只改本地显示，发给服务器的一个字节都不动。
 */

export interface ServerNameMapping {
  from: string;
  to: string;
}

export interface ServerNameSpoofOptions {
  enabled: boolean;
  /** 替换规则，按顺序执行 */
  mappings: ServerNameMapping[];
  /** 是否忽略大小写 */
  caseInsensitive: boolean;
  targets: {
    chat: boolean;
    tab: boolean;
    scoreboard: boolean;
    title: boolean;
    brand: boolean;
  };
}

export const DEFAULT_SERVER_NAME_SPOOF: ServerNameSpoofOptions = {
  enabled: true,
  mappings: [{ from: "imc", to: "heypixel" }],
  caseInsensitive: true,
  targets: { chat: true, tab: true, scoreboard: true, title: true, brand: true },
};

/** 允许在 JSON 聊天组件里被替换的字段名 */
const TEXT_KEYS = new Set(["text", "displayName", "prefix", "suffix", "itemName", "header", "footer"]);

export class ServerNameSpoofer {
  private logger = new Logger("ServerName");
  private deserializer = createDeserializer({
    state: states.PLAY,
    isServer: false, // -> toClient
    version: "1.8.9",
    customPackets: null,
    noErrorLogging: true,
  } as any);
  private serializer = createSerializer({
    state: states.PLAY,
    isServer: true, // -> toClient
    version: "1.8.9",
    customPackets: null,
  });
  private warned = false;

  constructor(private readonly resolveOptions: () => ServerNameSpoofOptions) {}

  isEnabled(): boolean {
    const options = this.resolveOptions();
    if (!options.enabled) return false;
    return options.mappings.some((m) => m.from && m.to && m.from !== m.to);
  }

  /** 纯文本替换（大小写可选） */
  replaceText(text: string): string {
    const options = this.resolveOptions();
    let out = text;
    for (const mapping of options.mappings) {
      if (!mapping.from || !mapping.to || mapping.from === mapping.to) continue;
      if (options.caseInsensitive) {
        // 用拆分/拼接避免正则元字符问题
        const pattern = mapping.from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        out = out.replace(new RegExp(pattern, "gi"), mapping.to);
      } else {
        out = out.split(mapping.from).join(mapping.to);
      }
    }
    return out;
  }

  /** 递归替换聊天组件 JSON 里的文本字段 */
  private replaceComponent(json: unknown): unknown {
    if (typeof json === "string") {
      const trimmed = json.trim();
      if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return this.replaceText(json);
      try {
        const parsed = JSON.parse(trimmed);
        const replaced = this.walkComponent(parsed);
        return JSON.stringify(replaced);
      } catch {
        return this.replaceText(json);
      }
    }
    return json;
  }

  private walkComponent(node: any): any {
    if (node === null || typeof node !== "object") return node;
    if (Array.isArray(node)) return node.map((item) => this.walkComponent(item));
    const out: any = {};
    for (const [key, value] of Object.entries(node)) {
      if (TEXT_KEYS.has(key) && typeof value === "string") {
        out[key] = this.replaceText(value);
      } else if (key === "extra" || key === "with" || key === "value") {
        out[key] = this.walkComponent(value);
      } else {
        out[key] = value;
      }
    }
    return out;
  }

  /** 服务端 → 客户端封包入口；不需要改写时原样返回 */
  rewrite(data: Buffer): Buffer {
    if (!this.isEnabled()) return data;

    const packetId = data[0];
    const options = this.resolveOptions();
    const isBrand = packetId === 0x3f;

    const wanted =
      (packetId === 0x02 && options.targets.chat) ||
      (packetId === 0x47 && options.targets.tab) ||
      ((packetId === 0x3b || packetId === 0x3c || packetId === 0x3e) && options.targets.scoreboard) ||
      (packetId === 0x45 && options.targets.title) ||
      (isBrand && options.targets.brand);
    if (!wanted) return data;

    let parsed: any;
    try {
      parsed = this.deserializer.parsePacketBuffer(data);
    } catch {
      return data;
    }
    const packetName: string | undefined = parsed?.data?.name;
    const params: any = parsed?.data?.params;
    if (!packetName || !params) return data;

    let changed = false;
    try {
      changed = this.apply(packetName, params);
    } catch (err) {
      if (!this.warned) {
        this.warned = true;
        this.logger.warn(`Rewrite failed, forwarding untouched: ${(err as Error).message}`);
      }
      return data;
    }
    if (!changed) return data;

    try {
      return this.serializer.createPacketBuffer({ name: packetName, params });
    } catch (err) {
      if (!this.warned) {
        this.warned = true;
        this.logger.warn(`Re-encode failed, forwarding untouched: ${(err as Error).message}`);
      }
      return data;
    }
  }

  private apply(packetName: string, params: any): boolean {
    switch (packetName) {
      case "chat": {
        const before = params.message;
        const after = this.replaceComponent(before);
        if (after !== before) {
          params.message = after;
          return true;
        }
        return false;
      }
      case "playerlist_header":
      case "player_list_header_footer": {
        let changed = false;
        for (const key of ["header", "footer"] as const) {
          if (typeof params[key] === "string") {
            const after = this.replaceComponent(params[key]);
            if (after !== params[key]) {
              params[key] = after;
              changed = true;
            }
          }
        }
        return changed;
      }
      case "title": {
        // action 0 = title, 1 = subtitle；其余是时间/清除，不含文本
        if (params.action !== 0 && params.action !== 1) return false;
        if (typeof params.text !== "string") return false;
        const after = this.replaceComponent(params.text);
        if (after === params.text) return false;
        params.text = after;
        return true;
      }
      case "scoreboard_objective": {
        let changed = false;
        for (const key of ["displayText", "value"] as const) {
          if (typeof params[key] === "string") {
            const after = this.replaceComponent(params[key]);
            if (after !== params[key]) {
              params[key] = after;
              changed = true;
            }
          }
        }
        return changed;
      }
      case "scoreboard_score": {
        let changed = false;
        for (const key of ["itemName", "entityName"] as const) {
          if (typeof params[key] === "string") {
            const after = this.replaceText(params[key]);
            if (after !== params[key]) {
              params[key] = after;
              changed = true;
            }
          }
        }
        return changed;
      }
      case "scoreboard_team": {
        let changed = false;
        for (const key of ["displayName", "prefix", "suffix"] as const) {
          if (typeof params[key] === "string") {
            const after = this.replaceComponent(params[key]);
            if (after !== params[key]) {
              params[key] = after;
              changed = true;
            }
          }
        }
        return changed;
      }
      case "custom_payload": {
        if (params.channel !== "MC|Brand" && params.channel !== "minecraft:brand") return false;
        const payload = params.data;
        if (!Buffer.isBuffer(payload)) return false;
        const text = payload.toString("utf8");
        const after = this.replaceText(text);
        if (after === text) return false;
        const encoded = Buffer.from(after, "utf8");
        // 1.8 的 MC|Brand 是 VarInt 长度 + 字符串，这里保持原来的长度前缀形式
        params.data = Buffer.concat([Buffer.from([encoded.length]), encoded]);
        return true;
      }
      default:
        return false;
    }
  }
}
