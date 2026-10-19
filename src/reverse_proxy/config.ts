import fs from "node:fs";
import path from "node:path";
import { ReverseProxyConfig } from "./ReverseProxy.js";
import { parseRandomIdMode, normalizeRandomIdLength } from "./RandomId.js";
import { Logger } from "../logger.js";
import { backupFile } from "./Backup.js";
import type { AntiCheatConfig } from "./anticheat/core.js";

const logger = new Logger("Config");

/* -------------------------------------------------------------- 类型 */

export interface ConsoleConfig {
  /** 启动时自动打印命令列表（/help 的内容） */
  autoHelp: boolean;
  /** 启动时自动打印一次账号状态 */
  autoStatus: boolean;
  /** true = raw 模式 + 手动回显；false = 交给终端自己回显 */
  echo: boolean;
}

export interface RandomIdConfig {
  /** false 等价于 mode: "off" */
  auto: boolean;
  mode: "off" | "startup" | "perConnection";
  length: number;
}

/** 游戏内自动化（/autoreg /autologin） */
export interface AutomationConfig {
  enabled: boolean;
  /** 游戏账号 TXT（由 /autoreg 写入） */
  gameAccountFile: string;
  /** /autoreg 不带参数时使用的默认密码；留空则必须手动输入 */
  defaultGamePassword: string;
  /** 是否允许在玩家聊天栏回复（只影响玩家主动输入的命令；自动流程永远只写控制台） */
  inGameReplies: boolean;
  /** 进服看到「请使用 /login」时自动登录 */
  autoLoginOnJoin: boolean;
  /** 进服看到「请使用 /reg」时自动注册 */
  autoRegisterOnJoin: boolean;
}

/** nameprotect：只改客户端显示，绝不发给服务器 */
export interface NameProtectConfig {
  enabled: boolean;
  /** 客户端上显示的自定义名称 */
  name: string;
  playlist: boolean;
  chat: boolean;
  scoreboard: boolean;
}

export interface FileConfig {
  tcpHost?: string;
  tcpPort?: number;
  eaglerServer?: string;
  /** 连上游时带的 Origin 头（部分服务器不带就踢人） */
  eaglerOrigin?: string;
  /** 连上游时带的浏览器 User-Agent */
  eaglerUserAgent?: string;
  maxPlayers?: number;
  defaultSkinId?: number;
  debug?: boolean;
  randomId?: Partial<RandomIdConfig> & { mode?: string };
  console?: Partial<ConsoleConfig>;
  automation?: Partial<AutomationConfig>;
  nameProtect?: Partial<NameProtectConfig>;
  antiCheat?: Partial<AntiCheatConfig>;
}

/* ------------------------------------------------------------ 默认值 */

export const DEFAULT_FILE_CONFIG: Required<Pick<FileConfig, "tcpHost" | "tcpPort" | "eaglerServer" | "eaglerOrigin" | "eaglerUserAgent" | "maxPlayers" | "defaultSkinId" | "debug">> = {
  tcpHost: "0.0.0.0",
  tcpPort: 25565,
  eaglerServer: "wss://mc.smgoro.com",
  eaglerOrigin: "https://ws.imc.re",
  eaglerUserAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  maxPlayers: 1,
  defaultSkinId: 0,
  debug: true,
};

const DEFAULT_RANDOM_ID: RandomIdConfig = { auto: true, mode: "startup", length: 8 };
const DEFAULT_CONSOLE: ConsoleConfig = { autoHelp: false, autoStatus: false, echo: true };
const DEFAULT_AUTOMATION: AutomationConfig = {
  enabled: true,
  gameAccountFile: "game-account.txt",
  defaultGamePassword: "",
  inGameReplies: true,
  autoLoginOnJoin: true,
  autoRegisterOnJoin: true,
};
const DEFAULT_NAME_PROTECT: NameProtectConfig = {
  enabled: true,
  name: "我是gay",
  playlist: true,
  chat: true,
  scoreboard: true,
};

/* -------------------------------------------------------- 文件读取 */

/** 去掉 // 与 星号块注释，但不动字符串内部的内容（支持给 config.json 写注释） */
export function stripJsonComments(input: string): string {
  let out = "";
  let inString = false;
  let inLine = false;
  let inBlock = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    const next = input[i + 1];

    if (inLine) {
      if (ch === "\n") {
        inLine = false;
        out += ch;
      }
      continue;
    }
    if (inBlock) {
      if (ch === "*" && next === "/") {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += next ?? "";
        i++;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      inLine = true;
      i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlock = true;
      i++;
      continue;
    }
    out += ch;
  }
  return out;
}

