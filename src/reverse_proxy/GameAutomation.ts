import { Logger } from "../logger.js";
import { normalizeForMatch } from "./McFormat.js";
import {
  loadGameAccount,
  saveGameAccount,
  filePath,
  type GameAccount,
} from "./AutoFiles.js";

/**
 * 游戏内自动化。
 *
 * 玩家在游戏聊天栏输入的命令会被代理拦截（不转发给服务器），由本模块代执行：
 *
 *   /autoreg [密码] [确认密码]   注册游戏账号，成功后把账号密码写入 TXT
 *   /autologin                  读取 TXT，自动 /login
 *   /autostatus                 查看当前自动化状态
 *
 * 消息策略（重要）：
 *   - **自动触发**的流程只写代理控制台，绝不往玩家聊天栏塞东西；
 *   - 只有玩家自己敲的命令才会有游戏内回复，且可用 inGameReplies 关掉。
 *
 * 客户端信息（真实 ID / 服务端看到的 ID / UUID）由代理自身提供，无需玩家输入。
 */

export interface AutomationConfig {
  enabled: boolean;
  gameAccountFile: string;
  /** /autoreg 不带参数时使用的默认密码；留空则必须手动输入 */
  defaultGamePassword: string;
  /** 是否允许在玩家聊天栏回复（只影响玩家主动输入的命令） */
  inGameReplies: boolean;
  autoLoginOnJoin: boolean;
  autoRegisterOnJoin: boolean;
}

export interface PlayerIdentity {
  /** 玩家客户端里的真实 ID */
  realName: string;
  /** 服务端实际看到的 ID（随机 ID 模式下可能不同） */
  serverName: string;
  uuid: string;
}

export interface AutomationHooks {
  identity(): PlayerIdentity;
  /** 以玩家身份向服务器发送一条聊天/命令 */
  sendToServer(message: string): void;
  /** 在玩家聊天栏显示一行提示（仅在玩家主动输入命令时使用） */
  sendToClient(text: string): void;
}

interface PendingAction {
  kind: "register" | "login";
  password?: string;
  at: number;
}

/** 一次操作等待服务端回执的最长时间；超时后视为无效，避免永久阻断后续自动动作 */
const PENDING_TTL_MS = 60_000;

const COMMANDS = ["autoreg", "autologin", "autostatus", "autohelp"];

/** 消息通道：player = 玩家聊天栏，console = 代理控制台 */
type Channel = "player" | "console";

export class GameAutomation {
  private logger = new Logger("Auto");
  private options: AutomationConfig;
  private pending = new Map<string, PendingAction>();

  constructor(options: AutomationConfig) {
    this.options = options;
  }

  getConfig(): AutomationConfig {
    return this.options;
  }

  /** 自动流程一律只写控制台 */
  private toConsole(text: string): void {
    this.logger.info(text.replace(/§./g, ""));
  }

  /** 玩家主动命令的回复（只有显式设为 false 才静音） */
  private toPlayer(hooks: AutomationHooks, text: string): void {
    if (this.options.inGameReplies === false) return;
    hooks.sendToClient(text);
  }

  private notify(channel: Channel, hooks: AutomationHooks, text: string): void {
    if (channel === "console") this.toConsole(text);
    else this.toPlayer(hooks, text);
  }

  private getPending(player: string): PendingAction | undefined {
    const pending = this.pending.get(player);
    if (!pending) return undefined;
    if (Date.now() - pending.at > PENDING_TTL_MS) {
      this.pending.delete(player);
      return undefined;
    }
    return pending;
  }

  /* ------------------------------------------------------ 玩家进服 */

  onPlayerJoin(player: string, hooks: AutomationHooks): void {
    if (!this.options.enabled) return;

    const id = hooks.identity();
    this.toConsole(`Player joined: ${id.realName} (server sees "${id.serverName}")`);

    const saved = loadGameAccount(this.options.gameAccountFile);
    this.toConsole(
      saved
        ? `  saved game account: ${saved.username} (${filePath(this.options.gameAccountFile)})`
        : "  no saved game account yet; use /autoreg [password] in game chat"
    );
  }

  /* ------------------------------------------------ 客户端聊天拦截 */

  /** @returns true 表示这条消息属于自动化命令，已处理，不要转发给服务器 */
  handleClientMessage(player: string, message: string, hooks: AutomationHooks): boolean {
    if (!message.startsWith("/")) return false;

    const body = message.slice(1).trim();
    const space = body.search(/\s/);
    const command = (space === -1 ? body : body.slice(0, space)).toLowerCase();
    const argument = space === -1 ? "" : body.slice(space + 1).trim();

    if (!COMMANDS.includes(command)) return false;
    if (!this.options.enabled) {
      this.toPlayer(hooks, "§c[auto] automation is disabled in config.json");
      return true;
    }

    const parts = argument.split(/\s+/).filter(Boolean);

    switch (command) {
      case "autoreg":
        this.handleRegister(player, parts, hooks);
        break;
      case "autologin":
        this.handleLogin(player, hooks);
        break;

      case "autostatus":
      case "autohelp":
        this.showStatus(player, hooks);
        break;
    }
    return true;
  }

  /* -------------------------------------------------------- 各命令 */

