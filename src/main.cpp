#include <windows.h>

#include <algorithm>
#include <cctype>
#include <cstdio>
#include <ctime>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <map>
#include <thread>
#include <memory>
#include <sstream>
#include <string>
#include <vector>

#include "core/Config.hpp"
#include "core/ConsoleInput.hpp"
#include "core/Json.hpp"
#include "core/Logger.hpp"
#include "core/Util.hpp"
#include "features/Backup.hpp"
#include "features/Banner.hpp"
#include "features/Changelog.hpp"
#include "features/GameAccounts.hpp"
#include "features/AutoFiles.hpp"
#include "net/HttpApi.hpp"
#include "net/HttpClient.hpp"
#include "proxy/Server.hpp"

namespace {

using imcp::core::Config;
using imcp::core::Json;
using imcp::core::Logger;

imcp::core::Logger console_logger("Console");
imcp::core::Logger launcher("Launcher");

Config g_config;
std::unique_ptr<imcp::proxy::Server> g_server;
std::unique_ptr<imcp::net::HttpApi> g_api;

std::string timestamp_name() {
    std::time_t now = std::time(nullptr);
    std::tm local{};
    localtime_s(&local, &now);
    char buffer[32];
    std::strftime(buffer, sizeof(buffer), "%Y%m%d-%H%M%S", &local);
    return buffer;
}

void flatten(const Json& node, const std::string& prefix, std::vector<std::pair<std::string, Json>>& out) {
    if (!node.is_object()) return;
    for (const auto& [key, value] : node.members()) {
        std::string path = prefix.empty() ? key : prefix + "." + key;
        out.emplace_back(path, value);
        if (value.is_object()) flatten(value, path, out);
    }
}

bool write_setting(const std::string& key, const std::string& value) {
    auto& logger = console_logger;
    const Json& current = g_config.root().path(key);
    if (current.is_number()) {
        try {
            g_config.set_int(key, std::stoll(value));
        } catch (...) {
            logger.warn("expected a number for " + key);
            return false;
        }
    } else if (current.is_boolean()) {
        const std::string lowered = imcp::core::to_lower(value);
        if (lowered == "true" || lowered == "on" || lowered == "1") {
            g_config.set_bool(key, true);
        } else if (lowered == "false" || lowered == "off" || lowered == "0") {
            g_config.set_bool(key, false);
        } else {
            logger.warn("expected true/false for " + key);
            return false;
        }
    } else if (current.is_string()) {
        g_config.set_string(key, value);
    } else {
        logger.warn("unknown setting: " + key);
        return false;
    }
    imcp::features::backup_file("config.json");
    g_config.save();
    logger.info(key + " updated");
    return true;
}

bool setting_command(const std::string& command, const std::string& argument) {
    std::vector<std::pair<std::string, Json>> flat;
    flatten(g_config.root(), "", flat);

    std::vector<std::string> matches;
    for (const auto& [key, value] : flat) {
        if (value.is_object()) continue;
        const std::string lower = imcp::core::to_lower(key);
        std::string last = lower;
        const size_t dot = lower.rfind('.');
        if (dot != std::string::npos) last = lower.substr(dot + 1);
        if (lower == command || last == command) matches.push_back(key);
    }
    if (matches.empty()) return false;

    auto& logger = console_logger;
    if (matches.size() > 1) {
        logger.warn("Ambiguous setting \"" + command + "\":");
        for (const auto& item : matches) logger.info("  " + item);
        return true;
    }

    const std::string& key = matches[0];
    if (argument.empty()) {
        logger.kv(key, g_config.root().path(key).dump(0));
        return true;
    }
    write_setting(key, argument);
    return true;
}

void print_banner() {
    std::cout << "IMCProxy " << imcp::features::app_version() << " (C++)\n";
    std::cout << "Minecraft 1.8.9 / 1.12.2 adapter for Eaglercraft servers\n\n";
}

void print_status() {
    auto& logger = console_logger;
    logger.section("Status");
    logger.kv("Version", imcp::features::app_version());
    logger.kv("Config file", g_config.path());
    logger.kv("Listen 1.8.9", g_config.get_string("tcpHost", "0.0.0.0") + ":" + std::to_string(g_config.get_int("tcpPort", 25565)));
    const bool beta = g_config.get_bool("enable1122", true);
    logger.kv("Listen 1.12.2", beta ? g_config.get_string("tcpHost", "0.0.0.0") + ":" + std::to_string(g_config.get_int("tcpPort1122", 25566))
                                   : "disabled");
    logger.kv("Upstream", g_config.get_string("eaglerServer", "-"));
    logger.kv("Proxy", g_server && g_server->running() ? "running" : "stopped");
    logger.kv("Players", std::to_string(g_server ? g_server->player_count() : 0));
    const std::string mode = g_config.get_string("randomId.mode", "off");
    logger.kv("Random ID", mode + (g_server && !g_server->current_id().empty() ? " (" + g_server->current_id() + ")" : ""));
    logger.kv("HTTP API", (g_config.get_bool("api.enabled", true) ? "enabled " : "disabled ") +
                              g_config.get_string("api.host", "127.0.0.1") + ":" +
                              std::to_string(g_config.get_int("api.port", 8790)) +
                              (g_api && g_api->running() ? " (listening)" : ""));
    logger.kv("Name protect", g_config.get_bool("nameProtect.enabled", false)
                                  ? "enabled (" + g_config.get_string("nameProtect.name", "") + ")"
                                  : "disabled");
    logger.kv("Server spoof", g_config.get_bool("serverNameSpoof.enabled", true) ? "enabled" : "disabled");
}

void print_help() {
    auto& logger = console_logger;
    logger.section("Console commands");
    logger.info("  /help                       show this help");
    logger.info("  /status                     show current state");
    logger.info("  /start /stop                start or stop the listener");
    logger.info("  /<setting> [value]          read or write one setting (eg. /overlay.mode auto)");
    logger.info("  /gamestatus                 list saved game accounts");
    logger.info("  /logingame <#|account>      use a saved game account");
    logger.info("  /gameadd <account> <pass>   save a game account");
    logger.info("  /gamedel <#|account>        delete a game account");
    logger.info("  /settings [section]         list every setting");
    logger.info("  /backup [label]             snapshot config + account files");
    logger.info("  /loginimc <user> <pass> [cap]  sign in to api.imc.re");
    logger.info("  /setname <name> /randomname  set the protected display name");
    logger.info("  /api                        show HTTP API endpoints");
    logger.info("  /changelog [all|version]    show the changelog");
    logger.info("  /config <key> <value>       same as /<key> <value>");
    logger.info("  /rid /sid <id>              random or custom upstream ID");
    logger.info("  /log [on|off]               toggle debug logging");
    logger.info("  /quit                       exit");
}

void start_proxy() {
    auto& logger = console_logger;
    if (!g_server) return;
    if (g_server->running()) {
        logger.info("Proxy already running");
        return;
    }
    std::string error;
    if (g_server->start(error)) {
        launcher.info("\xe2\x9c\x93 Reverse proxy is now running!");
        launcher.info("Connect with your Minecraft 1.8.9 client to start playing.");
    } else {
        logger.error("Cannot listen: " + error);
        return;
    }
    if (g_api && !g_api->running()) {
        std::string api_error;
        g_api->start(api_error);
    }
}

void stop_proxy() {
    if (g_api) g_api->stop();
    if (!g_server) return;
    g_server->stop();
    launcher.info("Reverse proxy has stopped.");
}

std::vector<std::string> run_command(const std::string& raw);

void handle_command(const std::string& raw);

std::vector<std::string> run_command(const std::string& raw) {
    std::vector<std::string> lines;
    auto& logger = console_logger;
    logger.set_capture([&lines](std::string_view text) { lines.emplace_back(std::string(text)); });
    handle_command(raw);
    logger.clear_capture();
    return lines;
}

void handle_command(const std::string& raw) {
    std::string line = imcp::core::trim(raw);
    if (line.empty()) return;
    if (line[0] == '/') line.erase(0, 1);
    std::istringstream stream(line);
    std::string command;
    stream >> command;
    command = imcp::core::to_lower(command);
    static const std::map<std::string, std::string> aliases = {
            {"randomid", "rid"},
        {"setid", "sid"},
    };
    if (const auto alias = aliases.find(command); alias != aliases.end()) command = alias->second;
    std::string rest;
    std::getline(stream, rest);
    rest = imcp::core::trim(rest);

    auto& logger = console_logger;
    if (command == "help" || command == "?") {
        print_help();
    } else if (command == "status") {
        print_status();
    } else if (command == "start") {
        start_proxy();
    } else if (command == "stop") {
        stop_proxy();
    } else if (command == "gamestatus") {
        imcp::features::GameAccounts accounts(g_config.get_string("automation.gameAccountsFile", "game-accounts.txt"));
        logger.section("Game accounts");
        if (accounts.entries().empty()) {
            logger.info("  (empty) use /gameadd <account> <password>");
        } else {
            int index = 0;
            for (const auto& entry : accounts.entries()) {
                ++index;
                std::string line = "  #" + std::to_string(index) + "  " + entry.account + "  " + entry.password;
                if (!entry.note.empty()) line += "  # " + entry.note;
                logger.info(line);
            }
        }
        logger.info(accounts.describe());
    } else if (command == "logingame") {
        imcp::features::GameAccounts accounts(g_config.get_string("automation.gameAccountsFile", "game-accounts.txt"));
        const auto* picked = accounts.resolve(rest);
        if (picked == nullptr) {
            logger.warn("usage: /logingame <#index|account>");
            return;
        }
        if (g_server) g_server->set_startup_id(picked->account);
        write_setting("randomId.mode", "off");
        logger.info("Next connection will use game account \"" + picked->account + "\"");
    } else if (command == "gameadd") {
        std::istringstream game_stream(rest);
        std::string account;
        std::string password;
        std::string note;
        game_stream >> account >> password;
        std::getline(game_stream, note);
        if (account.empty() || password.empty()) {
            logger.warn("usage: /gameadd <account> <password> [note]");
            return;
        }
        imcp::features::GameAccounts accounts(g_config.get_string("automation.gameAccountsFile", "game-accounts.txt"));
        accounts.upsert(account, password, imcp::core::trim(note));
        logger.info("Game account saved: " + account);
    } else if (command == "gamedel") {
        const std::string ref = imcp::core::trim(rest);
        imcp::features::GameAccounts accounts(g_config.get_string("automation.gameAccountsFile", "game-accounts.txt"));
        if (accounts.remove(ref)) {
            logger.info("Game account removed: " + ref);
        } else {
            logger.warn("No such game account: " + ref);
        }
    } else if (command == "rid") {
        const int length = static_cast<int>(g_config.get_int("randomId.length", 8));
        std::string id = imcp::core::random_name(length < 3 ? 3 : length > 16 ? 16 : length);
        if (g_server) g_server->set_startup_id(id);
        g_config.set_string("randomId.mode", "startup");
        g_config.save();
        logger.info("Random ID reset: \"" + id + "\"");
    } else if (command == "sid") {
        const std::string id = rest;
        const bool valid = id.size() >= 3 && id.size() <= 16 &&
                           std::all_of(id.begin(), id.end(), [](char c) {
                               return std::isalnum(static_cast<unsigned char>(c)) || c == '_';
                           });
        if (!valid) {
            logger.warn("Invalid ID \"" + id + "\": must be 3-16 characters using only a-z A-Z 0-9 _");
            return;
        }
        if (g_server) g_server->set_startup_id(id);
        g_config.set_string("randomId.mode", "startup");
        g_config.save();
        logger.info("Custom ID set: \"" + id + "\"");
    } else if (command == "log" || command == "debug") {
        const std::string argument = imcp::core::to_lower(rest);
        bool enabled = !Logger::verbose();
        if (argument == "on") enabled = true;
        else if (argument == "off") enabled = false;
        Logger::set_verbose(enabled);
        logger.info(std::string("Packet debug logging ") + (enabled ? "enabled" : "disabled"));
    } else if (command == "changelog") {
        if (rest == "all" || rest.empty()) {
            imcp::features::print_changelog(rest == "all" ? 0 : 2);
        } else {
            int printed = 0;
            for (const auto& entry : imcp::features::changelog()) {
                if (entry.version.find(rest) != std::string::npos) {
                    logger.section("v" + entry.version + " (" + entry.date + ")");
                    for (const auto& change : entry.changes) logger.info("  - " + change);
                    ++printed;
                }
            }
            if (printed == 0) logger.warn("No changelog entry matches \"" + rest + "\"");
        }
    } else if (command == "api") {
        logger.section("HTTP API");
        logger.info("  " + g_config.get_string("api.host", "127.0.0.1") + ":" +
                    std::to_string(g_config.get_int("api.port", 8790)) +
                    (g_api && g_api->running() ? "  (listening)" : "  (stopped)"));
        for (const char* endpoint : {"GET /api", "GET /api/status", "GET /api/config", "GET /api/config/<key>",
                                     "POST /api/config/<key>", "POST /api/start", "POST /api/stop",
                                     "POST /api/command", "GET /api/changelog", "GET /api/version"}) {
            logger.info("  " + std::string(endpoint));
        }
    } else if (command == "setname") {
        const std::string name = imcp::core::trim(rest);
        if (name.empty()) {
            logger.warn("usage: /setname <display name>");
            return;
        }
        write_setting("nameProtect.name", name);
        write_setting("nameProtect.enabled", "true");
    } else if (command == "randomname") {
        const std::string name = imcp::core::random_name(8);
        write_setting("nameProtect.name", name);
        write_setting("nameProtect.enabled", "true");
        logger.info("Random display name: " + name);
    } else if (command == "backup") {
        const std::string folder = imcp::features::snapshot(
            imcp::core::trim(rest),
            {"config.json", g_config.get_string("automation.gameAccountFile", "game-account.txt"),
             g_config.get_string("automation.imcAccountFile", "imc-account.txt"),
             g_config.get_string("automation.bindCodeFile", "bind-code.txt")});
        if (folder.empty()) {
            logger.warn("Nothing to back up (no config or account files)");
        } else {
            logger.info("Snapshot written to " + folder);
        }
    } else if (command == "settings") {
        std::vector<std::pair<std::string, Json>> flat;
        flatten(g_config.root(), "", flat);
        const std::string filter = imcp::core::to_lower(rest);
        int shown = 0;
        for (const auto& [key, value] : flat) {
            if (value.is_object()) continue;
            const std::string lower = imcp::core::to_lower(key);
            if (!filter.empty() && lower.find(filter) == std::string::npos) continue;
            logger.kv(key, value.dump(0));
            ++shown;
        }
        logger.info(std::to_string(shown) + " settings. Use /<key> to read, /<key> <value> to write.");
    } else if (command == "config") {
        std::istringstream rest_stream(rest);
        std::string key;
        rest_stream >> key;
        std::string value;
        std::getline(rest_stream, value);
        value = imcp::core::trim(value);
        if (key.empty() || value.empty()) {
            logger.warn("usage: /config <key> <value>");
            return;
        }
        write_setting(key, value);
    } else if (command == "quit" || command == "exit") {
        stop_proxy();
        std::exit(0);
    } else if (!setting_command(command, rest)) {
        logger.warn("Unknown command \"" + command + "\". Type /help to list commands.");
    }
}

}  // namespace

