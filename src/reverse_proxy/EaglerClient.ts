import WebSocket from "ws";
import EventEmitter from "events";
import { Logger } from "../logger.js";
import { ReverseEnums } from "./Enums.js";
import { MineProtocol } from "../proxy/Protocol.js";
import { Util } from "../proxy/Util.js";
import { Constants } from "../proxy/Constants.js";
import { NETWORK_VERSION, VANILLA_PROTOCOL_VERSION } from "../meta.js";

export interface EaglerClientOptions {
  wsUrl: string;
  username: string;
  skinType?: ReverseEnums.SkinType;
  skinData?: Buffer | number;
}

export interface HandshakeResult {
  success: boolean;
  uuid: string;
  serverBrand: string;
  serverVersion: string;
  error?: string;
}

export class EaglerClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private logger: Logger;
  public username: string;
  private wsUrl: string;
  private skinType: ReverseEnums.SkinType;
  private skinData: Buffer | number;

  public uuid: string = "";
  public appliedUsername: string = "";
  public state: ReverseEnums.ConnectionState = ReverseEnums.ConnectionState.DISCONNECTED;
  public serverBrand: string = "";
  public serverVersion: string = "";

  constructor(options: EaglerClientOptions) {
    super();
    this.logger = new Logger("EaglerClient");
    this.username = options.username;
    this.wsUrl = options.wsUrl;
    this.skinType = options.skinType ?? ReverseEnums.SkinType.BUILTIN;
    this.skinData = options.skinData ?? 0;
  }

  async connect(): Promise<HandshakeResult> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let connectionTimer: NodeJS.Timeout | undefined;

      const resolveOnce = (result: HandshakeResult) => {
        if (settled) return;
        settled = true;
        if (connectionTimer) clearTimeout(connectionTimer);
        resolve(result);
      };

      const rejectOnce = (err: Error) => {
        if (settled) return;
        settled = true;
        if (connectionTimer) clearTimeout(connectionTimer);
        reject(err);
      };

      this.state = ReverseEnums.ConnectionState.HANDSHAKING;
      this.logger.info(`Connecting to ${this.wsUrl}...`);
      this.ws = new WebSocket(this.wsUrl);

      connectionTimer = setTimeout(() => {
        const err = new Error("WebSocket connection timed out");
        this.logger.error(err.message);
        rejectOnce(err);
        this.disconnect();
      }, 30000);

      this.ws.on("open", async () => {
        this.logger.info("WebSocket connected, starting handshake...");
        try {
          const result = await this.performHandshake();
          if (result.success) {
            this.state = ReverseEnums.ConnectionState.CONNECTED;
            this.emit("connected");
          }
          resolveOnce(result);
        } catch (err) {
          this.logger.error(`Handshake failed: ${(err as Error).message}`);
          resolveOnce({
            success: false,
            uuid: "",
            serverBrand: "",
            serverVersion: "",
            error: (err as Error).message,
          });
          this.disconnect();
        }
      });

      this.ws.on("error", (err) => {
        const wasConnected = this.state === ReverseEnums.ConnectionState.CONNECTED;
        this.logger.error(`WebSocket error: ${err.message}`);

        if (wasConnected) {
          this.disconnect();
          if (this.listenerCount("error") > 0) this.emit("error", err);
        } else {
          rejectOnce(err);
          this.disconnect();
        }
      });

      this.ws.on("close", (code, reason) => {
        const wasConnected = this.state === ReverseEnums.ConnectionState.CONNECTED;
        this.logger.info(`WebSocket closed: code=${code}, reason=${reason.toString()}`);
        this.state = ReverseEnums.ConnectionState.DISCONNECTED;
        if (!settled) rejectOnce(new Error("WebSocket closed before handshake completed"));
        if (wasConnected) this.emit("disconnected");
      });

      this.ws.on("message", (data: Buffer, isBinary: boolean) => {
        if (this.state !== ReverseEnums.ConnectionState.CONNECTED) return;

        if (!isBinary) {
          const err = new Error("Received non-binary WebSocket frame");
          this.logger.error(err.message);
          if (this.listenerCount("error") > 0) this.emit("error", err);
          this.disconnect();
          return;
        }

        this.emit("packet", data);
      });
    });
  }

  private async performHandshake(): Promise<HandshakeResult> {
    this.sendLoginPacket();

    const identifyPkt = await this.waitForPacket(ReverseEnums.PacketId.SCIdentifyPacket);
    const identifyData = this.parseIdentifyPacket(identifyPkt);
    this.serverBrand = identifyData.brand;
    this.serverVersion = identifyData.version;
    this.logger.info(`Server: ${this.serverBrand} v${this.serverVersion}`);

    this.sendUsernamePacket();

    const uuidPkt = await this.waitForPacket(ReverseEnums.PacketId.SCSyncUuidPacket);
    const uuidData = this.parseUuidPacket(uuidPkt);
    this.uuid = uuidData.uuid;
    if (uuidData.username) {
      this.appliedUsername = uuidData.username;
      if (uuidData.username !== this.username) {
        this.logger.warn(
          `Server assigned ID "${uuidData.username}", requested "${this.username}"`
        );
      }
    }
    this.logger.info(`UUID: ${this.uuid}`);

    this.sendSkinPacket();

    this.sendReadyPacket();

    await this.waitForPacket(ReverseEnums.PacketId.SCReadyPacket);
    this.logger.info("Handshake complete!");

    return {
      success: true,
      uuid: this.uuid,
      serverBrand: this.serverBrand,
      serverVersion: this.serverVersion,
    };
  }

  private sendLoginPacket(): void {
    const packet = Buffer.concat(
      [
        [ReverseEnums.PacketId.CSLoginPacket],
        [0x02],
        MineProtocol.writeShort(0x01),
        MineProtocol.writeShort(NETWORK_VERSION),
        MineProtocol.writeShort(0x01),
        MineProtocol.writeShort(VANILLA_PROTOCOL_VERSION),
        MineProtocol.writeString("EaglerReverseProxy"),
        MineProtocol.writeString("1.0.0"),
        [0x00],
        MineProtocol.writeString(this.username),
      ].map((arr) => (arr instanceof Uint8Array ? arr : Buffer.from(arr)))
    );

    this.ws!.send(packet);
    this.logger.debug(`Sent login packet for ${this.username}`);
  }

  private sendUsernamePacket(): void {
    const packet = Buffer.concat(
      [
        [ReverseEnums.PacketId.CSUsernamePacket],
        MineProtocol.writeString(this.username),
        MineProtocol.writeString("default"),
        [0x00],
      ].map((arr) => (arr instanceof Uint8Array ? arr : Buffer.from(arr)))
    );

    this.ws!.send(packet);
    this.logger.debug("Sent username packet");
  }

  private sendSkinPacket(): void {
    let packet: Buffer;

    if (this.skinType === ReverseEnums.SkinType.BUILTIN) {
      const skinId = typeof this.skinData === "number" ? this.skinData : 0;
      if (!ReverseEnums.BUILTIN_SKIN_IDS.includes(skinId)) {
        throw new Error(`Invalid builtin skin ID: ${skinId}`);
      }
      packet = Buffer.concat(
        [
          [ReverseEnums.PacketId.CSSetSkinPacket],
          MineProtocol.writeString("skin_v1"),
          Buffer.from(Constants.MAGIC_ENDING_CLIENT_UPLOAD_SKIN_BUILTIN),
          MineProtocol.writeVarInt(skinId),
        ].map((arr) => (arr instanceof Uint8Array ? arr : Buffer.from(arr)))
      );
      this.logger.debug(`Sent skin packet (builtin id=${skinId})`);
    } else {
      const skinBuffer = this.skinData as Buffer;
      packet = Buffer.concat(
        [
          [ReverseEnums.PacketId.CSSetSkinPacket],
          MineProtocol.writeString("skin_v1"),
          MineProtocol.writeVarInt(0),
          Buffer.from([0x00, 0x00, 0x00]),
          skinBuffer.slice(0, 16384),
        ].map((arr) => (arr instanceof Uint8Array ? arr : Buffer.from(arr)))
      );
      this.logger.debug("Sent skin packet (custom)");
    }

    this.ws!.send(packet);
  }

  private sendReadyPacket(): void {
    const packet = Buffer.from([ReverseEnums.PacketId.CSReadyPacket]);
    this.ws!.send(packet);
    this.logger.debug("Sent ready packet");
  }

  private waitForPacket(packetId: ReverseEnums.PacketId, timeout = 30000): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const ws = this.ws;
      if (!ws) {
        reject(new Error("WebSocket is not connected"));
        return;
      }

      const cleanup = () => {
        clearTimeout(timer);
        ws.removeListener("message", handler);
        ws.removeListener("close", onClose);
        ws.removeListener("error", onError);
      };

      const handler = (data: Buffer, isBinary: boolean) => {
        if (!isBinary) {
          cleanup();
          reject(new Error("Received non-binary WebSocket frame during handshake"));
          this.disconnect();
          return;
        }

        const receivedId = data[0];

        if (receivedId === ReverseEnums.PacketId.SCDisconnectPacket) {
          cleanup();
          const reason = this.parseDisconnectPacket(data);
          this.logger.error(`Server disconnected: ${reason}`);
          reject(new Error(`Server disconnected: ${reason}`));
          return;
        }

        if (receivedId === packetId) {
          cleanup();
          resolve(data);
        }
      };

      const onClose = () => {
        cleanup();
        reject(new Error("WebSocket closed during handshake"));
      };

      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };

      const timer = setTimeout(() => {
        cleanup();
        this.logger.error(`Timeout waiting for packet 0x${packetId.toString(16)}`);
        reject(new Error(`Timeout waiting for packet 0x${packetId.toString(16)}`));
      }, timeout);

      ws.on("message", handler);
      ws.once("close", onClose);
      ws.once("error", onError);
    });
  }

  private parseDisconnectPacket(data: Buffer): string {
    try {
      data = data.subarray(1);
      const reasonCode = MineProtocol.readVarInt(data);
      const reason = MineProtocol.readString(reasonCode.newBuffer);
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

  private parseIdentifyPacket(data: Buffer): { brand: string; version: string } {
    data = data.subarray(1);
    const protoVer = MineProtocol.readShort(data);
    const gameVer = MineProtocol.readShort(protoVer.newBuffer);
    const brand = MineProtocol.readString(gameVer.newBuffer);
    const version = MineProtocol.readString(brand.newBuffer);
    return {
      brand: brand.value,
      version: version.value,
    };
  }

  private parseUuidPacket(data: Buffer): { username: string; uuid: string } {
    data = data.subarray(1);
    const username = MineProtocol.readString(data);
    const uuidBuffer = username.newBuffer.subarray(0, 16);
    const uuid = Util.uuidBufferToString(uuidBuffer);
    return {
      username: username.value,
      uuid: uuid,
    };
  }

  sendRaw(data: Buffer): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    }
  }

  disconnect(): void {
    const ws = this.ws;
    this.ws = null;

    if (ws?.readyState === WebSocket.CONNECTING) {
      ws.terminate();
    } else if (ws?.readyState === WebSocket.OPEN) {
      ws.close();
    }

    this.state = ReverseEnums.ConnectionState.DISCONNECTED;
  }
}
