import EventEmitter, { once } from "events";
import mcp, { createServer, Server, states } from "minecraft-protocol";
import { Logger, verboseLogging, color } from "../logger.js";
import { mcToAnsi, stripMcFormat } from "./McFormat.js";
import { NameProtector, type NameProtectOptions } from "./NameProtect.js";
import { ServerNameSpoofer, DEFAULT_SERVER_NAME_SPOOF, type ServerNameSpoofOptions } from "./ServerNameSpoof.js";
import { getNameProtectConfig, getServerNameSpoofConfig } from "./config.js";
import { type NameProtectConfig } from "./config.js";
import { EaglerClient } from "./EaglerClient.js";
import { ReverseEnums } from "./Enums.js";
import { MineProtocol } from "../proxy/Protocol.js";
import { Util } from "../proxy/Util.js";
import {
  generateRandomId,
  generateUniqueRandomId,
  normalizeRandomIdLength,
  parseRandomIdMode,
  type RandomIdMode,
} from "./RandomId.js";
import type { AutomationHooks, GameAutomation } from "./GameAutomation.js";

const { createSerializer } = mcp;

export type { RandomIdMode };

/** 聊天组件里的 color 名称 → § 码 */
const MC_COLOR_CODES: Record<string, string> = {
  black: "0",
  dark_blue: "1",
  dark_green: "2",
  dark_aqua: "3",
  dark_red: "4",
  dark_purple: "5",
  gold: "6",
  gray: "7",
  dark_gray: "8",
  blue: "9",
  green: "a",
  aqua: "b",
  red: "c",
  light_purple: "d",
  yellow: "e",
  white: "f",
};

/** MC 1.8 玩家名规则：3-16 位字母 / 数字 / 下划线 */
const MC_NAME_PATTERN = /^[A-Za-z0-9_]{3,16}$/;

export interface ReverseProxyConfig {
  tcpHost: string;
  tcpPort: number;
  eaglerServer: string;
  /**
   * 连上游时带的 Origin 头。
   * EaglercraftXServer 会检查它：不带就被当成"非法客户端"踢掉
   * （提示「请使用正确的Eaglercraft客户端连接本服务器」）。
   */
  eaglerOrigin?: string;
  /** 上游校验用浏览器 User-Agent */
  eaglerUserAgent?: string;
  maxPlayers: number;
  defaultSkinId: number;
  debug: boolean;
  randomIdMode?: RandomIdMode;
  randomIdLength?: number;
  /** nameprotect：只改客户端显示的封包 */
  nameProtect?: NameProtectConfig;
  /** 服务器名伪装：只改客户端显示的封包 */
  serverNameSpoof?: ServerNameSpoofOptions;
  /** 参考型反作弊（只告警，不踢人） */
}

export interface ConnectedPlayer {
  username: string;
  upstreamUsername: string;
  uuid: string;
  eaglerClient: EaglerClient;
  mcClient: any;
}

export class ReverseProxy extends EventEmitter {
  private config: ReverseProxyConfig;
  private logger: Logger;
  private mcServer: Server | null = null;
  private running = false;
  private players: Map<string, ConnectedPlayer> = new Map();
  private playerCleanups: Map<string, () => boolean> = new Map();
  private pendingPlayers: Map<string, { eaglerClient: EaglerClient; mcClient: any }> = new Map();
  private randomIdMode: RandomIdMode = "off";
  private randomIdLength: number = 8;
  private sessionRandomId: string | null = null;
  private packetLogging: boolean = false;
  private automation: GameAutomation | null = null;
  private nameProtectOptions: NameProtectOptions;
  private serverNameOptions: ServerNameSpoofOptions = DEFAULT_SERVER_NAME_SPOOF;
  private serverNameSpoofer: ServerNameSpoofer;
  private playerHooks: Map<string, AutomationHooks> = new Map();