export function getConfigFilePath(): string {
  const custom = process.env.CONFIG_FILE?.trim();
  return custom ? path.resolve(process.cwd(), custom) : path.resolve(process.cwd(), "config.json");
}

/* ------------------------------------------------- 配置文件自动生成 */

/** 首次启动时写出来的默认配置（带注释）。这份文件在 .gitignore 里，不会提交。 */
export const DEFAULT_CONFIG_TEMPLATE = `{
  // ============================================================
  //  Eaglercraft Reverse Proxy - 主配置文件
  //
  //  这份文件是首次启动时自动生成的，不会提交到仓库（已在 .gitignore）。
  //  优先级：环境变量  >  本文件  >  代码内置默认值
  //  支持 // 行注释与 /* */ 块注释（不是标准 JSON，但本程序能读）
  //  路径类配置若为相对路径，按程序启动目录解析
  //
  //  也可以在线改：/config set <键> <值>     （例：/config set nameProtect.enabled false）
  //                /config get <键>
  // ============================================================

  // ---------------------------- 代理监听 ----------------------------
  "tcpHost": "0.0.0.0",              // Minecraft 客户端连接的监听地址
  "tcpPort": 25565,                  // 监听端口；被占用时改这里或设 REVERSE_PROXY_PORT
  "eaglerServer": "wss://mc.smgoro.com",  // 上游 Eaglercraft (WebSocket) 服务器
  "eaglerOrigin": "https://ws.imc.re",    // 上游校验用 Origin；不带可能被踢出
  "eaglerUserAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36", // 上游校验用浏览器 UA
  "maxPlayers": 1,                   // 同时允许几个玩家连接
  "defaultSkinId": 0,                // 默认皮肤 ID
  "debug": true,                     // 详细日志（等价于 DEBUG 环境变量）

  // ------------------------- 随机 ID（防追踪） -------------------------
  "randomId": {
    "auto": true,                    // false = 完全关闭随机 ID，直接用客户端真实 ID
    "mode": "startup",               // startup = 每次启动一个；perConnection = 每个玩家一个
    "length": 8                      // 3-16
  },

  // ---------------------------- 控制台 ----------------------------
  "console": {
    "autoHelp": false,               // 启动时自动打印命令列表（默认关，自己敲 /help）
    "autoStatus": false,             // 启动时自动打印一次账号状态
    "echo": true                     // true = 自己接管输入并回显；false = 交给终端回显
  },

  // ---------------- 反作弊（参考型：只告警，不踢人、不改包） ----------------
  // 告警同时输出到 imcp 控制台和玩家游戏内聊天栏；控制台用 /anticheat 查看。
  "antiCheat": {
    "enabled": true,
    "threshold": 1.0,                // 移动容差（方块）
    "latency": 600,                  // 延迟补偿（ms），SpeedC 用
    "vlClearTicks": 6000,            // 每多少 tick 清一次违规计数；-1 = 不清
    "alertBuffer": true,             // true = 按各检查的 buffer 累积后告警
    "experimental": false,           // 实验性检查：ReachA / MotionA / ScaffoldA
    "console": true,
    "inGameChat": true,
    "checks": {
      "AutoBlockA": true,
      "AutoClickerA": true,
      "NoSlowA": true,
      "ReachA": false,
      "BlinkA": true,
      "FlyA": true,
      "GroundSpoofA": true,
      "GroundSpoofB": true,
      "MotionA": false,
      "NoFallA": true,
      "SpeedA": true,
      "SpeedB": true,
      "SpeedC": true,
      "ScaffoldA": false,
      "ScaffoldB": true,
      "ScaffoldC": true,
      "Simulation": true
    }
  },

  // ------------------------ 游戏内自动化 ------------------------
  // 在游戏聊天栏输入的命令会被代理拦截（不发给服务器）：
  //   /autoreg [密码]            注册并把账号密码写入 TXT（省略密码则用下面的默认密码）
  //   /autologin                 读 TXT 自动 /login
  //   /autostatus                查看状态
  "automation": {
    "enabled": true,
    "gameAccountFile": "game-account.txt",   // 游戏账号（凭据！）
    "defaultGamePassword": "114514",         // /autoreg 不带参数时使用；留空则必须手动输入
    "inGameReplies": true,                   // 是否允许在游戏聊天栏回复自己敲的命令
    "autoLoginOnJoin": true,                 // 见「请使用 /login」自动登录
    "autoRegisterOnJoin": true               // 见「请使用 /reg」自动注册
  },

  // ------------------------ nameprotect ------------------------
  // 只改你客户端界面上看到的名字：玩家列表 / 聊天栏（含被提及）/ 计分板。
  // 发给服务端的封包一个字节都不动，这个设置本身也从不发给服务器或回传客户端。
  "nameProtect": {
    "enabled": true,
    "name": "我是gay",                        // 客户端上显示的自定义名称
    "playlist": true,                        // 玩家列表 / Tab
    "chat": true,                            // 聊天栏（含被提及）
    "scoreboard": true                       // 计分板
  }
}
`;

