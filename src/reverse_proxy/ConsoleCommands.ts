import { Logger, color } from "../logger.js";
import { type RandomIdMode } from "./RandomId.js";
import { consoleUi } from "./ConsoleUi.js";
import {
  getConfig,
  getConsoleConfig,
  getAutomationConfig,
  getConfigFilePath,
  setConfigValue,
  getConfigValue,
  parseConfigValue,
  listConfigKeys,
} from "./config.js";
import { backupFiles, backupDir, defaultBackupTargets, listBackups } from "./Backup.js";

export interface ConsoleCommandTarget {
  resetRandomId(): string;
  setRandomId(id: string): void;
  getRandomIdMode(): RandomIdMode;
  getCurrentUpstreamId(): string | null;
  getPlayerCount(): number;
  setPacketLogging(enabled: boolean): boolean;
  togglePacketLogging(): boolean;
}

const ID_PATTERN = /^[A-Za-z0-9_]{3,16}$/;

/** 控制台可用命令（Tab 补全与 /help 都用它） */
const CONSOLE_COMMANDS = [
  "randomname", "randomid", "rid",
  "setname", "setid", "sid",
  "log", "debug",
  "config", "cfg",
  "backup",
  "help",
];

export class ConsoleCommands {
  private logger: Logger;
  private target: ConsoleCommandTarget;
  private started = false;
  private interactive = false;
  private rawInput = false;
  private lastWasCR = false;

  constructor(target: ConsoleCommandTarget, options: { echo?: boolean } = {}) {
    this.logger = new Logger("Console");
    this.target = target;
    this.echoEnabled = options.echo !== false;
  }

  private echoEnabled: boolean;

