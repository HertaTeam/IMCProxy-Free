import fs from "node:fs";
import path from "node:path";
import { ReverseProxyConfig } from "./ReverseProxy.js";
import { parseRandomIdMode, normalizeRandomIdLength } from "./RandomId.js";
import { Logger } from "../logger.js";
import { backupFile } from "./Backup.js";

const logger = new Logger("Config");



export interface ConsoleConfig {

  autoHelp: boolean;

  autoStatus: boolean;

  echo: boolean;
}


export interface AnnounceConfig {

  enabled: boolean;

  intervalMs: number;

  console: boolean;

  inGameChat: boolean;
}


export interface UpdateCheckConfig {
  enabled: boolean;

  repo: string;

  timeoutMs: number;

  notifyInGame: boolean;
}

export interface RandomIdConfig {

  auto: boolean;
  mode: "off" | "startup" | "perConnection";
  length: number;
}


export interface AutomationConfig {
  enabled: boolean;

  gameAccountFile: string;

  gameAccountsFile: string;

  defaultGamePassword: string;

  inGameReplies: boolean;

  autoLoginOnJoin: boolean;

  autoRegisterOnJoin: boolean;
}


export interface NameProtectConfig {
  enabled: boolean;

  name: string;
  playlist: boolean;
  chat: boolean;
  scoreboard: boolean;
}

export interface FileConfig {
  tcpHost?: string;
  tcpPort?: number;

  tcpPort1122?: number;

  enable1122?: boolean;
  eaglerServer?: string;

  eaglerOrigin?: string;

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
  overlay?: Partial<OverlayConfig>;
}



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


export interface OverlayConfig {
  enabled: boolean;

  mode: "auto" | "bedwars" | "off";
  apiBase: string;
  refreshSeconds: number;
  topRows: number;
  decorateTab: boolean;
  timeoutMs: number;
}

export const DEFAULT_OVERLAY_CONFIG: OverlayConfig = {
  enabled: true,
  mode: "auto",
  apiBase: "https://api.imc.re",
  refreshSeconds: 300,
  topRows: 10,
  decorateTab: true,
  timeoutMs: 6000,
};


export interface ServerNameSpoofConfig {
  enabled: boolean;

  mappings: Array<{ from: string; to: string }>;

  caseInsensitive: boolean;
  targets: { chat: boolean; tab: boolean; scoreboard: boolean; title: boolean; brand: boolean };
}

export const DEFAULT_SERVER_NAME_SPOOF: ServerNameSpoofConfig = {
  enabled: true,
  caseInsensitive: true,
  mappings: [{ from: "imc", to: "heypixel" }],
  targets: { chat: true, tab: true, scoreboard: true, title: true, brand: true },
};





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

  "overlay": {
    "enabled": true,
    "mode": "auto",
    "apiBase": "https://api.imc.re",
    "refreshSeconds": 300,
    "topRows": 10,
    "decorateTab": true,
    "timeoutMs": 6000
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



function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}


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

    }
  }
  return text;
}



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
      if (/^\s*\}/.test(lines[i])) break;
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

    backupFile(file);
    fs.writeFileSync(file, lines.join("\n"), "utf8");
  } catch (err) {
    return { ok: false, message: `Cannot write ${file}: ${(err as Error).message}` };
  }

  resetConfigCache();
  return { ok: true, message: `${keyPath} = ${formatted}` };
}


export function getConfigValue(keyPath: string): unknown {
  const config = loadFileConfig() as Record<string, unknown>;
  return keyPath.split(".").reduce<unknown>((acc, part) => {
    if (acc && typeof acc === "object") return (acc as Record<string, unknown>)[part];
    return undefined;
  }, config);
}


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


export function resetConfigCache(): void {
  cachedFileConfig = null;
}



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



export function getOverlayConfig(): OverlayConfig {
  const file = loadFileConfig().overlay ?? {};
  const mode = file.mode === "bedwars" || file.mode === "off" ? file.mode : "auto";
  const refresh = Number(file.refreshSeconds ?? DEFAULT_OVERLAY_CONFIG.refreshSeconds);
  const rows = Number(file.topRows ?? DEFAULT_OVERLAY_CONFIG.topRows);
  return {
    enabled: file.enabled ?? DEFAULT_OVERLAY_CONFIG.enabled,
    mode,
    apiBase: (file.apiBase || DEFAULT_OVERLAY_CONFIG.apiBase).trim(),
    refreshSeconds: Number.isFinite(refresh) && refresh >= 30 ? refresh : DEFAULT_OVERLAY_CONFIG.refreshSeconds,
    topRows: Number.isFinite(rows) && rows > 0 && rows <= 20 ? Math.floor(rows) : DEFAULT_OVERLAY_CONFIG.topRows,
    decorateTab: file.decorateTab ?? DEFAULT_OVERLAY_CONFIG.decorateTab,
    timeoutMs: Number(file.timeoutMs ?? DEFAULT_OVERLAY_CONFIG.timeoutMs) || DEFAULT_OVERLAY_CONFIG.timeoutMs,
  };
}


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


export function getConfig(): ReverseProxyConfig {
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
    overlay: getOverlayConfig(),
  };
}



export type ConfigChangeListener = (keyPath: string, value: unknown) => void;

const configChangeListeners = new Set<ConfigChangeListener>();


export function onConfigChange(listener: ConfigChangeListener): () => void {
  configChangeListeners.add(listener);
  return () => configChangeListeners.delete(listener);
}


export function notifyConfigChange(keyPath: string, value: unknown): void {
  for (const listener of configChangeListeners) {
    try {
      listener(keyPath, value);
    } catch {

    }
  }
}


export function isHotConfigKey(keyPath: string): boolean {
  return (
    keyPath === "debug" ||
    keyPath.startsWith("nameProtect") ||
    keyPath.startsWith("serverNameSpoof") ||
    keyPath.startsWith("announce")
  );
}



export function applyConfigValue(keyPath: string, value: unknown): { ok: boolean; message: string } {
  const result = setConfigValue(keyPath, value);
  if (result.ok) notifyConfigChange(keyPath, value);
  return result;
}
