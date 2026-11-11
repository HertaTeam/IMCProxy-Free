import fs from "node:fs";
import path from "node:path";
import { Chalk } from "chalk";

export const color = new Chalk({ level: 2 });

let global_verbose: boolean = false;

type JsonLogType = "info" | "warn" | "error" | "fatal" | "debug";
type JsonOutput = {
  type: JsonLogType;
  message: string;
};

export function verboseLogging(newVal?: boolean) {
  global_verbose = newVal ?? !global_verbose;
}

function jsonLog(type: JsonLogType, message: string): string {
  return (
    JSON.stringify({
      type: type,
      message: message,
    }) + "\n"
  );
}

type LogLevel = JsonLogType;

const NAME_WIDTH = 12;

const LEVEL_TAG: Record<LogLevel, string> = {
  info: "INFO",
  warn: "WARN",
  error: "ERROR",
  fatal: "FATAL",
  debug: "DEBUG",
};

const LEVEL_PAINT: Record<LogLevel, (s: string) => string> = {
  info: (s) => color.green(s),
  warn: (s) => color.yellow(s),
  error: (s) => color.redBright(s),
  fatal: (s) => color.bgRed(color.white(s)),
  debug: (s) => color.gray(s),
};

function hhmmss(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const ANSI_RE = /\u001b\[[0-9;]*m/g;

let logFd: number | null = null;
let logFilePath: string | null = null;

export function getLogFilePath(): string | null {
  return logFilePath;
}

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

function pruneLogs(dir: string, keep: number): void {
  try {
    const files = fs
      .readdirSync(dir)
      .filter((name) => /^logs-.*\.txt$/i.test(name))
      .map((name) => ({ name, time: fs.statSync(path.join(dir, name)).mtimeMs }))
      .sort((a, b) => b.time - a.time)
      .slice(Math.max(0, keep));

    for (const file of files) {
      try {
        fs.rmSync(path.join(dir, file.name), { force: true });
      } catch {

      }
    }
  } catch {

  }
}

export function startRunLog(dirName = "logs", keep = 50): string | null {
  closeRunLog();

  const dir = path.resolve(process.cwd(), dirName);
  const file = path.join(dir, `logs-${stamp()}.txt`);

  try {
    fs.mkdirSync(dir, { recursive: true });
    logFd = fs.openSync(file, "a");
    logFilePath = file;
  } catch {
    logFd = null;
    logFilePath = null;
    return null;
  }

  pruneLogs(dir, keep);

  writeLogLine(`=== log started at ${new Date().toISOString()} ===`);
  return file;
}

export function writeLogLine(text: string): void {
  if (logFd === null) return;
  try {
    fs.writeSync(logFd, text.replace(ANSI_RE, "") + "\n");
  } catch {

  }
}

export function closeRunLog(): void {
  if (logFd !== null) {
    try {
      writeLogLine(`=== log stopped at ${new Date().toISOString()} ===`);
    } catch {

    }
    try {
      fs.closeSync(logFd);
    } catch {

    }
    logFd = null;
  }
  logFilePath = null;
}


const LOG_RING: string[] = [];
const LOG_RING_MAX = 300;

function pushLogRing(line: string): void {
  LOG_RING.push(line.replace(ANSI_RE, ""));
  if (LOG_RING.length > LOG_RING_MAX) LOG_RING.shift();
}

export function recentLogs(limit = 100): string[] {
  const size = Math.max(0, Math.min(Math.floor(limit), LOG_RING.length));
  return size === 0 ? [] : LOG_RING.slice(LOG_RING.length - size);
}

export class Logger {
  static capture: ((line: string) => void) | null = null;

  loggerName: string;
  verbose?: boolean;
  private jsonLog: boolean =
    process.argv.includes("--json") || process.argv.includes("-j");

  constructor(name: string, verbose?: boolean) {
    this.loggerName = name;
    this.verbose = verbose;
  }

  private emit(line: string, toStderr = false): void {
    if (toStderr) process.stderr.write(line + "\n");
    else process.stdout.write(line + "\n");
    writeLogLine(line);
  }

  private line(level: LogLevel, s: string, forFile: boolean): string {
    const now = new Date();
    const tag = LEVEL_TAG[level];
    const name = this.loggerName.padEnd(NAME_WIDTH).slice(0, NAME_WIDTH);

    if (forFile) {
      return `${now.toISOString()} ${tag.padEnd(5)} ${name} ${s}`;
    }
    return (
      `${color.gray(hhmmss(now))} ` +
      `${LEVEL_PAINT[level](tag.padEnd(5))} ` +
      `${color.cyan(name)} ${s}`
    );
  }

  private log(level: LogLevel, s: string, toStderr: boolean): void {

    if (s === "") {
      process.stdout.write("\n");
      writeLogLine("");
      return;
    }

    if (this.jsonLog) {
      const payload = jsonLog(level, s).replace(/\n$/, "");
      if (toStderr) process.stderr.write(payload + "\n");
      else process.stdout.write(payload + "\n");
      writeLogLine(payload);
      return;
    }
    if (toStderr) process.stderr.write(this.line(level, s, false) + "\n");
    else process.stdout.write(this.line(level, s, false) + "\n");
    const forFile = this.line(level, s, true);
    writeLogLine(forFile);
    pushLogRing(forFile);
    if (Logger.capture) Logger.capture(forFile);
  }

  info(s: string) {
    this.log("info", s, false);
  }

  warn(s: string) {
    this.log("warn", s, true);
  }

  error(s: string) {
    this.log("error", s, true);
  }

  fatal(s: string) {
    this.log("fatal", s, true);
  }

  debug(s: string) {
    if (!(this.verbose ?? global_verbose)) return;
    this.log("debug", s, true);
  }

  section(title: string): void {
    const width = Math.max(40, Math.min((process.stdout.columns ?? 72) - 1, 78));
    const head = `── ${title} `;
    const rule = head + "─".repeat(Math.max(0, width - head.length));
    process.stdout.write(color.gray(rule) + "\n");
    writeLogLine(`--- ${title} ${"-".repeat(Math.max(0, width - head.length))}`);
  }

  kv(label: string, value: unknown): void {
    this.info(`  ${color.gray(label.padEnd(NAME_WIDTH + 6))} ${String(value)}`);
  }
}

verboseLogging(process.env.DEBUG === "true");
