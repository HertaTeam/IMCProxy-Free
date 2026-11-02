/**
 * imc-overlay（内嵌版）
 *
 * 参考 https://github.com/lonivxy/imc-overlay 的数据思路与列式排版：
 *   对局名单 → 查 api.imc.re 公开战绩 → 排成一张对齐的表。
 *
 * 直接改写**客户端 Tab**，不额外弹窗：
 *   - playerlist_header / player_list_header_footer：表头 + 玩家行 + 汇总
 *
 * 只显示 IMC 真实有的数据：名字、终杀、F/D、胜场、W/L、拆床、BB/L、延迟、K/D。
 * 参考图里的 HP / S.Tags / Stars（等级）IMC 接口没有，一律不编造。
 *
 * 生命周期：
 *   - 聊天出现「正在连接 bw #4」→ 识别房间号，清缓存并立即重新查询
 *   - 收到 login（切换世界/房间）→ 关闭 overlay，清空本次数据
 */
import mcp from "minecraft-protocol";
import { Logger } from "../logger.js";
import type { ProtocolProfile } from "./ProtocolProfile.js";

const { createDeserializer, createSerializer, states } = mcp;

export interface OverlayOptions {
  enabled: boolean;
  /** auto = 由日志判断；bedwars = 强制打开；off = 关闭 */
  mode: "auto" | "bedwars" | "off";
  apiBase: string;
  refreshSeconds: number;
  topRows: number;
  /** 保留字段：是否改写玩家名（现在不加前缀，仅用于兼容旧配置） */
  decorateTab: boolean;
  timeoutMs: number;
}

export const DEFAULT_OVERLAY: OverlayOptions = {
  enabled: true,
  mode: "auto",
  apiBase: "https://api.imc.re",
  refreshSeconds: 300,
  topRows: 10,
  decorateTab: true,
  timeoutMs: 6000,
};

export interface OverlayStats {
  name: string;
  matches: number;
  wins: number;
  losses: number;
  winRate: number;
  mvps: number;
  fkdr: number;
  kd: number;
  avgBeds: number;
  rating: number;
  finalKills: number;
  finalDeaths: number;
  bedsBroken: number;
  kills: number;
  ping: number;
  fetchedAt: number;
  /** 数据看起来不正常（样本太少却数值爆表等） */
  anomaly: boolean;
  failed?: boolean;
}

/** 不带房间号的起床战争字样 */
const BEDWARS_PATTERNS = [
  "队的床",
  "床将在",
  "破坏自己队伍的床",
  "起床",
  "床战",
  "bedwars",
  "bed wars",
  "梦幻经验起床",
  "正在连接",
];

/** 公开接口没有 rating，按 imc-overlay 的 Rating Pro 公式本地估算（0.10 ~ 3.00） */
export function computeRatingPro(
  matches: number,
  wins: number,
  avgBeds: number,
  fkdr: number,
  kd: number
): number {
  if (!Number.isFinite(matches) || matches <= 0) return 0;
  const losses = Math.max(1, matches - wins);
  const wlr = wins / losses;
  const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);
  const F = clamp(Math.log2((Math.max(0, fkdr) + 1) / 2), -1, 3);
  const B = clamp(Math.log2(Math.max(0, avgBeds) + 0.5), -1, 2);
  const W = clamp(Math.log2((wlr + 1) / 2), -1, 2);
  const K = clamp(Math.log2((Math.max(0, kd) + 1) / 2), -1, 2);
  const P = 0.45 * F + 0.4 * B + 0.1 * W + 0.05 * K;
  const C = matches / (matches + 20);
  return clamp(1 + 1.25 * C * P, 0.1, 3);
}

/** 数据异常：样本太少却数值爆表，或本身矛盾 */
function looksAnomalous(matches: number, wins: number, fkdr: number, kd: number): boolean {
  if (!Number.isFinite(matches) || !Number.isFinite(fkdr) || !Number.isFinite(kd)) return true;
  if (matches < 0 || wins < 0) return true;
  if (wins > matches) return true;
  if (matches < 15 && (fkdr >= 10 || kd >= 10)) return true;
  if (fkdr > 50 || kd > 20) return true;
  return false;
}

