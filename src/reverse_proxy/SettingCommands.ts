/**
 * 配置项命令表。
 *
 * 每个配置项只对应**一个**命令（命令名 = 配置键的小写形式，例如
 * `/tcpPort`、`/overlay.mode`、`/nameProtect.name`），
 * 值在写入前先按类型校验，类型不对直接拒绝，不会把 config.json 改坏。
 */
import { getConfigValue, listConfigKeys } from "./config.js";

export type SettingType = "boolean" | "number" | "integer" | "string" | "json";

export interface SettingSpec {
  /** 原始键名，例如 tcpPort / overlay.mode */
  key: string;
  /** 命令名（小写），例如 tcpport / overlay.mode */
  command: string;
  type: SettingType;
  enum?: string[];
  min?: number;
  max?: number;
  /** 字符串长度上限 */
  maxLength?: number;
  /** 字符串必须匹配的格式说明 */
  pattern?: RegExp;
  hint?: string;
}

/** 针对具体键的额外约束（类型从当前值推断，这里补范围/枚举/格式） */
const CONSTRAINTS: Record<string, Partial<SettingSpec>> = {
  tcpHost: { hint: "监听地址，通常为 0.0.0.0" },
  tcpPort: { min: 1, max: 65535, hint: "1.8.9 监听端口" },
  tcpPort1122: { min: 1, max: 65535, hint: "1.12.2 Beta 监听端口" },
  maxPlayers: { min: 1, max: 1000 },
  defaultSkinId: { min: 0, max: 1000000 },
  eaglerServer: { pattern: /^wss?:\/\/.+/i, hint: "必须以 ws:// 或 wss:// 开头" },
  eaglerOrigin: { pattern: /^https?:\/\/.+/i, hint: "必须以 http:// 或 https:// 开头" },
  "randomId.mode": { enum: ["off", "startup", "perconnection"], hint: "off / startup / perConnection" },
  "randomId.length": { min: 3, max: 16 },
  "overlay.mode": { enum: ["auto", "bedwars", "off"] },
  "overlay.refreshSeconds": { min: 30, max: 86400 },
  "overlay.topRows": { min: 1, max: 20 },
  "overlay.timeoutMs": { min: 500, max: 60000 },
  "overlay.apiBase": { pattern: /^https?:\/\/.+/i },
  "nameProtect.name": { maxLength: 32, hint: "客户端显示名，超过 16 字符会被截断以适配玩家列表" },
  "imc.baseUrl": { pattern: /^https?:\/\/.+/i },
  "imc.browserTimeoutMs": { min: 1000, max: 3600000 },
  "announce.intervalMs": { min: 5000, max: 3600000 },
  "updateCheck.timeoutMs": { min: 1000, max: 60000 },
  "serverNameSpoof.mappings": { hint: 'JSON 数组，例如 [{"from":"imc","to":"heypixel"}]' },
  "serverNameSpoof.targets": {
    hint: 'JSON 对象，例如 {"chat":true,"tab":true,"scoreboard":true,"title":true,"brand":true}',
  },
};

/** 这些字符串允许为空（令牌、密码、路径） */
const ALLOW_EMPTY = new Set([
  "imc.apiToken",
  "automation.defaultGamePassword",
  "console.echo",
]);

function inferType(value: unknown): SettingType {
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  if (value !== null && typeof value === "object") return "json";
  return "string";
}

/** 生成全部配置项命令 */
export function buildSettingSpecs(): SettingSpec[] {
  return listConfigKeys().map((key) => {
    const value = getConfigValue(key);
    const base: SettingSpec = { key, command: key.toLowerCase(), type: inferType(value) };
    return { ...base, ...(CONSTRAINTS[key] ?? {}) };
  });
}

function parseBoolean(input: string): boolean | null {
  const value = input.trim().toLowerCase();
  if (["true", "on", "yes", "1", "enable", "enabled"].includes(value)) return true;
  if (["false", "off", "no", "0", "disable", "disabled"].includes(value)) return false;
  return null;
}

export interface ParseResult {
  ok: boolean;
  value?: unknown;
  message?: string;
}

/** 校验并转换输入值；失败时返回原因，调用方不得写配置 */
export function parseSettingValue(spec: SettingSpec, input: string): ParseResult {
  const raw = input.trim();

  if (spec.type === "boolean") {
    const parsed = parseBoolean(raw);
    if (parsed === null) return { ok: false, message: 'expected true/false (aliases: on/off, 1/0)' };
    return { ok: true, value: parsed };
  }

  if (spec.type === "integer" || spec.type === "number") {
    if (!/^-?\d+(\.\d+)?$/.test(raw)) return { ok: false, message: "expected a number" };
    const number = Number(raw);
    if (!Number.isFinite(number)) return { ok: false, message: "expected a finite number" };
    if (spec.type === "integer" && !Number.isInteger(number)) return { ok: false, message: "expected an integer" };
    if (spec.min !== undefined && number < spec.min) return { ok: false, message: `must be >= ${spec.min}` };
    if (spec.max !== undefined && number > spec.max) return { ok: false, message: `must be <= ${spec.max}` };
    return { ok: true, value: number };
  }

  if (spec.type === "json") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return { ok: false, message: `invalid JSON: ${(err as Error).message}` };
    }
    if (spec.key === "serverNameSpoof.mappings") {
      if (!Array.isArray(parsed)) return { ok: false, message: "expected a JSON array" };
      const valid = parsed.every(
        (item) =>
          item &&
          typeof item === "object" &&
          typeof (item as any).from === "string" &&
          typeof (item as any).to === "string" &&
          (item as any).from.length > 0
      );
      if (!valid) return { ok: false, message: 'each entry needs a non-empty "from" and a "to" string' };
    }
    if (spec.key === "serverNameSpoof.targets") {
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { ok: false, message: "expected a JSON object" };
      }
      const valid = Object.values(parsed as Record<string, unknown>).every((value) => typeof value === "boolean");
      if (!valid) return { ok: false, message: "every target value must be true or false" };
    }
    return { ok: true, value: parsed };
  }

  if (spec.enum) {
    const value = raw.toLowerCase();
    if (!spec.enum.includes(value)) {
      return { ok: false, message: `expected one of: ${spec.enum.join(", ")}` };
    }
    return { ok: true, value };
  }

  if (!raw && !ALLOW_EMPTY.has(spec.key)) return { ok: false, message: "value must not be empty" };
  if (spec.maxLength !== undefined && raw.length > spec.maxLength) {
    return { ok: false, message: `must be at most ${spec.maxLength} characters` };
  }
  if (spec.pattern && !spec.pattern.test(raw)) {
    return { ok: false, message: spec.hint ?? "value has an invalid format" };
  }
  return { ok: true, value: raw };
}

/** 当前值 + 约束的可读描述 */
export function describeSetting(spec: SettingSpec, value: unknown): string {
  const parts: string[] = [];
  parts.push(`type: ${spec.type}`);
  if (spec.enum) parts.push(`allowed: ${spec.enum.join(", ")}`);
  if (spec.min !== undefined || spec.max !== undefined) {
    parts.push(`range: ${spec.min ?? "-inf"} .. ${spec.max ?? "inf"}`);
  }
  if (spec.maxLength !== undefined) parts.push(`max length: ${spec.maxLength}`);
  if (spec.hint) parts.push(spec.hint);
  parts.push(`current: ${formatSettingValue(value)}`);
  return parts.join(" | ");
}

export function formatSettingValue(value: unknown): string {
  if (typeof value === "string") return value === "" ? '""' : value;
  if (value !== null && typeof value === "object") return JSON.stringify(value);
  return String(value);
}
