import mcp from "minecraft-protocol";
import { Logger } from "../logger.js";
import { profileFor, type ProtocolProfile } from "./ProtocolProfile.js";

const { createDeserializer, createSerializer, states } = mcp;

export interface ServerNameMapping {
  from: string;
  to: string;
}

export interface ServerNameSpoofOptions {
  enabled: boolean;

  mappings: ServerNameMapping[];

  caseInsensitive: boolean;
  targets: {
    chat: boolean;
    tab: boolean;
    scoreboard: boolean;
    title: boolean;
    brand: boolean;
  };
}

export const DEFAULT_SERVER_NAME_SPOOF: ServerNameSpoofOptions = {
  enabled: true,
  mappings: [{ from: "imc", to: "heypixel" }],
  caseInsensitive: true,
  targets: { chat: true, tab: true, scoreboard: true, title: true, brand: true },
};

const TEXT_KEYS = new Set(["text", "displayName", "prefix", "suffix", "itemName", "header", "footer"]);

const FIELD_LIMIT = {
  chat: 32767,
  title: 32767,
  header: 32767,
  objectiveDisplay: 32,
  teamDisplay: 32,
  teamPrefix: 16,
  teamSuffix: 16,
} as const;

export class ServerNameSpoofer {
  private logger = new Logger("ServerName");
  private deserializerInstance: any = null;
  private serializerInstance: any = null;

  private get deserializer(): any {
    if (!this.deserializerInstance) {
      this.deserializerInstance = createDeserializer({
        state: states.PLAY,
        isServer: false,
        version: this.profile.version,
        customPackets: null,
        noErrorLogging: true,
      } as any);
    }
    return this.deserializerInstance;
  }

  private get serializer(): any {
    if (!this.serializerInstance) {
      this.serializerInstance = createSerializer({
        state: states.PLAY,
        isServer: true,
        version: this.profile.version,
        customPackets: null,
      });
    }
    return this.serializerInstance;
  }
  private warned = false;

  private readonly profile: ProtocolProfile;

  constructor(
    private readonly resolveOptions: () => ServerNameSpoofOptions,
    profile?: ProtocolProfile
  ) {
    this.profile = profile ?? profileFor("1.8.9");
  }

  isEnabled(): boolean {
    const options = this.resolveOptions();
    if (!options.enabled) return false;
    return options.mappings.some((m) => m.from && m.to && m.from !== m.to);
  }

  replaceText(text: string): string {
    const options = this.resolveOptions();
    let out = text;
    for (const mapping of options.mappings) {
      if (!mapping.from || !mapping.to || mapping.from === mapping.to) continue;
      if (options.caseInsensitive) {

        const pattern = mapping.from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        out = out.replace(new RegExp(pattern, "gi"), mapping.to);
      } else {
        out = out.split(mapping.from).join(mapping.to);
      }
    }
    return out;
  }

  private replaceComponent(json: unknown): string {
    if (typeof json !== "string") return typeof json === "undefined" ? "" : String(json);
    const trimmed = json.trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return this.replaceText(json);
    try {
      const parsed = JSON.parse(trimmed);
      const replaced = this.walkComponent(parsed);
      return JSON.stringify(replaced);
    } catch {
      return this.replaceText(json);
    }
  }

  private walkComponent(node: any): any {
    if (node === null || typeof node !== "object") return node;
    if (Array.isArray(node)) return node.map((item) => this.walkComponent(item));
    const out: any = {};
    for (const [key, value] of Object.entries(node)) {
      if (TEXT_KEYS.has(key) && typeof value === "string") {
        out[key] = this.replaceText(value);
      } else if (key === "extra" || key === "with" || key === "value") {
        out[key] = this.walkComponent(value);
      } else {
        out[key] = value;
      }
    }
    return out;
  }

