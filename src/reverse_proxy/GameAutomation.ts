import { Logger } from "../logger.js";
import { normalizeForMatch } from "./McFormat.js";
import {
  loadGameAccount,
  saveGameAccount,
  filePath,
  type GameAccount,
} from "./AutoFiles.js";

export interface AutomationConfig {
  enabled: boolean;
  gameAccountFile: string;

  defaultGamePassword: string;

  inGameReplies: boolean;
  autoLoginOnJoin: boolean;
  autoRegisterOnJoin: boolean;
}

export interface PlayerIdentity {

  realName: string;

  serverName: string;
  uuid: string;
}

export interface AutomationHooks {
  identity(): PlayerIdentity;

  sendToServer(message: string): void;

  sendToClient(text: string): void;
}

interface PendingAction {
  kind: "register" | "login";
  password?: string;
  at: number;
}

const PENDING_TTL_MS = 60_000;

const COMMANDS = ["autoreg", "autologin", "autostatus", "autohelp"];

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

  private toConsole(text: string): void {
    this.logger.info(text.replace(/§./g, ""));
  }

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

  handleServerMessage(player: string, text: string, hooks: AutomationHooks): void {
    if (!this.options.enabled) return;

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

    if (flat.includes("登录成功")) {
      if (this.getPending(player)?.kind === "login") this.pending.delete(player);
      return;
    }

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

    if (flat.includes("发送网页账号的密码") || flat.includes("网页账号的密码即可登录")) {
      if (!this.getPending(player)) {
        const saved = loadGameAccount(this.options.gameAccountFile);
        const password = saved?.password || this.options.defaultGamePassword?.trim();
        if (password) {
          this.toConsole("imc offers chat-password login; sending the saved password");
          this.pending.set(player, { kind: "login", password, at: Date.now() });
          hooks.sendToServer(password);
        } else {
          this.toConsole("imc offers chat-password login but no password is saved (use /gameadd)");
        }
      }
      return;
    }

    if (flat.includes("请解决验证码") || flat.includes("验证码错误")) {
      this.toConsole("!! Manual map captcha required - solve it in game chat");
      return;
    }
  }

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