  constructor(config: ReverseProxyConfig, automation?: GameAutomation | null) {
    super();
    this.config = config;
    this.randomIdMode = parseRandomIdMode(config.randomIdMode) ?? "off";
    this.randomIdLength = normalizeRandomIdLength(config.randomIdLength);
    this.packetLogging = config.debug === true;
    this.automation = automation ?? null;
    this.nameProtectOptions = config.nameProtect ?? {
      enabled: false,
      name: "",
      playlist: false,
      chat: false,
      scoreboard: false,
    };
    this.serverNameOptions = config.serverNameSpoof ?? DEFAULT_SERVER_NAME_SPOOF;
    this.serverNameSpoofer = new ServerNameSpoofer(() => this.serverNameOptions);
    this.logger = new Logger("ReverseProxy");
  }

  /**
   * 配置热更新：/set 改完立刻生效，不需要重启。
   * 只处理改包相关的项，其余（端口、上游、maxPlayers）重启后生效。
   */
  applyRuntimeConfig(): void {
    this.nameProtectOptions = getNameProtectConfig();
    this.serverNameOptions = getServerNameSpoofConfig();
  }

  async start(): Promise<void> {
    this.logger.info("Starting Eaglercraft Reverse Proxy...");
    this.logger.info(`TCP Server: ${this.config.tcpHost}:${this.config.tcpPort}`);
    this.logger.info(`Eaglercraft Server: ${this.config.eaglerServer}`);
    this.initRandomIdMode();

    const server = createServer({
      host: this.config.tcpHost,
      port: this.config.tcpPort,
      motd: "§6Eaglercraft Reverse Proxy§r\n§7Connect with vanilla MC 1.8.9",
      "online-mode": false,
      version: "1.8.9",
      maxPlayers: this.config.maxPlayers,
      beforeLogin: (client: any) => this.applyClientIdentity(client),
    });
    this.mcServer = server;

    server.on("login", (mcClient: any) => {
      void this.handlePlayerConnect(mcClient);
    });

    try {
      await once(server, "listening");
    } catch (err) {
      this.mcServer = null;
      throw err;
    }

    this.running = true;
    server.on("error", (err: Error) => {
      this.logger.error(`Server error: ${err.message}`);
    });

    this.logger.info("Reverse Proxy started successfully!");
    this.emit("started");
  }

  private initRandomIdMode(): void {
    this.sessionRandomId = null;

    switch (this.randomIdMode) {
      case "startup": {
        this.sessionRandomId = generateRandomId(this.randomIdLength);
        this.logger.info(
          `Random ID mode (startup): using random ID "${this.sessionRandomId}" for this run (length ${this.randomIdLength})`
        );
        this.logger.info(
          `  The server will see "${this.sessionRandomId}" instead of the ID provided by the game client`
        );
        break;
      }
      case "perConnection":
        this.logger.info(
          `Random ID mode (perConnection): a new random ID is generated for every player (length ${this.randomIdLength})`
        );
        this.logger.info(
          "  The server will see a random ID instead of the ID provided by the game client"
        );
        break;
      default:
        this.logger.info("Random ID mode is off: the server sees the ID provided by the game client");
        break;
    }
  }

  /** 决定服务端看到的 ID：随机 ID 模式下换一个新的，否则用客户端自己的 */
  private resolveUpstreamUsername(realUsername: string): string {
    const taken = this.collectUpstreamUsernames();

    if (this.randomIdMode === "off") return realUsername;

    if (
      this.randomIdMode === "startup" &&
      this.sessionRandomId !== null &&
      !taken.has(this.sessionRandomId) &&
      !taken.has(this.sessionRandomId.toLowerCase())
    ) {
      return this.sessionRandomId;
    }

    const randomId = generateUniqueRandomId(taken, this.randomIdLength);

    if (this.randomIdMode === "startup") {
      this.logger.warn(
        `Random ID "${this.sessionRandomId}" is already in use; generated new random ID "${randomId}" for ${realUsername}`
      );
    }

    return randomId;
  }