/** 配置文件不存在时自动生成一份带注释的默认配置 */
export function ensureConfigFile(): boolean {
  const file = getConfigFilePath();
  if (fs.existsSync(file)) return false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, DEFAULT_CONFIG_TEMPLATE, "utf8");
    logger.info(`Created default config: ${file}`);
    return true;
  } catch (err) {
    logger.warn(`Cannot create ${file}: ${(err as Error).message}`);
    return false;
  }
}

/* --------------------------------------------------- 在线读写配置 */

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 把 `值, // 注释` 拆开（注释判定要跳过字符串内部） */
function splitValueAndComment(rest: string): { value: string; comment: string } {
  let inString = false;
  let escaped = false;
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "/" && rest[i + 1] === "/") {
      return { value: rest.slice(0, i), comment: rest.slice(i) };
    }
  }
  return { value: rest, comment: "" };
}

function formatConfigValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null) return "null";
  return JSON.stringify(value);
}

/** 把 "true"/"false"/"123"/裸字符串 解析成合适的类型 */
export function parseConfigValue(input: string): unknown {
  const text = input.trim();
  if (text === "true") return true;
  if (text === "false") return false;
  if (text === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  if (
    (text.startsWith('"') && text.endsWith('"') && text.length >= 2) ||
    (text.startsWith("{") && text.endsWith("}")) ||
    (text.startsWith("[") && text.endsWith("]"))
  ) {
    try {
      return JSON.parse(text);
    } catch {
      /* 解析失败就当普通字符串 */
    }
  }
  return text;
}

/**
 * 就地修改配置文件里的一项，**保留所有注释与排版**。
 * 支持 `键` 与 `段.键` 两种写法。
 */
export function setConfigValue(keyPath: string, value: unknown): { ok: boolean; message: string } {
  ensureConfigFile();
  const file = getConfigFilePath();

  let lines: string[];
  try {
    lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  } catch (err) {
    return { ok: false, message: `Cannot read ${file}: ${(err as Error).message}` };
  }

  const dot = keyPath.lastIndexOf(".");
  const section = dot === -1 ? "" : keyPath.slice(0, dot);
  const key = dot === -1 ? keyPath : keyPath.slice(dot + 1);
  const keyRe = new RegExp(`^(\\s*)"${escapeRegExp(key)}"\\s*:\\s*(.*)$`);

  // 找出要改的行号
  let targetLine = -1;
  if (!section) {
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (trimmed.startsWith('"') && keyRe.test(lines[i])) {
        targetLine = i;
        break;
      }
    }
  } else {
    const sectionRe = new RegExp(`^\\s*"${escapeRegExp(section)}"\\s*:\\s*\\{`);
    let start = -1;
    for (let i = 0; i < lines.length; i++) {
      if (sectionRe.test(lines[i])) {
        start = i;
        break;
      }
    }
    if (start === -1) return { ok: false, message: `Section "${section}" not found in ${file}` };

    for (let i = start + 1; i < lines.length; i++) {
      if (/^\s*\}/.test(lines[i])) break; // 段结束
      if (keyRe.test(lines[i])) {
        targetLine = i;
        break;
      }
    }
  }

  const formatted = formatConfigValue(value);
  if (targetLine === -1) {
    return { ok: false, message: `Key "${keyPath}" not found in ${file} (only existing keys can be changed)` };
  }

  const line = lines[targetLine];
  const match = keyRe.exec(line)!;
  const indent = match[1];
  const { value: valuePart, comment } = splitValueAndComment(match[2]);
  const hadComma = valuePart.trimEnd().endsWith(",");

  lines[targetLine] =
    `${indent}"${key}": ${formatted}${hadComma ? "," : ""}` + (comment ? `  ${comment}` : "");

  try {
    // 改之前先备份到 backup/，改坏了随时能翻回来
    backupFile(file);
    fs.writeFileSync(file, lines.join("\n"), "utf8");
  } catch (err) {
    return { ok: false, message: `Cannot write ${file}: ${(err as Error).message}` };
  }

  resetConfigCache();
  return { ok: true, message: `${keyPath} = ${formatted}` };
}

