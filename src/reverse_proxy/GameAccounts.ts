import fs from "node:fs";
import path from "node:path";
import { Logger } from "../logger.js";

const logger = new Logger("GameAccount");

export const DEFAULT_GAME_ACCOUNTS_FILE = "game-accounts.txt";

export interface GameAccount {

  account: string;

  password: string;

  note?: string;

  line?: number;
}

function resolveFile(file?: string): string {
  return path.resolve(process.cwd(), file && file.trim() ? file.trim() : DEFAULT_GAME_ACCOUNTS_FILE);
}

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

export function parseAccountIndex(ref: string): number | null {
  const match = ref.trim().match(/^#?(\d+)$/);
  if (!match) return null;
  const index = parseInt(match[1], 10);
  return Number.isFinite(index) && index >= 1 ? index : null;
}

export function resolveGameAccountRef(accounts: GameAccount[], ref: string): GameAccount | null {
  const trimmed = ref.trim();
  if (!trimmed) return null;
  const index = parseAccountIndex(trimmed);
  if (index !== null) return accounts[index - 1] ?? null;
  const lower = trimmed.toLowerCase();
  return accounts.find((a) => a.account.toLowerCase() === lower) ?? null;
}

export function removeGameAccount(accounts: GameAccount[], ref: string): { removed: GameAccount | null; rest: GameAccount[] } {
  const target = resolveGameAccountRef(accounts, ref);
  if (!target) return { removed: null, rest: accounts };
  const rest = accounts.filter((a) => a !== target);
  return { removed: target, rest };
}

export function describeGameAccounts(accounts: GameAccount[]): string[] {
  return accounts.map((account, i) => {
    const note = account.note ? `  # ${account.note}` : "";
    return `#${i + 1}  ${account.account}  ${account.password}${note}`;
  });
}