  private collectUpstreamUsernames(): Set<string> {
    const names = new Set<string>();

    const reserve = (name: string) => {
      if (!name) return;
      names.add(name);
      names.add(name.toLowerCase());
    };

    for (const player of this.players.values()) {
      reserve(player.eaglerClient.username);
      reserve(player.upstreamUsername);
    }
    for (const pending of this.pendingPlayers.values()) {
      reserve(pending.eaglerClient.username);
    }

    return names;
  }

  resetRandomId(): string {
    this.randomIdMode = "startup";
    this.sessionRandomId = generateRandomId(this.randomIdLength);
    this.logger.info(`Random ID reset: "${this.sessionRandomId}"`);
    return this.sessionRandomId;
  }

  setRandomId(id: string): void {
    this.randomIdMode = "startup";
    this.sessionRandomId = id;
    this.logger.info(`Custom ID set: "${id}"`);
  }

  getRandomIdMode(): RandomIdMode {
    return this.randomIdMode;
  }

  getCurrentUpstreamId(): string | null {
    return this.randomIdMode === "startup" ? this.sessionRandomId : null;
  }

  setPacketLogging(enabled: boolean): boolean {
    this.packetLogging = enabled;
    verboseLogging(enabled);
    return this.packetLogging;
  }

  togglePacketLogging(): boolean {
    return this.setPacketLogging(!this.packetLogging);
  }

  /**
   * 给所有在线玩家的上游服务器发一条聊天指令（/login 之类）。
   * @returns 成功发出去的会话数
   */
  sendChatToServer(message: string): number {
    let sent = 0;
    for (const hooks of this.playerHooks.values()) {
      try {
        hooks.sendToServer(message);
        sent++;
      } catch {
        /* 单个会话失败不影响其他 */
      }
    }
    return sent;
  }

  /**
   * 给所有在线玩家的聊天栏发一条系统消息（公告刷屏用）。
   * 返回成功送达到几个客户端。
   */
  broadcastChat(text: string): number {
    let sent = 0;
    for (const hooks of this.playerHooks.values()) {
      try {
        hooks.sendToClient(text);
        sent++;
      } catch {
        /* 单个玩家发送失败不影响其他人 */
      }
    }
    return sent;
  }

  /** 客户端上要显示成什么名字（nameprotect）；空串表示不改名 */
  private resolveDisplayName(): string {
    const np = this.nameProtectOptions;
    if (np.enabled && np.name) return np.name;
    return "";
  }

  private parseChatPacket(data: Buffer): { plain: string; colored: string } {
    try {
      const raw = MineProtocol.readString(data.subarray(1)).value;
      let formatted = raw;
      try {
        formatted = this.chatToFormatted(JSON.parse(raw));
      } catch {
        /* 不是 JSON，就用原始字符串 */
      }
      return {
        plain: stripMcFormat(formatted).replace(/[ \t]+/g, " ").trim(),
        colored: formatted.replace(/[ \t]+/g, " ").trim(),
      };
    } catch {
      return { plain: "", colored: "" };
    }
  }

  /** 把聊天组件还原成带 § 格式码的字符串（颜色既可能来自 § 码，也可能来自 color 字段） */
  private chatToFormatted(component: any): string {
    if (component == null) return "";
    if (typeof component === "string") return component;
    if (Array.isArray(component)) {
      return component.map((part) => this.chatToFormatted(part)).join("");
    }
    if (typeof component !== "object") return "";

    let prefix = "";
    const colorName = typeof component.color === "string" ? component.color.toLowerCase() : "";
    if (colorName === "reset") prefix += "§r";
    else if (MC_COLOR_CODES[colorName]) prefix += "§" + MC_COLOR_CODES[colorName];
    if (component.bold) prefix += "§l";
    if (component.italic) prefix += "§o";
    if (component.underlined) prefix += "§n";
    if (component.strikethrough) prefix += "§m";

    let body = typeof component.text === "string" ? component.text : "";
    if (!body && typeof component.translate === "string") body = component.translate;
    if (Array.isArray(component.with)) {
      body += component.with.map((part: any) => this.chatToFormatted(part)).join("");
    }
    if (Array.isArray(component.extra)) {
      body += component.extra.map((part: any) => this.chatToFormatted(part)).join("");
    }

    if (!body) return "";
    return prefix + body;
  }

