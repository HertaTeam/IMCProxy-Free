import { Logger, color } from "../logger.js";
import { type RandomIdMode } from "./RandomId.js";
import { consoleUi } from "./ConsoleUi.js";
import {
  getConfig,
  getConsoleConfig,
  getAnnounceConfig,
  getUpdateCheckConfig,
  getAutomationConfig,
  getGameAccountsFile,
  getConfigFilePath,
  setConfigValue,
  applyConfigValue,
  isHotConfigKey,
  getConfigValue,
  parseConfigValue,
  listConfigKeys,
} from "./config.js";
import { checkForUpdates, loadVersionState, VERSION_FILE } from "./UpdateCheck.js";
import { backupFiles, backupDir, defaultBackupTargets, listBackups } from "./Backup.js";
import {
  DEFAULT_GAME_ACCOUNTS_FILE,
  describeGameAccounts,
  loadGameAccounts,
  removeGameAccount,
  resolveGameAccountRef,
  saveGameAccounts,
  upsertGameAccount,
} from "./GameAccounts.js";

export interface ConsoleCommandTarget {
  resetRandomId(): string;
  setRandomId(id: string): void;
  getRandomIdMode(): RandomIdMode;
  getCurrentUpstreamId(): string | null;
  getPlayerCount(): number;
  setPacketLogging(enabled: boolean): boolean;
  togglePacketLogging(): boolean;
  /** 给上游服务器发一条聊天指令（/login 之类） */
  sendChatToServer(message: string): number;
}

/** 命令名 → 配置键前缀（注意 nameProtect / serverNameSpoof 是驼峰） */
const SECTION_PREFIX: Record<string, string> = {
  proxy: "",
  random: "randomId.",
  console: "console.",
  automation: "automation.",
  nameprotect: "nameProtect.",
  servername: "serverNameSpoof.",
  announce: "announce.",
  updatecheck: "updateCheck.",
  imc: "imc.",
  imcp: "imc.",
};
const ID_PATTERN = /^[A-Za-z0-9_]{3,16}$/;