export class ImcOverlay {
  private logger = new Logger("Overlay");
  private profile: ProtocolProfile;
  private deserializer: any;
  private serializer: any;
  private stats = new Map<string, OverlayStats>();
  private pings = new Map<string, number>();
  private roster = new Set<string>();
  private detected = false;
  /** 自己的服务端 ID（由 ReverseProxy 传入） */
  private selfName: string | null = null;
  /** 当前 bw 房间号（识别到才有） */
  private room: string | null = null;
  private lastRefresh = 0;
  private inFlight = new Set<string>();
  private warned = false;

  constructor(
    private readonly getOptions: () => OverlayOptions,
    profile: ProtocolProfile
  ) {
    this.profile = profile;
    this.deserializer = createDeserializer({
      state: states.PLAY,
      isServer: false,
      version: profile.version,
      customPackets: null,
      noErrorLogging: true,
    } as any);
    this.serializer = createSerializer({
      state: states.PLAY,
      isServer: true,
      version: profile.version,
      customPackets: null,
    });
  }

  private get options(): OverlayOptions {
    return this.getOptions();
  }

  /** 由 ReverseProxy 告知：当前玩家在服务器上的名字（不受 nameprotect 影响） */
  setSelf(name: string | null): void {
    const trimmed = (name ?? "").trim();
    if (!trimmed) return;
    if (this.selfName === trimmed) return;
    this.selfName = trimmed;
    this.roster.add(trimmed);
    void this.refresh(true);
  }

  self(): string | null {
    return this.selfName;
  }

  isActive(): boolean {
    const options = this.options;
    if (!options.enabled || options.mode === "off") return false;
    if (options.mode === "bedwars") return true;
    return this.detected;
  }

  isDetected(): boolean {
    return this.detected;
  }

  roomLabel(): string | null {
    return this.room;
  }

  /** 聊天内容里识别起床战争 / bw 房间号 */
  noteServerChat(plain: string): void {
    if (!this.options.enabled || this.options.mode === "off") return;

    const roomMatch = plain.match(/(?:正在连接|连接|进入)\s*([a-z]{2,4}\s*#?\s*\d+)/i) ?? plain.match(/(bw\s*#?\s*\d+)/i);
    if (roomMatch) {
      const room = roomMatch[1].replace(/\s+/g, " ").trim();
      const isNewRoom = room !== this.room;
      this.room = room;
      this.detected = true;
      if (isNewRoom) {
        this.logger.info(`BedWars room detected: ${room} - querying stats`);
        // 每次进入新房间都重新查
        this.stats.clear();
        this.lastRefresh = 0;
        void this.refresh(true);
      }
      return;
    }

    if (this.detected) return;
    const flat = plain.toLowerCase();
    if (!BEDWARS_PATTERNS.some((pattern) => flat.includes(pattern.toLowerCase()))) return;
    this.detected = true;
    this.logger.info("BedWars detected from server chat - Tab overlay enabled");
    void this.refresh(true);
  }

  /** 切换世界/房间：关闭 overlay 并清空本局数据 */
  noteWorldChange(): void {
    if (!this.detected && this.stats.size === 0) return;
    this.detected = false;
    this.room = null;
    this.stats.clear();
    this.roster.clear();
    this.lastRefresh = 0;
    this.logger.info("World changed - Tab overlay closed");
  }

  /** 记下名单：每个新玩家进入时单独查一次 */
  noteRoster(names: string[]): void {
    for (const name of names) {
      if (!name || name.length > 16) continue;
      if (this.roster.has(name)) continue;
      this.roster.add(name);
      this.checkPlayer(name);
    }
  }

  /** 单个玩家：没有缓存 / 缓存过期才查；失败 30s 内不重试 */
  private checkPlayer(name: string, force = false): void {
    if (!this.isActive()) return;
    if (this.inFlight.has(name)) return;
    const options = this.options;
    const now = Date.now();
    const cached = this.stats.get(name);
    if (!force && cached) {
      if (!cached.failed && now - cached.fetchedAt < options.refreshSeconds * 1000) return;
      if (cached.failed && now - cached.fetchedAt < 30_000) return;
    }
    if (!cached && this.stats.size >= 60) return;
    this.inFlight.add(name);
    void this.fetchOne(name).finally(() => this.inFlight.delete(name));
  }

  async refresh(force = false): Promise<void> {
    if (!this.isActive()) return;
    const options = this.options;
    const now = Date.now();
    if (!force && now - this.lastRefresh < options.refreshSeconds * 1000) return;
    this.lastRefresh = now;
    for (const name of Array.from(this.roster).slice(0, 40)) this.checkPlayer(name, force);
  }

  private async fetchOne(name: string): Promise<void> {
    const options = this.options;
    const base = options.apiBase.replace(/\/+$/, "");
    const url = `${base}/stats/bedwars/players/${encodeURIComponent(name)}`;
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "IMCProxy-Overlay", Accept: "application/json" },
        signal: AbortSignal.timeout(options.timeoutMs),
      } as any);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json: any = await res.json();
      const summary = json?.summary ?? json;
      const metrics = summary?.metrics ?? {};