  private applyClientIdentity(mcClient: any): void {
    const realUsername: string = mcClient.username;
    if (!realUsername) return;

    mcClient.proxyRealUsername = realUsername;

    let upstreamUsername: string;
    try {
      upstreamUsername = this.resolveUpstreamUsername(realUsername);
    } catch (err) {
      this.logger.error(`[${realUsername}] Failed to generate random ID: ${(err as Error).message}`);
      mcClient.proxyIdentityFailed = true;
      return;
    }

    mcClient.proxyUpstreamUsername = upstreamUsername;

    if (upstreamUsername === realUsername) return;

    mcClient.username = upstreamUsername;
    mcClient.uuid = Util.generateUUIDFromPlayer(upstreamUsername);

    this.logger.info(
      `[${realUsername}] Random ID mode (${this.randomIdMode}): client ID is now "${upstreamUsername}" (UUID ${mcClient.uuid})`
    );
  }

  private async handlePlayerConnect(mcClient: any): Promise<void> {
    const realUsername: string = mcClient.proxyRealUsername ?? mcClient.username;
    this.logger.info(`Player ${realUsername} is connecting...`);

    if (!this.running) {
      mcClient.end("§cProxy is not running");
      return;
    }

    if (this.players.size + this.pendingPlayers.size >= this.config.maxPlayers) {
      mcClient.end("§cServer is full!");
      return;
    }

    if (this.players.has(realUsername) || this.pendingPlayers.has(realUsername)) {
      mcClient.end("§cYou are already connected!");
      return;
    }

    if (mcClient.proxyIdentityFailed) {
      mcClient.end("§cFailed to generate random ID");
      return;
    }

    let upstreamUsername: string;
    try {
      upstreamUsername =
        mcClient.proxyUpstreamUsername ?? this.resolveUpstreamUsername(realUsername);
    } catch (err) {
      this.logger.error(`[${realUsername}] Failed to generate random ID: ${(err as Error).message}`);
      mcClient.end("§cFailed to generate random ID");
      return;
    }

    if (upstreamUsername !== realUsername) {
      this.logger.info(
        `[${realUsername}] Random ID mode (${this.randomIdMode}): sending ID "${upstreamUsername}" to the server`
      );
    }

    const eaglerClient = new EaglerClient({
      wsUrl: this.config.eaglerServer,
      username: upstreamUsername,
      skinType: ReverseEnums.SkinType.BUILTIN,
      skinData: this.config.defaultSkinId,
      origin: this.config.eaglerOrigin,
      userAgent: this.config.eaglerUserAgent,
    });
    this.pendingPlayers.set(realUsername, { eaglerClient, mcClient });

    let mcDisconnected = false;
    const onHandshakeDisconnect = () => {
      mcDisconnected = true;
      eaglerClient.disconnect();
    };
    mcClient.once("end", onHandshakeDisconnect);

    try {
      this.logger.info(`[${realUsername}] Connecting to Eaglercraft server...`);
      const result = await eaglerClient.connect();

      if (mcDisconnected || !this.running) {
        eaglerClient.disconnect();
        if (!mcDisconnected) mcClient.end("§cProxy stopped during login");
        return;
      }

      if (!result.success) {
        this.logger.error(`[${realUsername}] Failed to connect: ${result.error}`);
        eaglerClient.disconnect();
        mcClient.end(`§cFailed to connect: ${result.error}`);
        return;
      }

      if (eaglerClient.state !== ReverseEnums.ConnectionState.CONNECTED) {
        eaglerClient.disconnect();
        mcClient.end("§cUpstream disconnected during login");
        return;
      }

      this.logger.info(
        `[${realUsername}] Connected! Upstream ID: ${eaglerClient.appliedUsername || upstreamUsername}, UUID: ${eaglerClient.uuid}`
      );

      const player: ConnectedPlayer = {
        username: realUsername,
        upstreamUsername: eaglerClient.appliedUsername || upstreamUsername,
        uuid: eaglerClient.uuid,
        eaglerClient,
        mcClient,
      };
      this.players.set(realUsername, player);
      this.setupPacketForwarding(player);
      this.emit("playerConnect", player);

      const hooks = this.playerHooks.get(player.username);
      if (hooks) this.automation?.onPlayerJoin(player.username, hooks);
    } catch (err) {
      eaglerClient.disconnect();
      if (!mcDisconnected) {
        this.logger.error(`[${realUsername}] Connection error: ${(err as Error).message}`);
        mcClient.end(`§cConnection error: ${(err as Error).message}`);
      }
    } finally {
      mcClient.removeListener("end", onHandshakeDisconnect);
      this.pendingPlayers.delete(realUsername);
    }
  }

