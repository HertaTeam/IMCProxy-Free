import fs from "node:fs";
import path from "node:path";
import { Logger } from "../logger.js";

export const BACKUP_DIR_NAME = "backup";

const MAX_PER_FILE = 20;

const logger = new Logger("Backup");

export function resolveFromCwd(file: string): string {
  return path.isAbsolute(file) ? file : path.resolve(process.cwd(), file);
}

export function backupDir(): string {
  return path.resolve(process.cwd(), BACKUP_DIR_NAME);
}

const README = `This folder holds local backups (config + credentials).

- It is listed in .gitignore, so nothing here is ever committed.
- Files named \`<name>-<timestamp>.<ext>\` are automatic backups taken before
  a change (e.g. /config set rewrites config.json).
- Folders named \`<timestamp>[-label]/\` are manual snapshots taken by /backup.
- Only the newest ${MAX_PER_FILE} automatic backups per file are kept.

Safe to delete at any time.
`;

export function ensureBackupDir(): string {
  const dir = backupDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
    const readme = path.join(dir, "README.txt");
    if (!fs.existsSync(readme)) fs.writeFileSync(readme, README, "utf8");
  } catch (err) {
    logger.warn(`Cannot create ${dir}: ${(err as Error).message}`);
  }
  return dir;
}

export function timestamp(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

function prune(dir: string, baseName: string, ext: string): void {
  try {
    const stale = fs
      .readdirSync(dir)
      .filter((name) => name.startsWith(`${baseName}-`) && name.endsWith(ext))
      .map((name) => ({ name, time: fs.statSync(path.join(dir, name)).mtimeMs }))
      .sort((a, b) => b.time - a.time)
      .slice(MAX_PER_FILE);

    for (const item of stale) fs.rmSync(path.join(dir, item.name), { force: true });
  } catch {

  }
}

export function backupFile(file: string, subdir = ""): string | null {
  const source = resolveFromCwd(file);
  if (!fs.existsSync(source) || !fs.statSync(source).isFile()) return null;

  const dir = subdir ? path.join(ensureBackupDir(), subdir) : ensureBackupDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
    const ext = path.extname(source);
    const base = path.basename(source, ext);
    const dest = path.join(dir, `${base}-${timestamp()}${ext}`);
    fs.copyFileSync(source, dest);
    prune(dir, base, ext);
    return dest;
  } catch (err) {
    logger.warn(`Cannot back up ${source}: ${(err as Error).message}`);
    return null;
  }
}

export function backupFiles(files: string[], label = ""): string | null {
  const existing = files.map(resolveFromCwd).filter((f) => fs.existsSync(f) && fs.statSync(f).isFile());
  if (existing.length === 0) return null;

  const dir = path.join(ensureBackupDir(), label ? `${timestamp()}-${label}` : timestamp());
  try {
    fs.mkdirSync(dir, { recursive: true });
    for (const file of existing) {
      fs.copyFileSync(file, path.join(dir, path.basename(file)));
    }
    return dir;
  } catch (err) {
    logger.warn(`Cannot create backup snapshot: ${(err as Error).message}`);
    return null;
  }
}

export interface BackupEntry {
  name: string;
  isDirectory: boolean;
  files: number;
  bytes: number;
  modified: Date;
}

function measure(dir: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  const walk = (current: string) => {
    let children: fs.Dirent[];
    try {
      children = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const child of children) {
      const full = path.join(current, child.name);
      if (child.isDirectory()) {
        walk(full);
      } else {
        try {
          files++;
          bytes += fs.statSync(full).size;
        } catch {

        }
      }
    }
  };
  walk(dir);
  return { files, bytes };
}

export function listBackups(limit = 30): BackupEntry[] {
  const dir = backupDir();
  if (!fs.existsSync(dir)) return [];

  const entries: BackupEntry[] = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    try {
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        const { files, bytes } = measure(full);
        entries.push({ name, isDirectory: true, files, bytes, modified: stat.mtime });
      } else {
        entries.push({ name, isDirectory: false, files: 1, bytes: stat.size, modified: stat.mtime });
      }
    } catch {

    }
  }

  return entries.sort((a, b) => b.modified.getTime() - a.modified.getTime()).slice(0, limit);
}

export function defaultBackupTargets(): string[] {
  return ["config.json", "config.local.json", "game-account.txt"];
}
