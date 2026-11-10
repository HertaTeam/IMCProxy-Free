import fs from "node:fs";
import path from "node:path";
import { Logger, color } from "../logger.js";

const logger = new Logger("Update");

export const VERSION_FILE = "version.json";

export interface VersionState {

  editDate: string;

  count: number;

  countDate: string;

  lastCheck?: string;

  remoteEditDate?: string;
}

export interface UpdateCheckConfig {
  enabled: boolean;

  repo: string;

  timeoutMs: number;

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

async function fetchRemoteState(config: UpdateCheckConfig): Promise<VersionState | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, config.timeoutMs));
  const fetchFn = (globalThis as any).fetch as typeof fetch | undefined;
  if (!fetchFn) {
    clearTimeout(timer);
    return null;
  }

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

        let body = text;
        try {
          const json = JSON.parse(text);
          if (json && typeof json.content === "string" && json.encoding === "base64") {
            body = Buffer.from(json.content, "base64").toString("utf8");
          }
        } catch {

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

      }
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

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

export function formatNotice(result: UpdateResult): string {
  if (result.status === "outdated") {
    return `§e[更新] §f发现新版本 §7(本地 ${result.localDate} → 远端 ${result.remoteDate})§f，请到 §bgithub.com/HertaTeam/IMCProxy-Free §f更新`;
  }
  if (result.status === "up-to-date") {
    return `§a[更新] §f已是最新版本 §7(${result.localDate})`;
  }
  return `§7[更新] §f暂时无法检查版本（网络问题，忽略即可）`;
}