  private handleRegister(player: string, parts: string[], hooks: AutomationHooks): void {
    let password = parts[0];
    let usedDefault = false;

    if (!password) {
      const fallback = this.options.defaultGamePassword?.trim();
      if (!fallback) {
        this.toPlayer(hooks, "§cUsage: §f/autoreg <password> [confirm password]");
        this.toPlayer(hooks, "§7Or set automation.defaultGamePassword in config.json");
        return;
      }
      password = fallback;
      usedDefault = true;
    }

    const confirm = parts[1] ?? password;

    if (password !== confirm) {
      this.toPlayer(hooks, "§cThe two passwords do not match");
      return;
    }
    if (password.length < 4) {
      this.toPlayer(hooks, "§cPassword too short (the server usually requires at least 4 characters)");
      return;
    }

    const id = hooks.identity();
    this.pending.set(player, { kind: "register", password, at: Date.now() });
    this.toConsole(`Registering "${id.serverName}"${usedDefault ? " with the default password" : ""}...`);
    hooks.sendToServer(`/reg ${password} ${confirm}`);
  }

  private handleLogin(player: string, hooks: AutomationHooks): void {
    const saved = loadGameAccount(this.options.gameAccountFile);
    if (!saved) {
      this.toPlayer(hooks, `§cNo saved game account (${filePath(this.options.gameAccountFile)})`);
      this.toPlayer(hooks, "§7Run §f/autoreg <password> §7once to register");
      return;
    }

    this.pending.set(player, { kind: "login", password: saved.password, at: Date.now() });
    this.toConsole(`Logging in as "${saved.username}"...`);
    hooks.sendToServer(`/login ${saved.password}`);
  }

  /** 处理服务端发来的聊天文本（匹配前会再归一化一次） */
  handleServerMessage(player: string, text: string, hooks: AutomationHooks): void {
    if (!this.options.enabled) return;

    // 归一化：去 § 码、去空白、去装饰竖线、转小写。
    // 服务端随时可能调整排版与空格，这样才能稳定命中。
    const flat = normalizeForMatch(text);

    if (flat.includes("成功注册") || flat.includes("注册成功")) {
      const pending = this.getPending(player);
      if (pending?.kind === "register" && pending.password) {
        const id = hooks.identity();
        const account: GameAccount = {
          username: id.serverName,
          password: pending.password,
          savedAt: new Date().toISOString(),
        };
        saveGameAccount(this.options.gameAccountFile, account);
        this.toConsole(`Registered "${account.username}"; credentials -> ${filePath(this.options.gameAccountFile)}`);
        this.pending.delete(player);
      }
      return;
    }

    // 3) 登录成功
    if (flat.includes("登录成功")) {
      if (this.getPending(player)?.kind === "login") this.pending.delete(player);
      return;
    }

    // 4) 服务端提示需要注册 / 登录 / 绑定 → 按配置自动执行（只写控制台）
    if (flat.includes("请使用/reg")) {
      if (this.options.autoRegisterOnJoin && !this.getPending(player)) {
        const saved = loadGameAccount(this.options.gameAccountFile);
        const password = saved?.password || this.options.defaultGamePassword?.trim();
        if (password) {
          this.toConsole("Server asks to register; sending /reg automatically");
          this.pending.set(player, { kind: "register", password, at: Date.now() });
          hooks.sendToServer(`/reg ${password} ${password}`);
        } else {
          this.toConsole("Server asks to register but no password is saved or configured");
        }
      }
      return;
    }

    if (flat.includes("请使用/login")) {
      if (this.options.autoLoginOnJoin && !this.getPending(player)) {
        const saved = loadGameAccount(this.options.gameAccountFile);
        if (saved?.password) {
          this.toConsole("Server asks to log in; sending /login automatically");
          this.pending.set(player, { kind: "login", password: saved.password, at: Date.now() });
          hooks.sendToServer(`/login ${saved.password}`);
        } else {
          this.toConsole("Server asks to log in but no game password is known");
        }
      }
      return;
    }

    // 图形验证码（地图读字）——脚本无法识别，必须人工
    if (flat.includes("请解决验证码") || flat.includes("验证码错误")) {
      this.toConsole("!! Manual map captcha required - solve it in game chat");
      return;
    }
  }

  /* -------------------------------------------------------- 状态 */

  private showStatus(player: string, hooks: AutomationHooks): void {
    const id = hooks.identity();
    const game = loadGameAccount(this.options.gameAccountFile);

    const lines: string[] = [
      "===== Automation status =====",
      `Client ID: ${id.realName}    Server ID: ${id.serverName}`,
      `UUID: ${id.uuid}`,
      game
        ? `Game account: saved as ${game.username}`
        : `Game account: not saved (${filePath(this.options.gameAccountFile)})`,
      `Default register password: ${this.options.defaultGamePassword ? "set" : "not set"}`,
      `Auto on join: login=${this.options.autoLoginOnJoin ? "on" : "off"} register=${this.options.autoRegisterOnJoin ? "on" : "off"}`,
      "Commands: /autoreg [password] /autologin /autostatus /autohelp",
    ];

    for (const line of lines) {
      this.toPlayer(hooks, `§7${line}`);
      this.toConsole(line);
    }
  }
}