/** 控制台可用命令（Tab 补全与 /help 都用它） */
const CONSOLE_COMMANDS = [
  "randomname", "randomid", "rid",
  "setname", "setid", "sid",
  "log", "debug",
  "proxy",
  "random",
  "console",
  "automation",
  "nameprotect",
  "servername",
  "announce",
  "updatecheck",
  "settings",
  "backup",
  "update",
  "gamestatus", "logingame", "gameadd", "gamedel",
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

      case "proxy":
      case "random":
      case "console":
      case "automation":
      case "nameprotect":
      case "servername":
      case "announce":
      case "updatecheck":
        this.settingsCommand(command, argument);
        break;

      case "settings":
        this.settingsOverview();
        break;

      case "update":
        this.updateCommand(argument);
        break;

      case "gamestatus":
        this.gameStatus();
        break;

      case "logingame":
        this.loginGame(argument);
        break;

      case "gameadd":
        this.gameAdd(argument);
        break;

      case "gamedel":
        this.gameDelete(argument);
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

  /**
   * 每个配置分区一个命令：/nameprotect [子项] [值]
   * 不带参数 = 显示该分区当前值；带子项 = 读；带值 = 改（热键立即生效）。
   */
  private settingsCommand(section: string, argument: string): void {
    const prefix = SECTION_PREFIX[section] ?? section + ".";
    const all = listConfigKeys();
    const keys = all.filter((k) => (prefix === "" ? !k.includes(".") : k.startsWith(prefix)));
    const parts = argument.split(/\s+/).filter(Boolean);

    if (parts.length === 0) {
      this.logger.section(section);
      if (keys.length === 0) {
        this.logger.warn('No settings under "' + section + '".');
        return;
      }
      for (const key of keys) {
        const short = prefix === "" ? key : key.slice(prefix.length);
        this.logger.kv("  " + short, JSON.stringify(getConfigValue(key)));
      }
      this.logger.info("");
      this.logger.info("  usage: /" + section + " <setting> <value>");
      this.logger.info("  example: /" + section + " " + (keys[0] ?? "").slice(prefix.length) + " <value>");
      return;
    }

    const sub = parts[0];
    const key = all.find((k) => k === prefix + sub || k === sub) ?? prefix + sub;

    if (!all.includes(key)) {
      this.logger.warn('Unknown setting "' + sub + '" for /' + section + ".");
      this.logger.info("  available: " + keys.map((k) => (prefix === "" ? k : k.slice(prefix.length))).join(", "));
      return;
    }

    if (parts.length === 1) {
      this.logger.info(key + " = " + JSON.stringify(getConfigValue(key)));
      return;
    }

    const raw = parts.slice(1).join(" ");
    const result = applyConfigValue(key, parseConfigValue(raw));
    if (!result.ok) {
      this.logger.warn(result.message);
      return;
    }
    this.logger.info("Saved: " + key + " = " + JSON.stringify(getConfigValue(key)));
    if (isHotConfigKey(key)) this.logger.info("Applied immediately (hot).");
    else this.logger.info("Takes effect after a restart.");
  }

  /** /settings —— 打印全部配置 + 所有可改键 */
  private settingsOverview(): void {
    this.printConfig();
    const keys = listConfigKeys();
    this.logger.info("");
    this.logger.info("Editable settings (" + keys.length + "):");
    for (const key of keys) this.logger.info("  " + key + " = " + JSON.stringify(getConfigValue(key)));
    this.logger.info("");
    this.logger.info("  Change one with the matching section command, e.g. /nameprotect enabled false");
  }


  /* -------------------------------------------------- 游戏账号管理 */

  private gameAccountsFile(): string {
    return getGameAccountsFile();
  }

  /** /gamestatus —— 查看已保存的账号（含密码） */
  private gameStatus(): void {
    const file = this.gameAccountsFile();
    const accounts = loadGameAccounts(file);
    this.logger.section("Game accounts");
    this.logger.kv("File", file);
    if (accounts.length === 0) {
      this.logger.warn("No accounts saved yet. Add one with /gameadd <account> <password>");
      return;
    }
    this.logger.kv("Saved", accounts.length + " account(s)");
    for (const line of describeGameAccounts(accounts)) this.logger.info("  " + line);
    this.logger.info("");
    this.logger.info("  /logingame [#n | account]        log in with the saved password");
    this.logger.info("  /gameadd <account> <password>    add or update an account");
    this.logger.info("  /gamedel <#n | account>          remove an account");
  }

  /** /logingame [ref | account password] —— 用保存的账号登录 */
  private loginGame(argument: string): void {
    const file = this.gameAccountsFile();
    const parts = argument.split(/\s+/).filter(Boolean);
    let account: { account: string; password: string } | null = null;

    if (parts.length >= 2) {
      account = { account: parts[0], password: parts[1] };
      upsertGameAccount(account.account, account.password, file);
      this.logger.info('Saved "' + account.account + '" to ' + file);
    } else if (parts.length === 1) {
      const found = resolveGameAccountRef(loadGameAccounts(file), parts[0]);
      if (!found) {
        this.logger.warn('No saved account matches "' + parts[0] + '". Use /gamestatus to list them.');
        return;
      }
      account = { account: found.account, password: found.password };
    } else {
      const accounts = loadGameAccounts(file);
      if (accounts.length === 0) {
        this.logger.warn("No accounts saved. Use /gameadd <account> <password> or /logingame <account> <password>");
        return;
      }
      account = { account: accounts[0].account, password: accounts[0].password };
    }

    const sent = this.target.sendChatToServer("/login " + account.password);
    if (sent === 0) {
      this.logger.warn("No player is connected right now; connect a client first.");
      return;
    }
    this.logger.info('Sent /login for "' + account.account + '" (' + sent + ' session(s)).');
  }

  /** /gameadd <account> <password> [note] */
  private gameAdd(argument: string): void {
    const parts = argument.split(/\s+/).filter(Boolean);
    if (parts.length < 2) {
      this.logger.warn("Usage: /gameadd <account> <password> [note]");
      return;
    }
    const account = parts[0];
    const password = parts[1];
    const note = parts.slice(2).join(" ");
    upsertGameAccount(account, password, this.gameAccountsFile(), note || undefined);
    this.logger.info('Saved "' + account + '" to ' + this.gameAccountsFile());
  }

  /** /gamedel <#n | account> */
  private gameDelete(argument: string): void {
    const ref = argument.trim();
    if (!ref) {
      this.logger.warn("Usage: /gamedel <#n | account>");
      return;
    }
    const accounts = loadGameAccounts(this.gameAccountsFile());
    const result = removeGameAccount(accounts, ref);
    if (!result.removed) {
      this.logger.warn('No saved account matches "' + ref + '".');
      return;
    }
    saveGameAccounts(result.rest, this.gameAccountsFile());
    this.logger.info('Removed "' + result.removed.account + '".');
  }

  /* -------------------------------------------------------- 更新提示 */

  /** /update [status] —— 手动检查 GitHub 上的版本 */
  private updateCommand(argument: string): void {
    const sub = argument.trim().toLowerCase();
    const state = loadVersionState();
    const config = getUpdateCheckConfig();

    this.logger.section("Update");
    this.logger.kv("Version file", VERSION_FILE);
    this.logger.kv("Edit date", state.editDate);
    this.logger.kv("Launches today", state.count);
    if (state.lastCheck) this.logger.kv("Last check", state.lastCheck);
    if (state.remoteEditDate) this.logger.kv("Remote edit date", state.remoteEditDate);
    this.logger.kv("Repo", "github.com/" + config.repo);
    this.logger.kv("Enabled", config.enabled);

    if (sub === "status") return;

    this.logger.info("Checking...");
    void checkForUpdates(config).then((result) => {
      if (result.status === "outdated") this.logger.warn(result.message);
      else if (result.status === "up-to-date") this.logger.info(result.message);
      else this.logger.warn(result.message);
    });
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
    this.logger.info(`  ${color.gray("announce")}`);
    const ann = getAnnounceConfig();
    this.logger.kv("  enabled", ann.enabled);
    this.logger.kv("  interval", `${ann.intervalMs}ms`);
    this.logger.kv("  targets", `console=${ann.console} chat=${ann.inGameChat}`);

    this.logger.info("");
    this.logger.info(`  ${color.gray("update check")}`);
    const uc = getUpdateCheckConfig();
    const vstate = loadVersionState();
    this.logger.kv("  enabled", uc.enabled);
    this.logger.kv("  repo", `github.com/${uc.repo}`);
    this.logger.kv("  edit date", vstate.editDate);
    this.logger.kv("  launches today", vstate.count);

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
    this.logger.info(`  ${color.gray("Change a value with its section command, e.g. /nameprotect enabled false (hot keys apply instantly).")}`);
  }

  printHelp(): void {
    this.logger.info("Console commands   (Tab completes command names)");
    this.logger.info("");
    this.logger.info("  proxy:");
    this.logger.info("  /randomname /randomid /rid        generate a new random ID");
    this.logger.info("  /setname /setid /sid <id>         set a custom ID (3-16 chars: a-z A-Z 0-9 _)");
    this.logger.info("  /log /debug [on|off]              toggle packet debug logging");
    this.logger.info("");
    this.logger.info("  settings (one command per section, hot keys apply instantly):");
    this.logger.info("  /proxy        [setting] [value]".padEnd(52) + "settings of proxy");
    this.logger.info("  /random       [setting] [value]".padEnd(52) + "settings of randomId");
    this.logger.info("  /console      [setting] [value]".padEnd(52) + "settings of console");
    this.logger.info("  /automation   [setting] [value]".padEnd(52) + "settings of automation");
    this.logger.info("  /nameprotect  [setting] [value]".padEnd(52) + "settings of nameprotect");
    this.logger.info("  /servername   [setting] [value]".padEnd(52) + "settings of servername");
    this.logger.info("  /announce     [setting] [value]".padEnd(52) + "settings of announce");
    this.logger.info("  /updatecheck  [setting] [value]".padEnd(52) + "settings of updatecheck");
    this.logger.info("  /settings                         show the effective config + every editable key");
    this.logger.info("");
    this.logger.info("  game accounts:");
    this.logger.info("  /gamestatus                       list saved accounts (account + password)");
    this.logger.info("  /logingame [#n | account]         log in with the saved password");
    this.logger.info("  /logingame <account> <password>   save and log in directly");
    this.logger.info("  /gameadd <account> <password>     add or update an account");
    this.logger.info("  /gamedel <#n | account>           remove an account");
    this.logger.info("");
    this.logger.info("  update:");
    this.logger.info("  /update                           check GitHub for a newer version");
    this.logger.info("  /update status                    show local version info only");
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