/** 读取配置文件里的一项（不存在返回 undefined） */
export function getConfigValue(keyPath: string): unknown {
  const config = loadFileConfig() as Record<string, unknown>;
  return keyPath.split(".").reduce<unknown>((acc, part) => {
    if (acc && typeof acc === "object") return (acc as Record<string, unknown>)[part];
    return undefined;
  }, config);
}

/** 列出配置文件里所有可改的键（段.键 / 键） */
export function listConfigKeys(): string[] {
  const config = loadFileConfig() as Record<string, unknown>;
  const keys: string[] = [];
  for (const [k, v] of Object.entries(config)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const sub of Object.keys(v as Record<string, unknown>)) keys.push(`${k}.${sub}`);
    } else {
      keys.push(k);
    }
  }
  return keys.sort();
}

let cachedFileConfig: FileConfig | null = null;

export function loadFileConfig(force = false): FileConfig {
  if (cachedFileConfig && !force) return cachedFileConfig;

  const file = getConfigFilePath();
  if (!fs.existsSync(file)) {
    // 首次启动：自动生成一份带注释的默认配置
    ensureConfigFile();
  }
  if (!fs.existsSync(file)) {
    logger.warn(`Config file not found and could not be created: ${file} (using built-in defaults)`);
    cachedFileConfig = {};
    return cachedFileConfig;
  }

  try {
    const text = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(stripJsonComments(text));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("the top level must be a JSON object");
    }
    logger.info(`Loaded config: ${file}`);
    cachedFileConfig = parsed as FileConfig;
  } catch (err) {
    logger.error(`Cannot parse ${file}: ${(err as Error).message} (using built-in defaults)`);
    cachedFileConfig = {};
  }
  return cachedFileConfig;
}

/** 让 config.json 生效后重新读取（目前只在启动时调用一次） */
export function resetConfigCache(): void {
  cachedFileConfig = null;
}

/* -------------------------------------------------------- 环境变量 */

export function loadConfigFromEnv(): Partial<ReverseProxyConfig> {
  const envRandomIdMode = process.env.RANDOM_ID_MODE;
  const randomIdMode = parseRandomIdMode(envRandomIdMode);
  if (envRandomIdMode?.trim() && randomIdMode === undefined) {
    logger.warn(
      `RANDOM_ID_MODE="${envRandomIdMode}" is not recognized and will be ignored (valid values: off | startup | perConnection)`
    );
  }

  return {
    tcpHost: process.env.REVERSE_PROXY_HOST,
    tcpPort: process.env.REVERSE_PROXY_PORT ? parseInt(process.env.REVERSE_PROXY_PORT) : undefined,
    eaglerServer: process.env.EAGLER_SERVER_URL,
    eaglerOrigin: process.env.EAGLER_ORIGIN,
    eaglerUserAgent: process.env.EAGLER_USER_AGENT,
    maxPlayers: process.env.MAX_PLAYERS ? parseInt(process.env.MAX_PLAYERS) : undefined,
    randomIdMode,
    randomIdLength: process.env.RANDOM_ID_LENGTH ? parseInt(process.env.RANDOM_ID_LENGTH) : undefined,
    debug: process.env.DEBUG != null ? process.env.DEBUG === "true" : undefined,
  };
}

/* ------------------------------------------------------------ 合并 */

function resolvePath(value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);
}