  private setupPacketForwarding(player: ConnectedPlayer): void {
    const { mcClient, eaglerClient } = player;

    const clientSerializer = createSerializer({
      state: states.PLAY,
      isServer: false,
      version: "1.8.9",
      customPackets: null,
    });

    // 反向（服务端 → 客户端）序列化器，用于把提示直接显示在玩家聊天栏
    const serverSerializer = createSerializer({
      state: states.PLAY,
      isServer: true,
      version: "1.8.9",
      customPackets: null,
    });

    // nameprotect：把自己在客户端上的显示名换掉（只改服务端→客户端方向的封包）
    const nameProtector = new NameProtector(
      () => this.nameProtectOptions,
      () => this.resolveDisplayName(),
      [player.username, player.upstreamUsername]
    );

    const hooks: AutomationHooks = {
      identity: () => ({
        realName: player.username,
        serverName: player.upstreamUsername,
        uuid: player.uuid,
      }),
      sendToServer: (message: string) => {
        try {
          const buffer = clientSerializer.createPacketBuffer({ name: "chat", params: { message } });
          eaglerClient.sendRaw(buffer);
        } catch (err) {
          this.logger.warn(`[${player.username}] Cannot send "${message}": ${(err as Error).message}`);
        }
      },
      sendToClient: (text: string) => {
        try {
          const buffer = serverSerializer.createPacketBuffer({
            name: "chat",
            params: { message: JSON.stringify({ text }), position: 0 },
          });
          mcClient.writeRaw(buffer);
        } catch (err) {
          this.logger.warn(`[${player.username}] Cannot display message: ${(err as Error).message}`);
        }
      },
    };
    this.playerHooks.set(player.username, hooks);

    let packetsToServer = 0;
    let packetsToClient = 0;
    let lastStatsTime = Date.now();

    const quietPackets = new Set([
      'flying', 'look', 'position', 'position_look', 'keep_alive', 'arm_animation',
      'entity_action', 'transaction', 'window_click', 'held_item_slot', 'settings',
      'custom_payload', 'block_dig', 'block_place', 'use_entity', 'update_sign',
      'tab_complete', 'steer_vehicle', 'chat'
    ]);

    mcClient.on("packet", (packet: any, meta: any) => {
      if (meta.state !== states.PLAY) return;

      if (meta.name === "chat" && typeof packet.message === "string") {
        this.logger.info(`[${player.username}] Chat: ${color.green(packet.message)}`);
        // 游戏内自动化命令在这里被拦下，不再转发给服务器
        if (this.automation?.handleClientMessage(player.username, packet.message, hooks)) {
          return;
        }
      }

      try {
        const buffer = clientSerializer.createPacketBuffer({
          name: meta.name,
          params: packet,
        });
        eaglerClient.sendRaw(buffer);
        packetsToServer++;

        if (this.packetLogging && !quietPackets.has(meta.name)) {
          this.logger.debug(`[${player.username}] C->S: ${meta.name}`);
        }
      } catch (err) {
        if (this.packetLogging) {
          this.logger.debug(`[${player.username}] Encode error: ${(err as Error).message}`);
        }
      }
    });

    eaglerClient.on("packet", (data: Buffer) => {
      const packetId = data[0];


      if (packetId === 0x02) {
        const { plain, colored } = this.parseChatPacket(data);
        if (plain) {
          // 把服务端的 § 颜色映射到控制台；多行消息拆成多行日志
          for (const line of colored.split("\n")) {
            const shown = line.trimEnd();
            if (shown) this.logger.info(`[${player.username}] Server chat: ${mcToAnsi(shown)}`);
          }
          this.automation?.handleServerMessage(player.username, plain, hooks);
        }
      }

      if (packetId === 0x40) {
        try {
          const reason = this.parseKickPacket(data);
          this.logger.warn(`[${player.username}] Server kicked: ${color.red(reason)}`);
        } catch {}
      }

      try {
        // nameprotect 只在这里生效；发给服务端的封包完全不经过它
        // 先做服务器名伪装，再做 nameprotect（两者都只改服务端→客户端方向）
        mcClient.writeRaw(nameProtector.rewrite(this.serverNameSpoofer.rewrite(data)));
        packetsToClient++;
      } catch (err) {
        if (this.packetLogging) {
          this.logger.debug(`[${player.username}] Forward error: ${(err as Error).message}`);
        }
      }
    });

    const statsInterval = setInterval(() => {
      const now = Date.now();
      const elapsed = now - lastStatsTime;
      if (elapsed >= 60000 && (packetsToServer > 0 || packetsToClient > 0)) {
        this.logger.info(`[${player.username}] Stats: ${packetsToServer} sent, ${packetsToClient} received`);
        lastStatsTime = now;
      }
    }, 60000);

    let disconnected = false;
    const cleanupPlayer = (): boolean => {
      if (disconnected) return false;
      disconnected = true;
      clearInterval(statsInterval);
      this.playerCleanups.delete(player.username);
      this.playerHooks.delete(player.username);
      this.players.delete(player.username);
      this.emit("playerDisconnect", player);
      return true;
    };
    this.playerCleanups.set(player.username, cleanupPlayer);

    mcClient.on("end", () => {
      if (!cleanupPlayer()) return;
      this.logger.info(`[${player.username}] Disconnected from MC client`);
      eaglerClient.disconnect();
    });

    eaglerClient.on("disconnected", () => {
      if (!cleanupPlayer()) return;
      this.logger.info(`[${player.username}] Disconnected from Eaglercraft server`);
      mcClient.end("§cLost connection to Eaglercraft server");
    });

    eaglerClient.on("error", (err: Error) => {
      if (!cleanupPlayer()) return;
      this.logger.error(`[${player.username}] Error: ${err.message}`);
      eaglerClient.disconnect();
      mcClient.end(`§cError: ${err.message}`);
    });
  }

