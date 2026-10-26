/**
 * 游戏账号管理器（free 版）。
 *
 * 与 imcp 里的 imc 账号池思路一致：一个 TXT 存多组「账号 密码 [备注]」，
 * 控制台用 /gamestatus 查看、/logingame 登录、/gameadd /gamedel 维护。
 *
 * 注意：这里只存**游戏服账号**，不涉及 imc.re 的网页账号（free 版没有那套功能）。
 */
import fs from "node:fs";
import path from "node:path";
import { Logger } from "../logger.js";

const logger = new Logger("GameAccount");

export const DEFAULT_GAME_ACCOUNTS_FILE = "game-accounts.txt";

export interface GameAccount {
  /** 游戏账号（玩家名） */
  account: string;
  /** 密码（明文保存，文件已在 .gitignore） */
  password: string;
  /** 可选备注 */
  note?: string;
  /** 在文件里的行号（从 1 开始），便于定位 */
  line?: number;
}

function resolveFile(file?: string): string {
  return path.resolve(process.cwd(), file && file.trim() ? file.trim() : DEFAULT_GAME_ACCOUNTS_FILE);
}

/** 读取全部账号；文件不存在返回空数组 */
export function loadGameAccounts(file?: string): GameAccount[] {
  const target = resolveFile(file);
  let raw: string;
  try {
    raw = fs.readFileSync(target, "utf8");
  } catch {
    return [];
  }

  const accounts: GameAccount[] = [];
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;
    accounts.push({
      account: parts[0],
      password: parts[1],
      note: parts.slice(2).join(" ") || undefined,
      line: i + 1,
    });
  }
  return accounts;
}

/** 覆盖写回（保留原有头部注释） */
export function saveGameAccounts(accounts: GameAccount[], file?: string): void {
  const target = resolveFile(file);
  const header = [
    "# 游戏账号列表（凭据，勿提交）",
    "# 格式：账号 密码 [备注]",
    "# 由 /gameadd 写入，/logingame 使用",
    "",
  ].join("\n");
  const body = accounts
    .map((a) => [a.account, a.password, a.note].filter((v) => v !== undefined && v !== "").join(" "))
    .join("\n");
  try {
    fs.writeFileSync(target, header + body + (body ? "\n" : ""), "utf8");
  } catch (err) {
    logger.warn(`cannot write ${target}: ${(err as Error).message}`);
  }
}

/** 新增或更新一个账号（同名覆盖密码） */
export function upsertGameAccount(account: string, password: string, file?: string, note?: string): GameAccount[] {
  const accounts = loadGameAccounts(file);
  const existing = accounts.find((a) => a.account.toLowerCase() === account.toLowerCase());
  if (existing) {
    existing.password = password;
    if (note !== undefined) existing.note = note;
  } else {
    accounts.push({ account, password, note });
  }
  saveGameAccounts(accounts, file);
  return accounts;
}

/** 解析 "#2" / "2" 这种序号（从 1 开始） */
export function parseAccountIndex(ref: string): number | null {
  const match = ref.trim().match(/^#?(\d+)$/);
  if (!match) return null;
  const index = parseInt(match[1], 10);
  return Number.isFinite(index) && index >= 1 ? index : null;
}

/** 按引用取账号：序号 / 账号名 */
export function resolveGameAccountRef(accounts: GameAccount[], ref: string): GameAccount | null {
  const trimmed = ref.trim();
  if (!trimmed) return null;
  const index = parseAccountIndex(trimmed);
  if (index !== null) return accounts[index - 1] ?? null;
  const lower = trimmed.toLowerCase();
  return accounts.find((a) => a.account.toLowerCase() === lower) ?? null;
}

/** 删除账号：按序号或名字 */
export function removeGameAccount(accounts: GameAccount[], ref: string): { removed: GameAccount | null; rest: GameAccount[] } {
  const target = resolveGameAccountRef(accounts, ref);
  if (!target) return { removed: null, rest: accounts };
  const rest = accounts.filter((a) => a !== target);
  return { removed: target, rest };
}

/** 控制台展示用：序号 + 账号 + 密码 + 备注 */
export function describeGameAccounts(accounts: GameAccount[]): string[] {
  return accounts.map((account, i) => {
    const note = account.note ? `  # ${account.note}` : "";
    return `#${i + 1}  ${account.account}  ${account.password}${note}`;
  });
}