export function getRandomIdConfig(): RandomIdConfig {
  const file = loadFileConfig().randomId ?? {};
  const modeFromFile = parseRandomIdMode(file.mode);
  const auto = file.auto ?? DEFAULT_RANDOM_ID.auto;
  return {
    auto,
    mode: auto ? modeFromFile ?? DEFAULT_RANDOM_ID.mode : "off",
    length: normalizeRandomIdLength(file.length ?? DEFAULT_RANDOM_ID.length),
  };
}

export function getConsoleConfig(): ConsoleConfig {
  const file = loadFileConfig().console ?? {};
  return {
    autoHelp: file.autoHelp ?? DEFAULT_CONSOLE.autoHelp,
    autoStatus: file.autoStatus ?? DEFAULT_CONSOLE.autoStatus,
    echo: file.echo ?? DEFAULT_CONSOLE.echo,
  };
}

export function getAutomationConfig(): AutomationConfig {
  const file = loadFileConfig().automation ?? {};
  return {
    enabled: file.enabled ?? DEFAULT_AUTOMATION.enabled,
    gameAccountFile: resolvePath(file.gameAccountFile || DEFAULT_AUTOMATION.gameAccountFile),
    defaultGamePassword: file.defaultGamePassword ?? DEFAULT_AUTOMATION.defaultGamePassword,
    inGameReplies: file.inGameReplies ?? DEFAULT_AUTOMATION.inGameReplies,
    autoLoginOnJoin: file.autoLoginOnJoin ?? DEFAULT_AUTOMATION.autoLoginOnJoin,
    autoRegisterOnJoin: file.autoRegisterOnJoin ?? DEFAULT_AUTOMATION.autoRegisterOnJoin,
  };
}

export function getNameProtectConfig(): NameProtectConfig {
  const file = loadFileConfig().nameProtect ?? {};
  return {
    enabled: file.enabled ?? DEFAULT_NAME_PROTECT.enabled,
    name: file.name ?? DEFAULT_NAME_PROTECT.name,
    playlist: file.playlist ?? DEFAULT_NAME_PROTECT.playlist,
    chat: file.chat ?? DEFAULT_NAME_PROTECT.chat,
    scoreboard: file.scoreboard ?? DEFAULT_NAME_PROTECT.scoreboard,
  };
}

/**
 * 代理配置。优先级：环境变量 > config.json > 内置默认值。
 */export function getConfig(): ReverseProxyConfig {
  const file = loadFileConfig();
  const envConfig = loadConfigFromEnv();
  const randomId = getRandomIdConfig();

  return {
    tcpHost: envConfig.tcpHost ?? file.tcpHost ?? DEFAULT_FILE_CONFIG.tcpHost,
    tcpPort: envConfig.tcpPort ?? file.tcpPort ?? DEFAULT_FILE_CONFIG.tcpPort,
    eaglerServer: envConfig.eaglerServer ?? file.eaglerServer ?? DEFAULT_FILE_CONFIG.eaglerServer,
    eaglerOrigin: envConfig.eaglerOrigin ?? file.eaglerOrigin ?? DEFAULT_FILE_CONFIG.eaglerOrigin,
    eaglerUserAgent: envConfig.eaglerUserAgent ?? file.eaglerUserAgent ?? DEFAULT_FILE_CONFIG.eaglerUserAgent,
    maxPlayers: envConfig.maxPlayers ?? file.maxPlayers ?? DEFAULT_FILE_CONFIG.maxPlayers,
    defaultSkinId: file.defaultSkinId ?? DEFAULT_FILE_CONFIG.defaultSkinId,
    randomIdMode: envConfig.randomIdMode ?? randomId.mode,
    randomIdLength: normalizeRandomIdLength(envConfig.randomIdLength ?? randomId.length),
    debug: envConfig.debug ?? file.debug ?? DEFAULT_FILE_CONFIG.debug,
    antiCheat: {
      enabled: file.antiCheat?.enabled ?? true,
      threshold: file.antiCheat?.threshold ?? 1.0,
      latency: file.antiCheat?.latency ?? 600,
      vlClearTicks: file.antiCheat?.vlClearTicks ?? 6000,
      alertBuffer: file.antiCheat?.alertBuffer ?? true,
      experimental: file.antiCheat?.experimental ?? false,
      console: file.antiCheat?.console ?? true,
      inGameChat: file.antiCheat?.inGameChat ?? true,
      checks: { ...(file.antiCheat?.checks ?? {}) },
    },
    nameProtect: getNameProtectConfig(),
  };
}
