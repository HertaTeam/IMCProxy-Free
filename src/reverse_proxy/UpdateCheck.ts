/**
 * 更新提示（只提示，不自动更新）。
 *
 * 本地 `version.json` 记录两样东西：
 *   editDate  —— 本版本的编辑日期（用来和 GitHub 上比）
 *   count     —— 当日启动次数（跨天自动清零）
 *
 * 启动时若开启了 updateCheck，就去 GitHub 取同名文件，
 * 两个 editDate 不一致就提示更新。取不到（断网 / 仓库没有该文件）就静默跳过，
 * 只把状态记成 "unknown"，不影响正常使用。全程只读远端，不会下载或替换任何文件。
 */
import fs from "node:fs";
import path from "node:path";
import { Logger, color } from "../logger.js";

const logger = new Logger("Update");

export const VERSION_FILE = "version.json";

export interface VersionState {
  /** 本版本的编辑日期，格式 YYYY-MM-DD */
  editDate: string;
  /** 当日启动次数 */
  count: number;
  /** count 对应的日期；跨天时 count 归零 */
  countDate: string;
  /** 最近一次检查时间（ISO） */
  lastCheck?: string;
  /** 最近一次取到的远端编辑日期 */
  remoteEditDate?: string;
}

export interface UpdateCheckConfig {
  enabled: boolean;
  /** GitHub 仓库：owner/repo */
  repo: string;
  /** 单次请求超时（毫秒） */
  timeoutMs: number;
  /** 发现新版本时是否也推到游戏内聊天栏 */
  notifyInGame: boolean;
}

export const DEFAULT_UPDATE_CHECK: UpdateCheckConfig = {
  enabled: true,
  repo: "HertaTeam/IMCProxy-Free",
  timeoutMs: 6000,
  notifyInGame: true,
};

export type UpdateStatus = "up-to-date" | "outdated" | "unknown";

export interface UpdateResult {
  status: UpdateStatus;
  localDate: string;
  remoteDate?: string;
  /** 当日启动次数 */
  count: number;
  message: string;
}

function statePath(): string {
  return path.resolve(process.cwd(), VERSION_FILE);
}

function today(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function loadVersionState(): VersionState {
  const fallback: VersionState = { editDate: today(), count: 0, countDate: today() };
  try {
    const raw = fs.readFileSync(statePath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<VersionState>;
    return {
      editDate: typeof parsed.editDate === "string" ? parsed.editDate : fallback.editDate,
      count: typeof parsed.count === "number" && Number.isFinite(parsed.count) ? parsed.count : 0,
      countDate: typeof parsed.countDate === "string" ? parsed.countDate : fallback.countDate,
      lastCheck: parsed.lastCheck,
      remoteEditDate: parsed.remoteEditDate,
    };
  } catch {
    return fallback;
  }
}

export function saveVersionState(state: VersionState): void {
  try {
    fs.writeFileSync(statePath(), JSON.stringify(state, null, 2) + "\n", "utf8");
  } catch (err) {
    logger.debug(`cannot write ${VERSION_FILE}: ${(err as Error).message}`);
  }
}

/** 当日启动次数 +1（跨天清零），并写回文件 */
export function bumpDailyCount(): VersionState {
  const state = loadVersionState();
  const now = today();
  if (state.countDate !== now) {
    state.countDate = now;
    state.count = 0;
  }
  state.count += 1;
  saveVersionState(state);
  return state;
}

/** 从 GitHub 取远端的 version.json；失败返回 null（静默跳过） */
async function fetchRemoteState(config: UpdateCheckConfig): Promise<VersionState | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, config.timeoutMs));
  const fetchFn = (globalThis as any).fetch as typeof fetch | undefined;
  if (!fetchFn) {
    clearTimeout(timer);
    return null;
  }

  // 先走 API（部分网络下 raw.githubusercontent 不通），再退回 raw
  const endpoints = [
    `https://api.github.com/repos/${config.repo}/contents/${VERSION_FILE}`,
    `https://raw.githubusercontent.com/${config.repo}/master/${VERSION_FILE}`,
    `https://raw.githubusercontent.com/${config.repo}/main/${VERSION_FILE}`,
  ];

  try {
    for (const url of endpoints) {
      try {
        const res = await fetchFn(url, {
          signal: controller.signal,
          headers: {
            "User-Agent": "IMCProxy-Free-VersionCheck",
            Accept: "application/vnd.github+json, application/json, */*",
          },
        });
        if (!res.ok) continue;
        const text = await res.text();
        // API 返回 { content: base64 }，raw 直接是文件内容
        let body = text;
        try {
          const json = JSON.parse(text);
          if (json && typeof json.content === "string" && json.encoding === "base64") {
            body = Buffer.from(json.content, "base64").toString("utf8");
          }
        } catch {
          /* 不是 JSON，说明拿到的就是文件内容 */
        }
        const parsed = JSON.parse(body) as Partial<VersionState>;
        if (typeof parsed.editDate !== "string") continue;
        return {
          editDate: parsed.editDate,
          count: typeof parsed.count === "number" ? parsed.count : 0,
          countDate: typeof parsed.countDate === "string" ? parsed.countDate : parsed.editDate,
        };
      } catch (err) {
        if ((err as Error).name === "AbortError") break;
        /* 换下一个端点 */
      }
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 只比对编辑日期，不下载任何东西。
 * @param onOutdated 发现日期不一致时的回调（用于推到游戏内聊天栏）
 */
export async function checkForUpdates(
  config: UpdateCheckConfig,
  onOutdated?: (result: UpdateResult) => void
): Promise<UpdateResult> {
  const state = loadVersionState();

  if (!config.enabled) {
    return {
      status: "unknown",
      localDate: state.editDate,
      count: state.count,
      message: "Version check is disabled (config.json -> updateCheck.enabled = false).",
    };
  }

  const remote = await fetchRemoteState(config);
  const now = new Date().toISOString();

  if (!remote) {
    state.lastCheck = now;
    saveVersionState(state);
    return {
      status: "unknown",
      localDate: state.editDate,
      count: state.count,
      message: `Cannot reach github.com/${config.repo} (network issue or no ${VERSION_FILE} in the repo). Skipped.`,
    };
  }

  const differs = remote.editDate !== state.editDate;
  state.lastCheck = now;
  state.remoteEditDate = remote.editDate;
  saveVersionState(state);

  let result: UpdateResult;
  if (differs) {
    result = {
      status: "outdated",
      localDate: state.editDate,
      remoteDate: remote.editDate,
      count: state.count,
      message: `New version available: local ${state.editDate} -> remote ${remote.editDate}. Download: https://github.com/${config.repo}`,
    };
    logger.warn(color.yellow(result.message));
    onOutdated?.(result);
  } else {
    result = {
      status: "up-to-date",
      localDate: state.editDate,
      remoteDate: remote.editDate,
      count: state.count,
      message: `Already up to date (edit date ${state.editDate}, ${state.count} launch(es) today).`,
    };
    logger.info(result.message);
  }

  return result;
}

/** 统一格式，给游戏内聊天栏用 */
export function formatNotice(result: UpdateResult): string {
  if (result.status === "outdated") {
    return `§e[更新] §f发现新版本 §7(本地 ${result.localDate} → 远端 ${result.remoteDate})§f，请到 §bgithub.com/HertaTeam/IMCProxy-Free §f更新`;
  }
  if (result.status === "up-to-date") {
    return `§a[更新] §f已是最新版本 §7(${result.localDate})`;
  }
  return `§7[更新] §f暂时无法检查版本（网络问题，忽略即可）`;
}
