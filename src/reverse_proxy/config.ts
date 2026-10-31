import fs from "node:fs";
import path from "node:path";
import { ReverseProxyConfig } from "./ReverseProxy.js";
import { parseRandomIdMode, normalizeRandomIdLength } from "./RandomId.js";
import { Logger } from "../logger.js";
import { backupFile } from "./Backup.js";

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

/** 公告刷屏（控制台 + 游戏内聊天栏） */
export interface AnnounceConfig {
  /** false = 完全不刷屏 */
  enabled: boolean;
  /** 刷屏间隔（毫秒），最小 1000 */
  intervalMs: number;
  /** 是否刷到控制台 */
  console: boolean;
  /** 是否刷到游戏内聊天栏 */
  inGameChat: boolean;
}

/** 启动时和 GitHub 对比版本、提示更新 */
export interface UpdateCheckConfig {
  enabled: boolean;
  /** GitHub 仓库：owner/repo */
  repo: string;
  /** 请求超时（毫秒） */
  timeoutMs: number;
  /** 发现新版本时是否也推到游戏内聊天栏 */
  notifyInGame: boolean;
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
  /** 多账号列表 TXT（/gameadd 写入，/gamestatus 查看，/logingame 使用） */
  gameAccountsFile: string;
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
  /** 1.12.2 监听端口（Eaglercraft 1.12.2 客户端） */
  tcpPort1122?: number;
  /** 是否开启 1.12.2 监听 */
  enable1122?: boolean;
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
  announce?: Partial<AnnounceConfig>;
  updateCheck?: Partial<UpdateCheckConfig>;
  automation?: Partial<AutomationConfig>;
  nameProtect?: Partial<NameProtectConfig>;
  serverNameSpoof?: Partial<ServerNameSpoofConfig>;
}

/* ------------------------------------------------------------ 默认值 */

export const DEFAULT_FILE_CONFIG: Required<Pick<FileConfig, "tcpHost" | "tcpPort" | "tcpPort1122" | "enable1122" | "eaglerServer" | "eaglerOrigin" | "eaglerUserAgent" | "maxPlayers" | "defaultSkinId" | "debug">> = {
  tcpHost: "0.0.0.0",
  tcpPort: 25565,
  tcpPort1122: 25566,
  enable1122: true,
  eaglerServer: "wss://mc.smgoro.com",
  eaglerOrigin: "https://ws.imc.re",
  eaglerUserAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  maxPlayers: 1,
  defaultSkinId: 0,
  debug: true,
};

