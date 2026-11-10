import mcp from "minecraft-protocol";
import { Logger } from "../logger.js";
import { profileFor, type ProtocolProfile } from "./ProtocolProfile.js";

const { createDeserializer, createSerializer, states } = mcp;

export interface NameProtectOptions {
  enabled: boolean;

  name: string;

  playlist: boolean;

  chat: boolean;

  scoreboard: boolean;
}

const CHAT_PACKET = "chat";
const PLAYLIST_PACKET = "player_info";
const SCOREBOARD_PACKETS = new Set([
  "scoreboard_objective",
  "scoreboard_score",
  "scoreboard_team",
  "teams",
]);

const LIMIT = {
  playerName: 16,
  objectiveDisplay: 32,
  teamName: 16,
  teamDisplay: 32,
  teamPrefix: 16,
  teamSuffix: 16,
  scoreEntity: 40,
  chat: 32767,
} as const;

const COMPONENT_TEXT_KEYS = new Set(["text", "displayName", "prefix", "suffix"]);

function clampTo(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

function looksLikeJson(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

export class NameProtector {
  private logger = new Logger("NameProtect");
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

  private resolveOptions: () => NameProtectOptions;
  private resolveDisplayName: () => string;

  private names: string[];
  private warned = false;

  private readonly profile: ProtocolProfile;

  constructor(
    resolveOptions: () => NameProtectOptions,
    resolveDisplayName: () => string,
    names: string[],
    profile?: ProtocolProfile
  ) {
    this.profile = profile ?? profileFor("1.8.9");
    this.resolveOptions = resolveOptions;
    this.resolveDisplayName = resolveDisplayName;
    this.names = names.filter((n) => typeof n === "string" && n.length > 0);

    const configured = this.resolveDisplayName();
    if (configured.length > LIMIT.playerName && this.resolveOptions().enabled) {
      this.logger.warn(
        `Display name is ${configured.length} chars; player list allows ${LIMIT.playerName}. ` +
          `It will be truncated to avoid a client kick (set a shorter nameProtect.name to avoid this).`
      );
    }
  }

  private get options(): NameProtectOptions {
    return this.resolveOptions();
  }

  isEnabled(): boolean {
    return this.options.enabled && this.resolveDisplayName().length > 0 && this.names.length > 0;
  }

  private touches(packetName: string): boolean {
    if (this.options.playlist && packetName === PLAYLIST_PACKET) return true;
    if (this.options.chat && packetName === CHAT_PACKET) return true;
    if (this.options.scoreboard && SCOREBOARD_PACKETS.has(packetName)) return true;
    return false;
  }

  private replacePlain(text: unknown, displayName: string, max: number): string | null {
    if (typeof text !== "string" || !text) return null;
    let out = text;
    for (const name of this.names) {
      if (out.includes(name)) out = out.split(name).join(displayName);
    }
    if (out === text) return null;
    return clampTo(out, max);
  }

  private replaceComponent(jsonText: unknown, displayName: string, max: number): string | null {
    if (typeof jsonText !== "string" || !jsonText) return null;

    if (!looksLikeJson(jsonText)) {

      return this.replacePlain(jsonText, displayName, max);
    }

    const attempt = (name: string): string | null => {
      let parsed: any;
      try {
        parsed = JSON.parse(jsonText);
      } catch {

        return null;
      }
      if (!this.walkComponent(parsed, name)) return null;
      try {
        return JSON.stringify(parsed);
      } catch {
        return null;
      }
    };

    const full = attempt(displayName);
    if (full === null) return null;
    if (full.length <= max) return full;

    for (let length = displayName.length - 1; length >= 1; length--) {
      const shortened = displayName.slice(0, length);
      if (shortened === displayName) continue;
      const candidate = attempt(shortened);
      if (candidate !== null && candidate.length <= max) return candidate;
    }

    this.warnOnce(
      `Rewritten component does not fit the ${max}-char field even after shortening the name; keeping the original.`
    );
    return null;
  }

  private walkComponent(node: any, displayName: string): boolean {
    if (node === null || typeof node !== "object") return false;
    let changed = false;

    if (Array.isArray(node)) {
      for (const item of node) {
        if (this.walkComponent(item, displayName)) changed = true;
      }
      return changed;
    }

    for (const key of Object.keys(node)) {
      const value = node[key];
      if (COMPONENT_TEXT_KEYS.has(key) && typeof value === "string") {
        let out = value;
        for (const name of this.names) {
          if (out.includes(name)) out = out.split(name).join(displayName);
        }
        if (out !== value) {
          node[key] = out;
          changed = true;
        }
      } else if (key === "extra" || key === "with") {
        if (this.walkComponent(value, displayName)) changed = true;
      }
    }
    return changed;
  }

  private allJsonFieldsValid(value: unknown, depth = 0): boolean {
    if (depth > 6) return true;
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return true;
      try {
        JSON.parse(trimmed);
        return true;
      } catch {
        return false;
      }
    }
    if (Array.isArray(value)) return value.every((item) => this.allJsonFieldsValid(item, depth + 1));
    if (value && typeof value === "object") {
      return Object.values(value as Record<string, unknown>).every((item) =>
        this.allJsonFieldsValid(item, depth + 1)
      );
    }
    return true;
  }

  private warnOnce(message: string): void {
    if (this.warned) return;
    this.warned = true;
    this.logger.warn(message);
  }

  rewrite(data: Buffer): Buffer {
    if (!this.isEnabled()) return data;

    const displayName = this.resolveDisplayName();

    const listName = clampTo(displayName, LIMIT.playerName);
    const packetId = data[0];

    const ids = this.profile.ids;
    if (
      packetId !== ids.chat &&
      packetId !== ids.playerInfo &&
      packetId !== ids.objective &&
      packetId !== ids.score &&
      packetId !== ids.team
    ) {
      return data;
    }

    let parsed: any;
    try {
      parsed = this.deserializer.parsePacketBuffer(data);
    } catch {
      return data;
    }

    const packetName: string | undefined = parsed?.data?.name;
    const params: any = parsed?.data?.params;
    if (typeof packetName !== "string" || !params) return data;
    if (!this.touches(packetName)) return data;

    let changed = false;
    try {
      changed = this.apply(packetName, params, displayName, listName);
    } catch (err) {
      this.warnOnce(`Rewrite failed, forwarding untouched: ${(err as Error).message}`);
      return data;
    }
    if (!changed) return data;

    if (!this.allJsonFieldsValid(params)) {
      this.warnOnce("Rewritten packet would contain invalid JSON, forwarding untouched.");
      return data;
    }

    let buffer: Buffer;
    try {
      buffer = this.serializer.createPacketBuffer({ name: packetName, params });
    } catch (err) {
      this.warnOnce(`Re-encode failed, forwarding untouched: ${(err as Error).message}`);
      return data;
    }

    if (buffer.length > data.length + 512) {
      this.warnOnce("Rewrite produced an oversized packet, forwarding untouched.");
      return data;
    }
    return buffer;
  }

  private apply(packetName: string, params: any, displayName: string, listName: string): boolean {
    let changed = false;

    if (packetName === PLAYLIST_PACKET) {
      if (!Array.isArray(params.data)) return false;
      for (const entry of params.data) {

        const replaced = this.replacePlain(entry?.name, listName, LIMIT.playerName);
        if (replaced !== null) {
          entry.name = replaced;
          changed = true;
        }

        const display = this.replaceComponent(entry?.displayName, displayName, LIMIT.chat);
        if (display !== null) {
          entry.displayName = display;
          changed = true;
        }
      }
      return changed;
    }

    if (packetName === CHAT_PACKET) {
      const replaced = this.replaceComponent(params.message, displayName, LIMIT.chat);
      if (replaced !== null) {
        params.message = replaced;
        changed = true;
      }
      return changed;
    }

    if (packetName === "scoreboard_score") {

      for (const key of ["itemName", "entityName", "scoreName"] as const) {
        if (typeof params[key] !== "string") continue;
        const replaced = this.replacePlain(params[key], displayName, LIMIT.scoreEntity);
        if (replaced !== null) {
          params[key] = replaced;
          changed = true;
        }
      }
      return changed;
    }

    if (packetName === "scoreboard_objective") {
      const replaced = this.replaceComponent(params.displayText, displayName, LIMIT.objectiveDisplay);
      if (replaced !== null) {
        params.displayText = replaced;
        changed = true;
      }
      return changed;
    }

    if (packetName === "scoreboard_team" || packetName === "teams") {

      const componentFields: Array<[string, number]> = [
        ["name", LIMIT.teamDisplay],
        ["displayName", LIMIT.teamDisplay],
        ["prefix", LIMIT.teamPrefix],
        ["suffix", LIMIT.teamSuffix],
      ];
      for (const [key, max] of componentFields) {
        const replaced = this.replaceComponent(params[key], displayName, max);
        if (replaced !== null) {
          params[key] = replaced;
          changed = true;
        }
      }

      const players: unknown = params.players;
      if (Array.isArray(players)) {
        for (let i = 0; i < players.length; i++) {
          const replaced = this.replacePlain(players[i], displayName, LIMIT.scoreEntity);
          if (replaced !== null) {
            players[i] = replaced;
            changed = true;
          }
        }
      }
      return changed;
    }

    return false;
  }
}
