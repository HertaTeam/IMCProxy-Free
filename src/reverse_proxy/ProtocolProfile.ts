/**
 * 协议档案：同一套代理逻辑要同时服务 1.8.9 与 1.12.2 两种客户端。
 *
 * 两个版本共用同一套"按名字"的包处理（chat / player_info / scoreboard …），
 * 但**数字包 ID 不同**，而且 1.12.2 里队伍包叫 `teams`。
 * 这里把差异集中成一张表，其它模块只查表、不写死数字。
 */

export type McVersion = "1.8.9" | "1.12.2";

export interface PacketIds {
  /** 服务端 → 客户端 聊天 */
  chat: number;
  /** 服务端 → 客户端 踢出/断开（kick_disconnect） */
  kick: number;
  /** player_info */
  playerInfo: number;
  /** scoreboard_objective */
  objective: number;
  /** scoreboard_score */
  score: number;
  /** scoreboard_team（1.12.2 叫 teams） */
  team: number;
  /** title */
  title: number;
  /** playerlist_header（Tab 页眉/页脚） */
  tabHeader: number;
  /** custom_payload（MC|Brand） */
  customPayload: number;
}

export interface ProtocolProfile {
  version: McVersion;
  /** 显示用名字，Beta 版本带标记 */
  label: string;
  /** 原版协议号（Eaglercraft 握手用） */
  protocol: number;
  beta: boolean;
  ids: PacketIds;
}

export const PROFILES: Record<McVersion, ProtocolProfile> = {
  "1.8.9": {
    version: "1.8.9",
    label: "1.8.9",
    protocol: 47,
    beta: false,
    ids: {
      chat: 0x02,
      kick: 0x40,
      playerInfo: 0x38,
      objective: 0x3b,
      score: 0x3c,
      team: 0x3e,
      title: 0x45,
      tabHeader: 0x47,
      customPayload: 0x3f,
    },
  },
  "1.12.2": {
    version: "1.12.2",
    label: "1.12.2 Beta",
    protocol: 340,
    beta: true,
    ids: {
      chat: 0x0f,
      kick: 0x1a,
      playerInfo: 0x2e,
      objective: 0x42,
      score: 0x45,
      team: 0x44,
      title: 0x48,
      tabHeader: 0x4a,
      customPayload: 0x18,
    },
  },
};

export const MC_VERSIONS: McVersion[] = ["1.8.9", "1.12.2"];

export function profileFor(version: McVersion): ProtocolProfile {
  return PROFILES[version];
}

/** 该版本下所有"可能含聊天组件/玩家名"的包 ID（用于快速预过滤） */
export function rewriteRelevantIds(profile: ProtocolProfile): Set<number> {
  const { ids } = profile;
  return new Set([ids.chat, ids.playerInfo, ids.objective, ids.score, ids.team, ids.title, ids.tabHeader, ids.customPayload]);
}