      const matches = Number(summary?.matches ?? 0);
      const wins = Number(summary?.wins ?? 0);
      const fkdr = Number(metrics.fkdr ?? 0);
      const kd = Number(metrics.kd ?? 0);
      const avgBeds = Number(metrics.avgBeds ?? 0);
      const finalKills = Number(metrics.finalKills ?? 0);
      const rating = Number(metrics.rating ?? 0) || computeRatingPro(matches, wins, avgBeds, fkdr, kd);

      this.stats.set(name, {
        name,
        matches,
        wins,
        losses: Math.max(0, matches - wins),
        winRate: Number(summary?.winRate ?? 0),
        mvps: Number(summary?.mvps ?? 0),
        fkdr,
        kd,
        avgBeds,
        rating,
        finalKills,
        finalDeaths: fkdr > 0 ? finalKills / fkdr : 0,
        bedsBroken: Number(metrics.bedsBroken ?? 0),
        kills: Number(metrics.kills ?? 0),
        ping: this.pings.get(name) ?? 0,
        fetchedAt: Date.now(),
        anomaly: looksAnomalous(matches, wins, fkdr, kd),
      });
    } catch (err) {
      if (!this.warned) {
        this.warned = true;
        this.logger.warn(`Stats API unavailable: ${(err as Error).message}`);
      }
      this.stats.set(name, {
        name,
        matches: 0,
        wins: 0,
        losses: 0,
        winRate: 0,
        mvps: 0,
        fkdr: 0,
        kd: 0,
        avgBeds: 0,
        rating: 0,
        finalKills: 0,
        finalDeaths: 0,
        bedsBroken: 0,
        kills: 0,
        ping: this.pings.get(name) ?? 0,
        fetchedAt: Date.now(),
        anomaly: false,
        failed: true,
      });
    }
  }

  private ranked(): OverlayStats[] {
    return Array.from(this.stats.values())
      .filter((row) => !row.failed && row.matches > 0)
      .sort((a, b) => b.fkdr - a.fkdr);
  }

  /** 表头 + 玩家行（只保留 IMC 真实字段；异常行标红） */
  private buildTabText(): { header: string; footer: string } {
    const options = this.options;
    const rows = this.ranked().slice(0, Math.max(1, options.topRows));

    const pad = (text: string, width: number) =>
      text.length >= width ? text.slice(0, width) : text + " ".repeat(width - text.length);

    const lines = rows.map((row) => {
      const paint = row.anomaly ? "§c" : "§f";
      const cells = [
        pad(row.anomaly ? `${row.name}!` : row.name, 15),
        pad(String(row.finalKills), 5),
        pad(row.fkdr.toFixed(2), 5),
        pad(String(row.wins), 4),
        pad((row.wins / Math.max(1, row.losses)).toFixed(2), 5),
        pad(String(row.bedsBroken), 4),
        pad((row.bedsBroken / Math.max(1, row.losses)).toFixed(2), 5),
        pad(row.ping > 0 ? String(row.ping) : "-", 4),
        pad(row.kd.toFixed(2), 5),
      ];
      return (
        paint + cells[0] + " " +
        "§b" + cells[1] + " " + cells[2] + " " +
        "§a" + cells[3] + " " + cells[4] + " " +
        "§e" + cells[5] + " " + cells[6] + " " +
        "§7" + cells[7] + " " +
        "§c" + cells[8]
      );
    });

    const headers = [
      pad("Name", 15),
      pad("Final", 5),
      pad("F/D", 5),
      pad("Wins", 4),
      pad("W/L", 5),
      pad("Beds", 4),
      pad("BB/L", 5),
      pad("Ping", 4),
      pad("K/D", 5),
    ];
    const columnHeader = "§7" + headers.join(" ");

    const totals = rows.reduce(
      (acc, row) => ({
        kills: acc.kills + row.kills,
        finals: acc.finals + row.finalKills,
        beds: acc.beds + row.bedsBroken,
        suspect: acc.suspect + (row.anomaly ? 1 : 0),
      }),
      { kills: 0, finals: 0, beds: 0, suspect: 0 }
    );

    const title = this.room
      ? `§8§lIMC Overlay §7· §fBedWars §8${this.room}`
      : "§8§lIMC Overlay §7· §fBedWars";
    const header = [title, columnHeader, ...lines].join("\n");

    const me = this.selfName
      ? this.ranked().find((row) => row.name.toLowerCase() === this.selfName!.toLowerCase())
      : undefined;
    const suspect = totals.suspect > 0 ? ` §c| ${totals.suspect} suspicious` : "";
    const selfLine = me
      ? `§eYou §f${me.name} §7| §a${me.wins}W§7/§f${me.matches}M §eF/D §f${me.fkdr.toFixed(2)} §eK/D §f${me.kd.toFixed(2)} §eBeds §f${me.bedsBroken}` + suspect
      : this.selfName
        ? `§eYou §f${this.selfName} §7| §8no stats yet` + suspect
        : "§8no player linked";

    return { header, footer: selfLine };
  }

  /** 把服务端的 Tab 页眉/页脚换成战绩表；返回 null 表示不改 */
  rewriteTabPacket(data: Buffer): Buffer | null {
    if (!this.isActive()) return null;
    let parsed: any;
    try {
      parsed = this.deserializer.parsePacketBuffer(data);
    } catch {
      return null;
    }
    const name = parsed?.data?.name;
    if (name !== "playerlist_header" && name !== "player_list_header_footer") return null;

    const { header, footer } = this.buildTabText();
    try {
      return this.serializer.createPacketBuffer({
        name,
        params: { header: JSON.stringify({ text: header }), footer: JSON.stringify({ text: footer }) },
      });
    } catch {
      return null;
    }
  }

  /** 收集 player_info 里的名字与 ping；不再给名字加前缀 */
  rewritePlayerInfo(data: Buffer, playerNames: string[]): Buffer | null {
    if (!this.isActive()) return null;
    let parsed: any;
    try {
      parsed = this.deserializer.parsePacketBuffer(data);
    } catch {
      return null;
    }
    if (parsed?.data?.name !== "player_info") return null;
    const params: any = parsed.data.params;
    if (!Array.isArray(params?.data)) return null;

    const seen: string[] = [];
    for (const entry of params.data) {
      if (typeof entry?.name !== "string" || !entry.name) continue;
      seen.push(entry.name);
      if (typeof entry?.ping === "number") {
        this.pings.set(entry.name, entry.ping);
        const stats = this.stats.get(entry.name);
        if (stats) stats.ping = entry.ping;
      }
    }
    if (seen.length > 0 || playerNames.length > 0) this.noteRoster([...seen, ...playerNames]);

    // 名字不加前缀：只保留原版显示
    return null;
  }

  describe(): string {
    const options = this.options;
    return (
      `overlay: enabled=${options.enabled} mode=${options.mode} detected=${this.detected} ` +
      `room=${this.room ?? "-"} roster=${this.roster.size} stats=${this.ranked().length}`
    );
  }
}
