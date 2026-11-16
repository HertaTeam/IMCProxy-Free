#include "features/Changelog.hpp"

#include "core/Logger.hpp"


namespace imcp::features {

namespace {
core::Logger logger("Launcher");
}


namespace {
const std::vector<ChangelogEntry> kEntries = {
    {"2.0.0",
     "2026-11-15",
     {"Free edition: C++ rewrite built with CMake",
      "1.8.9 and 1.12.2 proxy with Eaglercraft upstream",
      "Name protection and server name spoofing",
      "Local game account manager (game-accounts.txt)",
      "Console output format matches the official build"}},
    {"1.6.0",
     "2026-11-08",
     {"Server name spoofing covers chat, tab, title, brand and scoreboard",
      "Name protection respects per-field limits"}},
    {"1.5.0",
     "2026-10-31",
     {"Minecraft 1.12.2 Beta support on a separate port (tcpPort1122)",
      "Per-version protocol profile for packet ids and packet rewriting"}},
    {"1.4.0",
     "2026-10-30",
     {"Kick reasons parsed as chat components and printed line by line",
      "Game account manager with /gamestatus, /logingame, /gameadd and /gamedel"}},
    {"1.3.0",
     "2026-10-26",
     {"Automatic /login and /reg driven by server chat hints"}},
    {"1.2.0",
     "2026-10-24",
     {"Name protection no longer truncates JSON chat components",
      "Per-field limits plus a JSON validity guard against client disconnects"}},
    {"1.1.0",
     "2026-10-19",
     {"Removed the anticheat module",
      "Free edition: local account manager, console settings and backup"}},
    {"1.0.0", "2026-10-18", {"Initial build"}},
};
}  // namespace

const std::vector<ChangelogEntry>& changelog() { return kEntries; }

std::string app_version() {
#ifdef IMCP_VERSION
    return IMCP_VERSION;
#else
    return kEntries.front().version;
#endif
}

std::vector<std::string> changelog_lines(int limit) {
    std::vector<std::string> lines;
    if (limit <= 0) limit = static_cast<int>(kEntries.size());
    for (int i = 0; i < limit && i < static_cast<int>(kEntries.size()); ++i) {
        const auto& entry = kEntries[static_cast<size_t>(i)];
        lines.push_back("v" + entry.version + " (" + entry.date + ")");
        for (const auto& change : entry.changes) lines.push_back("  - " + change);
    }
    return lines;
}

void print_changelog(int limit) {
    for (const auto& line : changelog_lines(limit)) logger.info(line);
}

}  // namespace imcp::features