  private parseKickPacket(data: Buffer): string {
    try {
      data = data.subarray(1);
      const reason = MineProtocol.readString(data);
      let message = reason.value;

      try {
        const json = JSON.parse(message);
        if (json.text) message = json.text;
        else if (json.translate) message = json.translate;
      } catch {}

      return message;
    } catch {
      return "Unknown reason";
    }
  }

  async stop(): Promise<void> {
    this.logger.info("Stopping Reverse Proxy...");
    this.running = false;

    for (const player of Array.from(this.players.values())) {
      this.playerCleanups.get(player.username)?.();
      player.mcClient.end("§cProxy is shutting down");
      player.eaglerClient.disconnect();
    }
    this.playerCleanups.clear();
    this.playerHooks.clear();
    this.players.clear();

    for (const pending of this.pendingPlayers.values()) {
      pending.mcClient.end("§cProxy is shutting down");
      pending.eaglerClient.disconnect();
    }
    this.pendingPlayers.clear();

    const server = this.mcServer;
    this.mcServer = null;
    if (server) {
      const closed = once(server, "close");
      server.close();
      await closed;
    }

    this.logger.info("Reverse Proxy stopped");
    this.emit("stopped");
  }

  getPlayerCount(): number {
    return this.players.size;
  }

  getPlayers(): ConnectedPlayer[] {
    return Array.from(this.players.values());
  }

}