const DEFAULT_RANDOM_ID: RandomIdConfig = { auto: true, mode: "startup", length: 8 };
const DEFAULT_CONSOLE: ConsoleConfig = { autoHelp: false, autoStatus: false, echo: true };
const DEFAULT_ANNOUNCE: AnnounceConfig = { enabled: true, intervalMs: 10000, console: true, inGameChat: true };
const DEFAULT_UPDATE_CHECK: UpdateCheckConfig = {
  enabled: true,
  repo: "HertaTeam/IMCProxy-Free",
  timeoutMs: 6000,
  notifyInGame: true,
};
const DEFAULT_AUTOMATION: AutomationConfig = {
  enabled: true,
  gameAccountFile: "game-account.txt",
  gameAccountsFile: "game-accounts.txt",
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

/** 服务器名伪装（只改客户端显示） */
export interface ServerNameSpoofConfig {
  enabled: boolean;
  /** 替换规则，按顺序执行 */
  mappings: Array<{ from: string; to: string }>;
  /** 是否忽略大小写 */
  caseInsensitive: boolean;
  targets: { chat: boolean; tab: boolean; scoreboard: boolean; title: boolean; brand: boolean };
}

export const DEFAULT_SERVER_NAME_SPOOF: ServerNameSpoofConfig = {
  enabled: true,
  caseInsensitive: true,
  mappings: [{ from: "imc", to: "heypixel" }],
  targets: { chat: true, tab: true, scoreboard: true, title: true, brand: true },
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

  "tcpHost": "0.0.0.0",
  "tcpPort": 25565,
  "tcpPort1122": 25566,
  "enable1122": true,
  "eaglerServer": "wss://mc.smgoro.com",
  "eaglerOrigin": "https://ws.imc.re",
  "eaglerUserAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  "maxPlayers": 1,
  "defaultSkinId": 0,
  "debug": true,

  "randomId": {
    "auto": true,
    "mode": "startup",
    "length": 8
  },

  "console": {
    "autoHelp": false,
    "autoStatus": false,
    "echo": true
  },

  "announce": {
    "enabled": true,
    "intervalMs": 10000,
    "console": true,
    "inGameChat": true
  },

  "updateCheck": {
    "enabled": true,
    "repo": "HertaTeam/IMCProxy-Free",
    "timeoutMs": 6000,
    "notifyInGame": true
  },

  "automation": {
    "enabled": true,
    "gameAccountFile": "game-account.txt",
    "gameAccountsFile": "game-accounts.txt",
    "defaultGamePassword": "114514",
    "inGameReplies": true,
    "autoLoginOnJoin": true,
    "autoRegisterOnJoin": true
  },

  "serverNameSpoof": {
    "enabled": true,
    "caseInsensitive": true,
    "mappings": [
      { "from": "imc", "to": "heypixel" }
    ],
    "targets": { "chat": true, "tab": true, "scoreboard": true, "title": true, "brand": true }
  },

  "nameProtect": {
    "enabled": true,
    "name": "我是gay",
    "playlist": true,
    "chat": true,
    "scoreboard": true
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

export function getAnnounceConfig(): AnnounceConfig {
  const file = loadFileConfig().announce ?? {};
  const interval = Number(file.intervalMs ?? DEFAULT_ANNOUNCE.intervalMs);
  return {
    enabled: file.enabled ?? DEFAULT_ANNOUNCE.enabled,
    intervalMs: Number.isFinite(interval) && interval >= 1000 ? interval : DEFAULT_ANNOUNCE.intervalMs,
    console: file.console ?? DEFAULT_ANNOUNCE.console,
    inGameChat: file.inGameChat ?? DEFAULT_ANNOUNCE.inGameChat,
  };
}

export function getUpdateCheckConfig(): UpdateCheckConfig {
  const file = loadFileConfig().updateCheck ?? {};
  const timeout = Number(file.timeoutMs ?? DEFAULT_UPDATE_CHECK.timeoutMs);
  return {
    enabled: file.enabled ?? DEFAULT_UPDATE_CHECK.enabled,
    repo: typeof file.repo === "string" && file.repo.includes("/") ? file.repo : DEFAULT_UPDATE_CHECK.repo,
    timeoutMs: Number.isFinite(timeout) && timeout >= 1000 ? timeout : DEFAULT_UPDATE_CHECK.timeoutMs,
    notifyInGame: file.notifyInGame ?? DEFAULT_UPDATE_CHECK.notifyInGame,
  };
}

export function getAutomationConfig(): AutomationConfig {
  const file = loadFileConfig().automation ?? {};
  return {
    enabled: file.enabled ?? DEFAULT_AUTOMATION.enabled,
    gameAccountFile: resolvePath(file.gameAccountFile || DEFAULT_AUTOMATION.gameAccountFile),
    gameAccountsFile: resolvePath(file.gameAccountsFile || DEFAULT_AUTOMATION.gameAccountsFile),
    defaultGamePassword: file.defaultGamePassword ?? DEFAULT_AUTOMATION.defaultGamePassword,
    inGameReplies: file.inGameReplies ?? DEFAULT_AUTOMATION.inGameReplies,
    autoLoginOnJoin: file.autoLoginOnJoin ?? DEFAULT_AUTOMATION.autoLoginOnJoin,
    autoRegisterOnJoin: file.autoRegisterOnJoin ?? DEFAULT_AUTOMATION.autoRegisterOnJoin,
  };
}


/** 服务器名伪装：读 config.json 的 serverNameSpoof（缺省 = imc → heypixel） */
export function getServerNameSpoofConfig(): ServerNameSpoofConfig {
  const file = loadFileConfig().serverNameSpoof ?? {};
  const rawMappings = Array.isArray(file.mappings) ? file.mappings : DEFAULT_SERVER_NAME_SPOOF.mappings;
  const mappings = rawMappings
    .filter((m: any) => m && typeof m.from === "string" && typeof m.to === "string" && m.from.length > 0)
    .map((m: any) => ({ from: String(m.from), to: String(m.to) }));
  const targets = { ...DEFAULT_SERVER_NAME_SPOOF.targets, ...(file.targets ?? {}) };
  return {
    enabled: file.enabled ?? DEFAULT_SERVER_NAME_SPOOF.enabled,
    caseInsensitive: file.caseInsensitive ?? DEFAULT_SERVER_NAME_SPOOF.caseInsensitive,
    mappings: mappings.length > 0 ? mappings : DEFAULT_SERVER_NAME_SPOOF.mappings,
    targets,
  };
}

/** 账号列表文件（/gameadd 写入的那份） */
export function getGameAccountsFile(): string {
  return getAutomationConfig().gameAccountsFile;
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
    tcpPort1122: envConfig.tcpPort1122 ?? file.tcpPort1122 ?? DEFAULT_FILE_CONFIG.tcpPort1122,
    enable1122: envConfig.enable1122 ?? file.enable1122 ?? DEFAULT_FILE_CONFIG.enable1122,
    eaglerServer: envConfig.eaglerServer ?? file.eaglerServer ?? DEFAULT_FILE_CONFIG.eaglerServer,
    eaglerOrigin: envConfig.eaglerOrigin ?? file.eaglerOrigin ?? DEFAULT_FILE_CONFIG.eaglerOrigin,
    eaglerUserAgent: envConfig.eaglerUserAgent ?? file.eaglerUserAgent ?? DEFAULT_FILE_CONFIG.eaglerUserAgent,
    maxPlayers: envConfig.maxPlayers ?? file.maxPlayers ?? DEFAULT_FILE_CONFIG.maxPlayers,
    defaultSkinId: file.defaultSkinId ?? DEFAULT_FILE_CONFIG.defaultSkinId,
    randomIdMode: envConfig.randomIdMode ?? randomId.mode,
    randomIdLength: normalizeRandomIdLength(envConfig.randomIdLength ?? randomId.length),
    debug: envConfig.debug ?? file.debug ?? DEFAULT_FILE_CONFIG.debug,
    nameProtect: getNameProtectConfig(),
    serverNameSpoof: getServerNameSpoofConfig(),
  };
}

/* ------------------------------------------------- 配置热更新 */

export type ConfigChangeListener = (keyPath: string, value: unknown) => void;

const configChangeListeners = new Set<ConfigChangeListener>();

/** 订阅配置变更；返回取消订阅的函数 */
export function onConfigChange(listener: ConfigChangeListener): () => void {
  configChangeListeners.add(listener);
  return () => configChangeListeners.delete(listener);
}

/** 通知所有订阅者 */
export function notifyConfigChange(keyPath: string, value: unknown): void {
  for (const listener of configChangeListeners) {
    try {
      listener(keyPath, value);
    } catch {
      /* 单个订阅者出错不影响其他 */
    }
  }
}

/** 改完立即生效的键（其余键仍然要重启） */
export function isHotConfigKey(keyPath: string): boolean {
  return (
    keyPath === "debug" ||
    keyPath.startsWith("nameProtect") ||
    keyPath.startsWith("serverNameSpoof") ||
    keyPath.startsWith("announce")
  );
}

/**
 * 修改配置并立即把变更推给运行时组件。
 * 写盘失败时不会通知，避免内存与文件不一致。
 */
export function applyConfigValue(keyPath: string, value: unknown): { ok: boolean; message: string } {
  const result = setConfigValue(keyPath, value);
  if (result.ok) notifyConfigChange(keyPath, value);
  return result;
}
