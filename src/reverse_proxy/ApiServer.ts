import fs from "node:fs";
import http from "node:http";
import { Logger, recentLogs } from "../logger.js";
import {
  applyConfigValue,
  getConfigValue,
  isHotConfigKey,
  listConfigKeys,
  type ApiConfig,
} from "./config.js";

import { buildSettingSpecs, describeSetting, formatSettingValue, parseSettingValue, type SettingSpec } from "./SettingCommands.js";
import { APP_VERSION, CHANGELOG } from "./Changelog.js";
import type { ReverseProxy } from "./ReverseProxy.js";
import type { ConsoleCommands } from "./ConsoleCommands.js";

export interface ApiDeps {
  config: ApiConfig;
  proxy: ReverseProxy;
  commands: ConsoleCommands;
}

export class ApiServer {
  private logger = new Logger("Api");
  private server: http.Server | null = null;
  private startedAt = Date.now();
  private specs: SettingSpec[] = buildSettingSpecs();
  private specIndex: Map<string, SettingSpec> = new Map(this.specs.map((spec) => [spec.key.toLowerCase(), spec]));

  constructor(private readonly deps: ApiDeps) {}

  start(): void {
    const { config } = this.deps;
    if (!config.enabled) {
      this.logger.info("HTTP API disabled (config.json -> api.enabled = false).");
      return;
    }

    const server = http.createServer((req, res) => {
      void this.route(req, res).catch((err) => {
        this.sendJson(res, 500, { ok: false, error: (err as Error).message });
      });
    });

    server.on("error", (err: Error) => {
      this.logger.error(`HTTP API failed to listen on ${config.host}:${config.port}: ${err.message}`);
    });

    server.listen(config.port, config.host, () => {
      const host = config.host === "0.0.0.0" ? "127.0.0.1" : config.host;
      this.logger.info(`HTTP API: http://${host}:${config.port}/api`);
      if (config.token) this.logger.info("HTTP API token required (?token=... or X-Api-Token)");
    });

    this.server = server;
  }

  stop(): void {
    const server = this.server;
    this.server = null;
    if (server) server.close();
  }

  private async route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = (req.method ?? "GET").toUpperCase();

    if (!path.startsWith("/api")) {
      this.sendJson(res, 404, { ok: false, error: "not found" });
      return;
    }

    if (!this.authorized(url, req)) {
      this.sendJson(res, 401, { ok: false, error: "invalid token" });
      return;
    }

    if (path === "/api" && method === "GET") {
      this.sendJson(res, 200, {
        ok: true,
        name: "IMCProxy",
        uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
        endpoints: [
          "GET  /api/status",
          "GET  /api/config",
          "GET  /api/config/<key>",
          "POST /api/config/<key>  {value}",
          "POST /api/start",
          "POST /api/stop",
          "POST /api/command      {line}",
          "GET  /api/logs?tail=50",
        ],
      });
      return;
    }

    if (path === "/api/version" && method === "GET") {
      this.sendJson(res, 200, {
        ok: true,
        version: APP_VERSION,
        editDate: this.localEditDate(),
        changelog: CHANGELOG.map((entry) => ({ version: entry.version, date: entry.date })),
      });
      return;
    }

    if (path === "/api/changelog" && method === "GET") {
      this.sendJson(res, 200, { ok: true, current: APP_VERSION, entries: CHANGELOG });
      return;
    }

    if (path === "/api/status" && method === "GET") {
      this.sendJson(res, 200, this.status());
      return;
    }

    if (path === "/api/config" && method === "GET") {
      this.sendJson(res, 200, {
        ok: true,
        settings: this.specs.map((spec) => ({
          key: spec.key,
          type: spec.type,
          value: getConfigValue(spec.key),
        })),
      });
      return;
    }

    if (path.startsWith("/api/config/")) {
      const key = decodeURIComponent(path.slice("/api/config/".length));
      const spec = this.specIndex.get(key.toLowerCase());
      if (!spec) {
        this.sendJson(res, 404, { ok: false, error: `unknown setting "${key}"` });
        return;
      }

      if (method === "GET") {
        const value = getConfigValue(spec.key);
        this.sendJson(res, 200, {
          ok: true,
          key: spec.key,
          value,
          description: describeSetting(spec, value),
        });
        return;
      }

      if (method === "POST" || method === "PUT") {
        const body = await this.readBody(req);
        const raw = body.value !== undefined ? String(body.value) : url.searchParams.get("value");
        if (raw === null || raw === undefined || raw === "") {
          this.sendJson(res, 400, { ok: false, error: "missing value" });
          return;
        }
        const parsed = parseSettingValue(spec, raw);
        if (!parsed.ok) {
          this.sendJson(res, 400, {
            ok: false,
            error: parsed.message,
            key: spec.key,
            description: describeSetting(spec, getConfigValue(spec.key)),
          });
          return;
        }
        const oldValue = getConfigValue(spec.key);
        const result = applyConfigValue(spec.key, parsed.value);
        if (!result.ok) {
          this.sendJson(res, 400, { ok: false, error: result.message, key: spec.key });
          return;
        }
        this.sendJson(res, 200, {
          ok: true,
          key: spec.key,
          oldValue,
          newValue: getConfigValue(spec.key),
          valueText: formatSettingValue(getConfigValue(spec.key)),
          hot: isHotConfigKey(spec.key),
        });
        return;
      }

      this.sendJson(res, 405, { ok: false, error: "method not allowed" });
      return;
    }

