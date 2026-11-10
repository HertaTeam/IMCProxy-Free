export type McVersion = "1.8.9" | "1.12.2";

export interface PacketIds {

  chat: number;

  kick: number;

  playerInfo: number;

  objective: number;

  score: number;

  team: number;

  title: number;

  tabHeader: number;

  joinGame: number;

  respawn: number;

  customPayload: number;
}

export interface ProtocolProfile {
  version: McVersion;

  label: string;

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
      joinGame: 0x01,
      respawn: 0x07,
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
      joinGame: 0x23,
      respawn: 0x35,
    },
  },
};

export const MC_VERSIONS: McVersion[] = ["1.8.9", "1.12.2"];

export function profileFor(version: McVersion): ProtocolProfile {
  return PROFILES[version];
}

export function rewriteRelevantIds(profile: ProtocolProfile): Set<number> {
  const { ids } = profile;
  return new Set([ids.chat, ids.playerInfo, ids.objective, ids.score, ids.team, ids.title, ids.tabHeader, ids.customPayload]);
}
