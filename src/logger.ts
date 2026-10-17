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

/* ------------------------------------------------------------ 行格式 */

type LogLevel = JsonLogType;

/** logger 名字那一列的宽度（所有名字里最长的 EaglerClient/ReverseProxy 是 12） */
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

/** HH:mm:ss（控制台上不用显示日期，文件名和日志头里已经有日期了） */
function hhmmss(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/* ------------------------------------------------------ 日志文件输出 */

/** ANSI 颜色码（写进文件前要剥掉，否则文本编辑器里全是乱码） */
const ANSI_RE = /\u001b\[[0-9;]*m/g;

let logFd: number | null = null;
let logFilePath: string | null = null;

/** 本次运行的日志文件路径（没启用文件日志时为 null） */
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

/** 只保留最新的 keep 份 logs-*.txt */
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
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}

/**
 * 开始本次运行的日志文件：`<dir>/logs-<时间戳>.txt`。
 * 用同步写，进程被强杀也不会丢掉最后几行。
 * @returns 日志文件绝对路径；创建失败返回 null（不影响正常运行）
 */
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

  // 同步写一行头，确认文件真的可写
  writeLogLine(`=== log started at ${new Date().toISOString()} ===`);
  return file;
}

/** 写一行到日志文件（自动去掉颜色码） */
export function writeLogLine(text: string): void {
  if (logFd === null) return;
  try {
    fs.writeSync(logFd, text.replace(ANSI_RE, "") + "\n");
  } catch {
    /* 写盘失败不能影响主流程 */
  }
}

/** 关闭日志文件（会先写一行收尾标记） */
export function closeRunLog(): void {
  if (logFd !== null) {
    try {
      writeLogLine(`=== log stopped at ${new Date().toISOString()} ===`);
    } catch {
      /* ignore */
    }
    try {
      fs.closeSync(logFd);
    } catch {
      /* ignore */
    }
    logFd = null;
  }
  logFilePath = null;
}

export class Logger {
  loggerName: string;
  verbose?: boolean;
  private jsonLog: boolean =
    process.argv.includes("--json") || process.argv.includes("-j");

  constructor(name: string, verbose?: boolean) {
    this.loggerName = name;
    this.verbose = verbose;
  }

  /** 同时写控制台与日志文件 */
  private emit(line: string, toStderr = false): void {
    if (toStderr) process.stderr.write(line + "\n");
    else process.stdout.write(line + "\n");
    writeLogLine(line);
  }

  /**
   * 统一的一行格式：
   *   控制台  `HH:mm:ss  INFO   Config        message`
   *   日志文件 `2026-10-17T09:57:06.087Z INFO   Config        message`
   */
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
    // 空消息就是单纯的空行，别留一串时间戳
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
    writeLogLine(this.line(level, s, true));
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

  /** 分节标题：`── Configuration ─────────────────────────` */
  section(title: string): void {
    const width = Math.max(40, Math.min((process.stdout.columns ?? 72) - 1, 78));
    const head = `── ${title} `;
    const rule = head + "─".repeat(Math.max(0, width - head.length));
    process.stdout.write(color.gray(rule) + "\n");
    writeLogLine(`--- ${title} ${"-".repeat(Math.max(0, width - head.length))}`);
  }

  /** 左标签右值，标签用灰色对齐 */
  kv(label: string, value: unknown): void {
    this.info(`  ${color.gray(label.padEnd(NAME_WIDTH + 6))} ${String(value)}`);
  }
}

verboseLogging(process.env.DEBUG === "true");