    if (path === "/api/start" && method === "POST") {
      if (this.deps.proxy.isRunning()) {
        this.sendJson(res, 200, { ok: true, running: true, message: "already running" });
        return;
      }
      try {
        await this.deps.proxy.start();
        this.sendJson(res, 200, { ok: true, running: true });
      } catch (err) {
        this.sendJson(res, 500, { ok: false, running: false, error: (err as Error).message });
      }
      return;
    }

    if (path === "/api/stop" && method === "POST") {
      if (!this.deps.proxy.isRunning()) {
        this.sendJson(res, 200, { ok: true, running: false, message: "already stopped" });
        return;
      }
      try {
        await this.deps.proxy.stop();
        this.sendJson(res, 200, { ok: true, running: false });
      } catch (err) {
        this.sendJson(res, 500, { ok: false, error: (err as Error).message });
      }
      return;
    }

    if (path === "/api/command" && method === "POST") {
      const body = await this.readBody(req);
      const line = typeof body.line === "string" ? body.line.trim() : String(url.searchParams.get("line") ?? "").trim();
      if (!line) {
        this.sendJson(res, 400, { ok: false, error: "missing line" });
        return;
      }

      const output: string[] = [];
      const previous = Logger.capture;
      Logger.capture = (text) => output.push(text);
      try {
        this.deps.commands.handle(line);
        await new Promise((resolve) => setTimeout(resolve, 250));
      } finally {
        Logger.capture = previous;
      }
      this.sendJson(res, 200, { ok: true, line, output });
      return;
    }

    if (path === "/api/logs" && method === "GET") {
      const tail = Number(url.searchParams.get("tail") ?? "100");
      const limit = Number.isFinite(tail) && tail > 0 ? Math.min(Math.floor(tail), 300) : 100;
      this.sendJson(res, 200, { ok: true, lines: recentLogs(limit) });
      return;
    }

    this.sendJson(res, 404, { ok: false, error: "not found" });
  }

  private localEditDate(): string {
    try {
      if (fs.existsSync("version.json")) {
        const data = JSON.parse(fs.readFileSync("version.json", "utf8")) as { editDate?: string };
        if (typeof data.editDate === "string") return data.editDate;
      }
    } catch {
    }
    return "";
  }

  private status(): Record<string, unknown> {
    const proxy = this.deps.proxy as ReverseProxy & {
      getRandomIdMode?: () => string;
      getCurrentUpstreamId?: () => string | null;
    };
    const players = proxy.getPlayers().map((player) => ({
      name: player.username,
      upstream: player.upstreamUsername,
      uuid: player.uuid,
    }));

    return {
      ok: true,
      running: proxy.isRunning(),
      uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
      listen: {
        v189: `${String(getConfigValue("tcpHost") ?? "-")}:${String(getConfigValue("tcpPort") ?? "-")}`,
        v1122: getConfigValue("enable1122") === false
          ? "disabled"
          : `${String(getConfigValue("tcpHost") ?? "-")}:${String(getConfigValue("tcpPort1122") ?? "-")}`,
      },
      upstream: String(getConfigValue("eaglerServer") ?? "-"),
      randomId: {
        mode: typeof proxy.getRandomIdMode === "function" ? proxy.getRandomIdMode() : "off",
        current: typeof proxy.getCurrentUpstreamId === "function" ? proxy.getCurrentUpstreamId() : null,
      },
      players,
      playerCount: players.length,
    };
  }

  private authorized(url: URL, req: http.IncomingMessage): boolean {
    const token = this.deps.config.token;
    if (!token) return true;
    const fromQuery = url.searchParams.get("token") ?? "";
    const fromHeader = String(req.headers["x-api-token"] ?? "");
    return fromQuery === token || fromHeader === token;
  }

  private readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
        if (raw.length > 1024 * 1024) raw = raw.slice(0, 1024 * 1024);
      });
      req.on("end", () => {
        if (!raw) {
          resolve({});
          return;
        }
        try {
          const parsed = JSON.parse(raw);
          resolve(parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : { value: parsed });
        } catch {
          resolve({ value: raw });
        }
      });
      req.on("error", () => resolve({}));
    });
  }

  private sendJson(res: http.ServerResponse, code: number, payload: unknown): void {
    const body = JSON.stringify(payload);
    res.writeHead(code, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(body);
  }
}