  /**
   * 接管 stdin。
   *
   * 不用 readline：它的回显行为在不同终端（conhost / Windows Terminal）
   * 与启动方式（直接跑 / 经 npm start）下不一致，出现过「打字看不见」的问题。
   *
   * 现在由 ConsoleUi 负责底部输入框与回显，这里只负责逐字符解析。
   * 输入框生效时进 raw 模式（逐字符到达 + 自己回显）；
   * 否则保持 cooked 模式，让终端自己回显整行。
   */
  start(): void {
    if (this.started) return;
    this.started = true;

    const stdin = process.stdin;
    this.interactive = Boolean((stdin as NodeJS.ReadStream & { isTTY?: boolean }).isTTY);
    this.rawInput = this.interactive && consoleUi.isActive() && this.echoEnabled;

    try {
      stdin.setEncoding("utf8");
      if (this.rawInput) (stdin as NodeJS.ReadStream).setRawMode?.(true);
      stdin.resume();
    } catch {
      this.interactive = false;
      this.rawInput = false;
    }

    stdin.on("data", (chunk: string | Buffer) => {
      try {
        this.feed(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
      } catch (err) {
        this.logger.error(`Input error: ${(err as Error).message}`);
      }
    });

    const restore = () => {
      try {
        (stdin as NodeJS.ReadStream).setRawMode?.(false);
        consoleUi.disable();
      } catch {
        /* ignore */
      }
    };
    process.once("exit", restore);

    if (!this.interactive) {
      this.logger.info("stdin is not a terminal: commands are still read line by line, just without echo.");
    }
  }

  stop(): void {
    try {
      (process.stdin as NodeJS.ReadStream).setRawMode?.(false);
    } catch {
      /* ignore */
    }
    try {
      process.stdin.pause();
    } catch {
      /* ignore */
    }
    this.started = false;
  }

  /** 逐字符处理输入；显示交给 ConsoleUi */
  private feed(text: string): void {
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];

      // 方向键 / Home / End 等会发 ESC 序列，整段丢弃
      if (ch === "\u001b") {
        i += 2;
        continue;
      }

      if (ch === "\r" || ch === "\n") {
        // CRLF 只算一次回车
        if (ch === "\n" && this.lastWasCR) {
          this.lastWasCR = false;
          continue;
        }
        this.lastWasCR = ch === "\r";

        const line = consoleUi.getBuffer();
        consoleUi.commitInput(); // 把这一行留在历史里
        if (line.trim()) {
          try {
            this.handle(line);
          } catch (err) {
            this.logger.error(`Command failed: ${(err as Error).message}`);
          }
        }
        continue;
      }

      this.lastWasCR = false;

      if (ch === "\u0003") {
        // raw 模式下 Ctrl+C 不会触发 SIGINT，手动触发
        consoleUi.commitInput();
        process.emit("SIGINT");
        return;
      }

      if (ch === "\u0015") {
        // Ctrl+U：清空当前行
        consoleUi.clearInput();
        continue;
      }

      if (ch === "\t") {
        // Tab 补全命令名
        this.completeCommand();
        continue;
      }

      if (ch === "\u007f" || ch === "\b") {
        // 退格
        consoleUi.backspace();
        continue;
      }

      if (ch < " ") continue; // 其它控制字符忽略

      consoleUi.appendChar(ch);
    }
  }

  handle(rawLine: string): void {
    const line = rawLine.trim();
    if (!line) return;

    const body = line.startsWith("/") ? line.slice(1) : line;
    const separator = body.search(/\s/);
    const command = (separator === -1 ? body : body.slice(0, separator)).toLowerCase();
    const argument = separator === -1 ? "" : body.slice(separator + 1).trim();

    switch (command) {
      case "randomname":
      case "randomid":
      case "rid":
        this.resetRandomId();
        break;

      case "setname":
      case "setid":
      case "sid":
        this.setRandomId(argument);
        break;

      case "config":
      case "cfg":
        this.configCommand(argument);
        break;

      case "help":
      case "?":
        this.printHelp();
        break;

      case "log":
      case "debug":
        this.setPacketLogging(argument);
        break;

      case "backup":
        this.backupCommand(argument);
        break;

      default:
        this.logger.warn(`Unknown command "${command}". Type /help to list commands.`);
        break;
    }
  }

  private resetRandomId(): void {
    this.target.resetRandomId();
    this.printApplied();
  }

  private setRandomId(argument: string): void {
    if (!argument) {
      this.logger.warn("Usage: /setname <id>   (3-16 characters, a-z A-Z 0-9 _)");
      return;
    }
    if (!ID_PATTERN.test(argument)) {
      this.logger.warn(
        `Invalid ID "${argument}": must be 3-16 characters using only a-z A-Z 0-9 _`
      );
      return;
    }

    this.target.setRandomId(argument);
    this.printApplied();
  }

  private setPacketLogging(argument: string): void {
    const value = argument.toLowerCase();

    if (!value) {
      const enabled = this.target.togglePacketLogging();
      this.logger.info(`Packet debug logging is now ${enabled ? "ON" : "OFF"}.`);
      return;
    }

    if (value === "on" || value === "true" || value === "1" || value === "yes") {
      this.target.setPacketLogging(true);
      this.logger.info("Packet debug logging is now ON.");
      return;
    }

    if (value === "off" || value === "false" || value === "0" || value === "no") {
      this.target.setPacketLogging(false);
      this.logger.info("Packet debug logging is now OFF.");
      return;
    }

    this.logger.warn("Usage: /log [on|off]");
  }

  /** 提示新 ID 什么时候生效 */
  private printApplied(): void {
    const online = this.target.getPlayerCount();
    if (online > 0) {
      this.logger.info(
        `Will be used for new connections; ${online} player(s) online keep the old ID until they reconnect.`
      );
    } else {
      this.logger.info("Will be used for new connections.");
    }
  }

  /** /backup [list|label] */
  private backupCommand(argument: string): void {
    const arg = argument.trim();

    if (arg.toLowerCase() === "list" || arg.toLowerCase() === "ls") {
      const entries = listBackups();
      this.logger.info(`Backup folder: ${backupDir()}`);
      if (entries.length === 0) {
        this.logger.info("  (empty - run /backup to create one)");
        return;
      }
      this.logger.info(`  ${entries.length} entr${entries.length === 1 ? "y" : "ies"} (newest first):`);
      for (const entry of entries) {
        const size = entry.bytes >= 1024 ? `${(entry.bytes / 1024).toFixed(1)} KB` : `${entry.bytes} B`;
        this.logger.info(
          `  ${entry.isDirectory ? "[dir] " : "      "}${entry.name}  ${entry.files} file(s), ${size}`
        );
      }
      return;
    }

    const dir = backupFiles(defaultBackupTargets(), arg || "manual");
    if (!dir) {
      this.logger.warn("Nothing to back up (no config or credential files found).");
      return;
    }
    this.logger.info(`Backup created: ${dir}`);
    this.logger.info("  (in .gitignore, will not be committed)");
  }

  /** Tab 补全：只补命令名（第一个词） */
  private completeCommand(): void {
    const buffer = consoleUi.getBuffer();
    const body = buffer.startsWith("/") ? buffer.slice(1) : buffer;

    if (body.includes(" ")) {
      this.logger.info("Completion only works on the command name (the first word).");
      return;
    }

    const token = body.toLowerCase();
    const matches = CONSOLE_COMMANDS.filter((c) => c.startsWith(token));

    if (matches.length === 0) {
      this.logger.info(`No command starts with "${token}"`);
      return;
    }

    if (matches.length === 1) {
      consoleUi.setBuffer(`/${matches[0]} `);
      return;
    }

    // 多个候选：先补到最长公共前缀，再把候选列出来
    let prefix = matches[0];
    for (const match of matches) {
      while (prefix && !match.startsWith(prefix)) prefix = prefix.slice(0, -1);
    }
    if (prefix.length > token.length) consoleUi.setBuffer(`/${prefix}`);

    this.logger.info(`Completions: ${matches.map((m) => "/" + m).join("  ")}`);
  }

  /** /config [keys|get <键>|set <键> <值>] */
  private configCommand(argument: string): void {
    const parts = argument.split(/\s+/).filter(Boolean);
    const sub = (parts[0] ?? "").toLowerCase();

    if (!sub) {
      this.printConfig();
      this.logger.info("");
      this.logger.info("  /config keys                     list every editable key");
      this.logger.info("  /config get <key>                show one value");
      this.logger.info("  /config set <key> <value>        change it and save (restart to apply)");
      this.logger.info("  Example: /config set nameProtect.enabled false");
      return;
    }

    if (sub === "keys" || sub === "list") {
      const keys = listConfigKeys();
      this.logger.info(`Editable keys (${keys.length}):`);
      for (const key of keys) this.logger.info(`  ${key} = ${JSON.stringify(getConfigValue(key))}`);
      return;
    }

    if (sub === "get") {
      const key = parts[1];
      if (!key) {
        this.logger.warn("Usage: /config get <key>");
        return;
      }
      const value = getConfigValue(key);
      if (value === undefined) {
        this.logger.warn(`Key "${key}" not found. Use /config keys to list them.`);
        return;
      }
      this.logger.info(`${key} = ${JSON.stringify(value)}`);
      return;
    }

    if (sub === "set") {
      const key = parts[1];
      const rawValue = parts.slice(2).join(" ");
      if (!key || !rawValue) {
        this.logger.warn("Usage: /config set <key> <value>   (use \"\" for an empty string)");
        return;
      }
      const result = setConfigValue(key, parseConfigValue(rawValue));
      if (result.ok) {
        this.logger.info(`Saved to ${getConfigFilePath()}: ${result.message}`);
        this.logger.info("Restart the proxy for the new value to take effect.");
      } else {
        this.logger.warn(result.message);
      }
      return;
    }

    this.logger.warn(`Unknown subcommand "${sub}". Try /config, /config keys, /config get <key>, /config set <key> <value>`);
  }

  printConfig(): void {
    const c = getConfig();
    const cc = getConsoleConfig();

    this.logger.section("Effective configuration");
    this.logger.kv("Config file", getConfigFilePath());
    this.logger.kv("Precedence", "env vars > config.json > built-in defaults");

    this.logger.info("");
    this.logger.info(`  ${color.gray("proxy")}`);
    this.logger.kv("  listen", `${c.tcpHost}:${c.tcpPort}`);
    this.logger.kv("  max players", c.maxPlayers);
    this.logger.kv("  debug", c.debug);
    this.logger.kv("  upstream", c.eaglerServer);
    this.logger.kv("  random id", `mode=${c.randomIdMode ?? "off"} length=${c.randomIdLength ?? "-"}`);

    this.logger.info("");
    this.logger.info(`  ${color.gray("console")}`);
    this.logger.kv("  autoHelp", cc.autoHelp);
    this.logger.kv("  autoStatus", cc.autoStatus);
    this.logger.kv("  echo", cc.echo);

    this.logger.info("");
    this.logger.info(`  ${color.gray("automation")}`);
    const ac = getAutomationConfig();
    this.logger.kv("  enabled", ac.enabled);
    this.logger.kv("  game account file", ac.gameAccountFile);
    this.logger.kv("  default password", ac.defaultGamePassword ? "set" : "(prompt)");
    this.logger.kv("  in-game replies", ac.inGameReplies);
    this.logger.kv("  auto login on join", ac.autoLoginOnJoin);
    this.logger.kv("  auto register on join", ac.autoRegisterOnJoin);

    this.logger.info("");
    this.logger.info(`  ${color.gray("nameprotect")}`);
    const np = c.nameProtect;
    this.logger.kv("  enabled", np?.enabled ?? false);
    this.logger.kv("  display name", np?.name ?? "(none)");
    this.logger.kv("  targets", `playlist=${np?.playlist} chat=${np?.chat} scoreboard=${np?.scoreboard}`);

    this.logger.info("");
    this.logger.info(`  ${color.gray("Use /config set <key> <value> to change a value, then restart.")}`);
  }

  printHelp(): void {
    this.logger.info("Console commands   (Tab completes command names)");
    this.logger.info("");
    this.logger.info("  proxy:");
    this.logger.info("  /randomname /randomid /rid        generate a new random ID");
    this.logger.info("  /setname /setid /sid <id>         set a custom ID (3-16 chars: a-z A-Z 0-9 _)");
    this.logger.info("  /log /debug [on|off]              toggle packet debug logging");
    this.logger.info("");
    this.logger.info("  config:");
    this.logger.info("  /config /cfg                      show the effective configuration");
    this.logger.info("  /config keys                      list every editable key");
    this.logger.info("  /config get <key>                 show one value");
    this.logger.info("  /config set <key> <value>         change it and save (restart to apply)");
    this.logger.info("");
    this.logger.info("  backup (folder is in .gitignore):");
    this.logger.info("  /backup [label]                   snapshot config + credentials into backup/");
    this.logger.info("  /backup list                      list existing backups");
    this.logger.info("");
    this.logger.info("  In-game chat bar commands (intercepted by the proxy):");
    this.logger.info("  /autoreg [password]               register the game account");
    this.logger.info("  /autologin                        log in with the saved account");
    this.logger.info("  /autostatus /autohelp             automation status");
    this.logger.info("");
    this.logger.info("  /help /?                          show this help");

    const mode = this.target.getRandomIdMode();
    this.logger.info(`Random ID mode: ${mode}`);

    const current = this.target.getCurrentUpstreamId();
    if (current) {
      this.logger.info(`Current ID for new connections: "${current}"`);
    }
  }
}