int main() {
    SetConsoleOutputCP(CP_UTF8);
    SetConsoleCP(CP_UTF8);

    imcp::features::print_banner();
    Logger::start_run_log("logs");

    if (!g_config.load("config.json")) {
        launcher.error("Cannot read or create config.json");
        Logger::close_run_log();
        return 1;
    }
    Logger::set_verbose(g_config.get_bool("debug", false));

    g_server = std::make_unique<imcp::proxy::Server>(g_config);
    g_api = std::make_unique<imcp::net::HttpApi>(g_config, g_server.get(),
                                                 [](const std::string& line) { return run_command(line); });

    imcp::features::ensure_runtime_files(
        g_config.get_string("automation.gameAccountFile", "game-account.txt"),
        g_config.get_string("automation.imcAccountFile", "imc-account.txt"),
        g_config.get_string("automation.bindCodeFile", "bind-code.txt"));

    launcher.section("IMCProxy");
    launcher.kv("Config file", std::string(reinterpret_cast<const char*>(std::filesystem::absolute("config.json").u8string().c_str())));
    launcher.kv("Log file", Logger::log_file_path());
    launcher.kv("Backup folder", std::string(reinterpret_cast<const char*>(std::filesystem::absolute("backup").u8string().c_str())));
    launcher.kv("Listen", g_config.get_string("tcpHost", "0.0.0.0") + ":" + std::to_string(g_config.get_int("tcpPort", 25565)));
    launcher.kv("Listen (1.12.2 Beta)",
                g_config.get_bool("enable1122", true)
                    ? g_config.get_string("tcpHost", "0.0.0.0") + ":" + std::to_string(g_config.get_int("tcpPort1122", 25566)) +
                          " â MOTD shows a Beta notice"
                    : "disabled (enable1122 = false)");
    launcher.kv("Upstream server", g_config.get_string("eaglerServer", "-"));
    launcher.kv("Max players", std::to_string(g_config.get_int("maxPlayers", 1)));
    launcher.kv("Random ID mode", g_config.get_string("randomId.mode", "off"));
    launcher.kv("Debug mode", g_config.get_bool("debug", false) ? "true" : "false");
    launcher.kv("Console", "autoHelp=" + std::string(g_config.get_bool("console.autoHelp", false) ? "true" : "false") +
                               " autoStatus=" + std::string(g_config.get_bool("console.autoStatus", false) ? "true" : "false") +
                               " echo=" + std::string(g_config.get_bool("console.echo", true) ? "true" : "false"));

    launcher.section("Changelog");
    imcp::features::print_changelog(2);
    launcher.info("Run /changelog to see the full history.");

    launcher.section("Accounts");
    launcher.kv("In-game automation", g_config.get_bool("automation.enabled", true) ? "enabled" : "disabled");
    {
        imcp::features::GameAccounts accounts(g_config.get_string("automation.gameAccountsFile", "game-accounts.txt"));
        launcher.kv("Game accounts", std::to_string(accounts.entries().size()) + " in game-accounts.txt" +
                                         (accounts.entries().empty() ? "" : ", first: " + accounts.entries().front().account));
    }
    launcher.kv("nameprotect", g_config.get_bool("nameProtect.enabled", false)
                                   ? "enabled (display as \"" + g_config.get_string("nameProtect.name", "") + "\")"
                                   : "disabled");
    launcher.info("");

    launcher.debug(std::string("console input: ") +
                   (imcp::core::ConsoleInput::interactive() ? "interactive" : "line mode"));

    start_proxy();


    if (imcp::core::ConsoleInput::interactive()) {
        imcp::core::ConsoleInput::install([](const std::string& line) { run_command(line); });
        while (true) std::this_thread::sleep_for(std::chrono::milliseconds(200));
    }

    std::string line;
    while (true) {
        std::fputs(Logger::colors_enabled() ? "\x1b[32m> \x1b[0m" : "> ", stdout);
        std::fflush(stdout);
        if (!std::getline(std::cin, line)) break;
        run_command(line);
    }
    Logger::close_run_log();
    return 0;
}
