import fs from "node:fs";
import path from "node:path";
import { Logger } from "../logger.js";

/**
 * 极简 key=value 文本存储（带 # 注释）。
 *
 * 存的是账号密码，等同于凭据 —— 这些文件都在 .gitignore 里，不要提交。
 */

export interface GameAccount {
  username: string;
  password: string;
  savedAt?: string;
}

const logger = new Logger("AutoFiles");

function resolve(file: string): string {
  return path.isAbsolute(file) ? file : path.resolve(process.cwd(), file);
}

export function readKeyValue(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  const full = resolve(file);
  if (!fs.existsSync(full)) return out;

  try {
    for (const line of fs.readFileSync(full, "utf8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
  } catch (err) {
    logger.warn(`Cannot read ${full}: ${(err as Error).message}`);
  }
  return out;
}

export function writeKeyValue(file: string, header: string[], data: Record<string, string>): void {
  const full = resolve(file);
  const lines = [
    ...header.map((h) => (h.startsWith("#") ? h : `# ${h}`)),
    "",
    ...Object.entries(data).map(([k, v]) => `${k}=${v}`),
    "",
  ];
  try {
    fs.writeFileSync(full, lines.join("\n"), { mode: 0o600 });
  } catch (err) {
    logger.warn(`Cannot write ${full}: ${(err as Error).message}`);
  }
}

export function fileExists(file: string): boolean {
  return fs.existsSync(resolve(file));
}

export function filePath(file: string): string {
  return resolve(file);
}

/* ---------------------------------------------------------- 游戏账号 */

export function loadGameAccount(file: string): GameAccount | null {
  const kv = readKeyValue(file);
  if (!kv.username || !kv.password) return null;
  return { username: kv.username, password: kv.password, savedAt: kv.savedAt };
}

export function saveGameAccount(file: string, account: GameAccount): void {
  writeKeyValue(file, [
    "Minecraft in-game account (written automatically by /autoreg)",
    "WARNING: this is a credential, do not commit it to a public repository",
  ], {
    username: account.username,
    password: account.password,
    savedAt: account.savedAt ?? new Date().toISOString(),
  });
}