  rewrite(data: Buffer): Buffer {
    if (!this.isEnabled()) return data;

    const packetId = data[0];
    const options = this.resolveOptions();
    const ids = this.profile.ids;
    const isBrand = packetId === ids.customPayload;

    const wanted =
      (packetId === ids.chat && options.targets.chat) ||
      (packetId === ids.tabHeader && options.targets.tab) ||
      ((packetId === ids.objective || packetId === ids.score || packetId === ids.team) && options.targets.scoreboard) ||
      (packetId === ids.title && options.targets.title) ||
      (isBrand && options.targets.brand);
    if (!wanted) return data;

    let parsed: any;
    try {
      parsed = this.deserializer.parsePacketBuffer(data);
    } catch {
      return data;
    }
    const packetName: string | undefined = parsed?.data?.name;
    const params: any = parsed?.data?.params;
    if (!packetName || !params) return data;

    let changed = false;
    try {
      changed = this.apply(packetName, params);
    } catch (err) {
      if (!this.warned) {
        this.warned = true;
        this.logger.warn(`Rewrite failed, forwarding untouched: ${(err as Error).message}`);
      }
      return data;
    }
    if (!changed) return data;

    try {
      return this.serializer.createPacketBuffer({ name: packetName, params });
    } catch (err) {
      if (!this.warned) {
        this.warned = true;
        this.logger.warn(`Re-encode failed, forwarding untouched: ${(err as Error).message}`);
      }
      return data;
    }
  }

  private apply(packetName: string, params: any): boolean {
    switch (packetName) {
      case "chat": {
        const before = params.message;
        const after = this.replaceComponent(before);
        if (after !== before) {
          params.message = after;
          return true;
        }
        return false;
      }
      case "playerlist_header":
      case "player_list_header_footer": {
        let changed = false;
        for (const key of ["header", "footer"] as const) {
          if (typeof params[key] === "string") {
            const after = this.replaceComponent(params[key]);
            if (after !== params[key]) {
              params[key] = after;
              changed = true;
            }
          }
        }
        return changed;
      }
      case "title": {

        if (params.action !== 0 && params.action !== 1) return false;
        if (typeof params.text !== "string") return false;
        const after = this.replaceComponent(params.text);
        if (after === params.text) return false;
        params.text = after;
        return true;
      }
      case "scoreboard_objective": {
        let changed = false;
        for (const key of ["displayText", "value"] as const) {
          if (typeof params[key] === "string") {
            const after = this.replaceComponent(params[key]);
            if (after !== params[key] && after.length <= FIELD_LIMIT.objectiveDisplay) {
              params[key] = after;
              changed = true;
            }
          }
        }
        return changed;
      }
      case "scoreboard_score": {
        let changed = false;
        for (const key of ["itemName", "entityName"] as const) {
          if (typeof params[key] === "string") {
            const after = this.replaceText(params[key]);
            if (after !== params[key]) {
              params[key] = after;
              changed = true;
            }
          }
        }
        return changed;
      }
      case "scoreboard_team":
      case "teams": {
        let changed = false;

        const limits: Record<string, number> = {
          name: FIELD_LIMIT.teamDisplay,
          displayName: FIELD_LIMIT.teamDisplay,
          prefix: FIELD_LIMIT.teamPrefix,
          suffix: FIELD_LIMIT.teamSuffix,
        };
        for (const key of ["name", "displayName", "prefix", "suffix"] as const) {
          if (typeof params[key] !== "string") continue;
          const after = this.replaceComponent(params[key]);
          if (after !== params[key] && after.length <= limits[key]) {
            params[key] = after;
            changed = true;
          }
        }
        return changed;
      }
      case "custom_payload": {
        if (params.channel !== "MC|Brand" && params.channel !== "minecraft:brand") return false;
        const payload = params.data;
        if (!Buffer.isBuffer(payload)) return false;
        const text = payload.toString("utf8");
        const after = this.replaceText(text);
        if (after === text) return false;
        const encoded = Buffer.from(after, "utf8");

        params.data = Buffer.concat([Buffer.from([encoded.length]), encoded]);
        return true;
      }
      default:
        return false;
    }
  }
}
