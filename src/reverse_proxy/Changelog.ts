export interface ChangelogEntry {
  version: string;
  date: string;
  changes: string[];
}

export const APP_VERSION = "1.6.0";

export const CHANGELOG: ChangelogEntry[] = [
  {
    version: "1.6.0",
    date: "2026-11-08",
    changes: [
      "Tab overlay with real BedWars stats from api.imc.re",
      "One stats query per newly seen player; switching worlds closes the overlay",
      "Suspicious rows marked red; own stats shown in the footer",
      "New logo",
    ],
  },
  {
    version: "1.5.0",
    date: "2026-10-31",
    changes: [
      "Minecraft 1.12.2 Beta support on a separate port (tcpPort1122)",
      "Per-version protocol profile for packet ids and packet rewriting",
    ],
  },
  {
    version: "1.4.0",
    date: "2026-10-30",
    changes: [
      "imc.re chat-password login (send the web password directly in chat)",
      "Bind state written back to the account pool after a successful login",
    ],
  },
  {
    version: "1.3.0",
    date: "2026-10-26",
    changes: [
      "Kick reasons parsed as chat components and printed line by line",
      "Server name spoofing for chat, tab, scoreboard, title and brand",
    ],
  },
  {
    version: "1.2.0",
    date: "2026-10-24",
    changes: [
      "Name protection no longer truncates JSON chat components",
      "Per-field limits plus a JSON validity guard against client disconnects",
    ],
  },
  {
    version: "1.1.0",
    date: "2026-10-19",
    changes: [
      "Removed the anticheat module",
      "Free edition: account manager, update check and per-section console settings",
    ],
  },
  {
    version: "1.0.0",
    date: "2026-10-18",
    changes: ["Initial build"],
  },
];

export function changelogLines(limit = 3): string[] {
  const lines: string[] = [];
  for (const entry of CHANGELOG.slice(0, Math.max(1, limit))) {
    lines.push(`v${entry.version} (${entry.date})`);
    for (const change of entry.changes) lines.push(`  - ${change}`);
  }
  return lines;
}

export function changelogFor(keyword: string): ChangelogEntry[] {
  const value = keyword.trim().toLowerCase();
  if (!value) return CHANGELOG.slice(0, 3);
  if (value === "all") return CHANGELOG;
  return CHANGELOG.filter((entry) => entry.version.includes(value) || entry.date.includes(value));
}
