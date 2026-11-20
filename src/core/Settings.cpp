#include "core/Settings.hpp"

#include <algorithm>
#include <cctype>
#include <charconv>
#include <iterator>
#include <string>
#include <vector>

#include "core/Config.hpp"
#include "core/Util.hpp"

namespace imcp::core {

namespace {
constexpr Setting make(std::string_view group, std::string_view option, std::string_view key, SettingKind kind,
                       std::string_view format, std::string_view help, int minimum = 0, int maximum = 0) {
    Setting setting{};
    setting.group = group;
    setting.option = option;
    setting.key = key;
    setting.kind = kind;
    setting.format = format;
    setting.help = help;
    setting.minimum = minimum;
    setting.maximum = maximum;
    return setting;
}

const Setting table[] = {
    make("net", "host", "tcpHost", SettingKind::Address, "<address>", "listen address, 0.0.0.0 for every interface"),
    make("net", "port", "tcpPort", SettingKind::Integer, "<1-65535>", "1.8.9 listen port", 1, 65535),
    make("net", "port1122", "tcpPort1122", SettingKind::Integer, "<1-65535>", "1.12.2 listen port", 1, 65535),
    make("net", "enable1122", "enable1122", SettingKind::Flag, "<on|off>", "open the 1.12.2 listener"),
    make("net", "server", "eaglerServer", SettingKind::SocketUrl, "<ws://host[:port]|wss://host[:port]>",
         "upstream Eaglercraft WebSocket"),
    make("net", "origin", "eaglerOrigin", SettingKind::HttpUrl, "<https://host>", "Origin header for the upstream"),
    make("net", "agent", "eaglerUserAgent", SettingKind::Text, "<text>", "User-Agent header for the upstream"),
    make("net", "maxplayers", "maxPlayers", SettingKind::Integer, "<1-128>", "shown in the server list", 1, 128),
    make("net", "skin", "defaultSkinId", SettingKind::Integer, "<0-255>", "skin id sent to the upstream", 0, 255),
    make("net", "motd", "motd", SettingKind::Text, "<text>", "server list description"),

    make("id", "mode", "randomId.mode", SettingKind::Choice, "<off|startup|pool>", "upstream id strategy"),
    make("id", "length", "randomId.length", SettingKind::Integer, "<3-16>", "generated id length", 3, 16),
    make("id", "pool", "randomId.preferPool", SettingKind::Flag, "<on|off>", "prefer account pool ids"),

    make("name", "enabled", "nameProtect.enabled", SettingKind::Flag, "<on|off>", "rewrite your name client side"),
    make("name", "display", "nameProtect.name", SettingKind::Text, "<name>", "display name used by name protect"),
    make("name", "playlist", "nameProtect.playlist", SettingKind::Flag, "<on|off>", "also rewrite the player list"),
    make("name", "chat", "nameProtect.chat", SettingKind::Flag, "<on|off>", "also rewrite chat"),
    make("name", "scoreboard", "nameProtect.scoreboard", SettingKind::Flag, "<on|off>", "also rewrite the scoreboard"),

    make("spoof", "enabled", "serverNameSpoof.enabled", SettingKind::Flag, "<on|off>", "rewrite the server name"),
    make("spoof", "chat", "serverNameSpoof.targets.chat", SettingKind::Flag, "<on|off>", "apply to chat"),
    make("spoof", "tab", "serverNameSpoof.targets.tab", SettingKind::Flag, "<on|off>", "apply to the tab list"),
    make("spoof", "title", "serverNameSpoof.targets.title", SettingKind::Flag, "<on|off>", "apply to titles"),
    make("spoof", "brand", "serverNameSpoof.targets.brand", SettingKind::Flag, "<on|off>", "apply to the brand"),
    make("spoof", "scoreboard", "serverNameSpoof.targets.scoreboard", SettingKind::Flag, "<on|off>",
         "apply to the scoreboard"),
    make("spoof", "map", "serverNameSpoof.mappings", SettingKind::Mappings, "<from=to[,from=to]>",
         "replacement pairs, empty clears"),

    make("overlay", "enabled", "overlay.enabled", SettingKind::Flag, "<on|off>", "enable the tab overlay"),
    make("overlay", "mode", "overlay.mode", SettingKind::Choice, "<auto|bedwars|off>", "when the overlay opens"),
    make("overlay", "rows", "overlay.topRows", SettingKind::Integer, "<1-40>", "rows shown in the overlay", 1, 40),
    make("overlay", "refresh", "overlay.refreshSeconds", SettingKind::Integer, "<30-3600>",
         "cache lifetime in seconds", 30, 3600),
    make("overlay", "tab", "overlay.decorateTab", SettingKind::Flag, "<on|off>", "decorate the tab header"),

    make("auto", "enabled", "automation.enabled", SettingKind::Flag, "<on|off>", "in game automation"),
    make("auto", "replies", "automation.inGameReplies", SettingKind::Flag, "<on|off>", "send [auto] notices in chat"),
    make("auto", "login", "automation.autoLoginOnJoin", SettingKind::Flag, "<on|off>", "auto /login on request"),
    make("auto", "register", "automation.autoRegisterOnJoin", SettingKind::Flag, "<on|off>", "auto /reg on request"),

    make("api", "enabled", "api.enabled", SettingKind::Flag, "<on|off>", "enable the HTTP API"),
    make("api", "host", "api.host", SettingKind::Address, "<address>", "HTTP API bind address"),
    make("api", "port", "api.port", SettingKind::Integer, "<1-65535>", "HTTP API port", 1, 65535),
    make("api", "token", "api.token", SettingKind::Text, "<token>", "required token, empty disables auth"),

    make("console", "help", "console.autoHelp", SettingKind::Flag, "<on|off>", "print help on start"),
    make("console", "status", "console.autoStatus", SettingKind::Flag, "<on|off>", "print status on start"),
    make("console", "echo", "console.echo", SettingKind::Flag, "<on|off>", "echo commands"),
};

const Setting imc_table[] = {
    make("imc", "base", "imc.baseUrl", SettingKind::HttpUrl, "<https://host>", "api.imc.re base url"),
    make("imc", "token", "imc.apiToken", SettingKind::Text, "<token>", "api token, empty uses the cookie"),
    make("imc", "autologin", "imc.autoLogin", SettingKind::Flag, "<on|off>", "sign in automatically on start"),
    make("imc", "browser", "imc.browserLogin", SettingKind::Flag, "<on|off>", "fall back to the browser sign in"),
    make("imc", "headless", "imc.browserHeadless", SettingKind::Flag, "<on|off>", "run the browser hidden"),
    make("imc", "keepbrowser", "imc.keepBrowserSession", SettingKind::Flag, "<on|off>", "reuse the browser profile"),
    make("imc", "browserpath", "imc.browserPath", SettingKind::Text, "<path>", "browser executable, empty auto"),
    make("imc", "timeout", "imc.browserTimeoutMs", SettingKind::Integer, "<10000-600000>",
         "browser sign in timeout in ms", 10000, 600000),
};

const Setting auto_pool[] = {
    make("auto", "imc", "automation.autoImcOnJoin", SettingKind::Flag, "<on|off>", "auto web password on request"),
    make("auto", "bind", "automation.autoBindOnJoin", SettingKind::Flag, "<on|off>", "auto /bind on request"),
    make("auto", "account", "automation.gameAccountFile", SettingKind::Text, "<file>", "single account file"),
    make("auto", "imcfile", "automation.imcAccountFile", SettingKind::Text, "<file>", "imc account pool file"),
    make("auto", "bindfile", "automation.bindCodeFile", SettingKind::Text, "<file>", "bind code file"),
    make("auto", "password", "automation.defaultGamePassword", SettingKind::Text, "<password>",
         "fallback game password"),
};

const Setting free_pool[] = {
    make("auto", "accounts", "automation.gameAccountsFile", SettingKind::Text, "<file>", "game account list file"),
    make("auto", "password", "automation.defaultGamePassword", SettingKind::Text, "<password>",
         "fallback game password"),
};

std::string lower(std::string_view text) { return core::to_lower(std::string(text)); }

bool parse_flag(std::string_view text, bool& value) {
    const std::string word = lower(text);
    if (word == "on" || word == "true" || word == "1" || word == "yes") {
        value = true;
        return true;
    }
    if (word == "off" || word == "false" || word == "0" || word == "no") {
        value = false;
        return true;
    }
    return false;
}

bool parse_int(std::string_view text, int& value) {
    int parsed = 0;
    const auto result = std::from_chars(text.data(), text.data() + text.size(), parsed);
    if (result.ec != std::errc{} || result.ptr != text.data() + text.size()) return false;
    value = parsed;
    return true;
}

bool valid_host(std::string_view text) {
    if (text.empty() || text.size() > 64) return false;
    int dots = 0;
    for (char c : text) {
        if (c == '.') {
            ++dots;
            continue;
        }
        if (!std::isdigit(static_cast<unsigned char>(c))) return false;
    }
    return dots == 3;
}

bool valid_url(std::string_view text, bool websocket) {
    const std::string lowered = lower(text);
    const bool secure = lowered.rfind(websocket ? "wss://" : "https://", 0) == 0;
    const bool plain = lowered.rfind(websocket ? "ws://" : "http://", 0) == 0;
    if (!secure && !plain) return false;
    const size_t start = lowered.find("://") + 3;
    return lowered.size() > start + 3 && lowered.size() <= 512;
}
}

std::span<const Setting> settings() { return {table, std::size(table)}; }

std::vector<const Setting*> all_settings() {
    std::vector<const Setting*> out;
    for (const auto& setting : table) out.push_back(&setting);
    for (const auto& setting : imc_table) out.push_back(&setting);
    for (const auto& setting : auto_pool) out.push_back(&setting);
    for (const auto& setting : free_pool) out.push_back(&setting);
    return out;
}

const Setting* find_setting(std::string_view key) {
    for (const auto& setting : settings()) {
        if (setting.key == key) return &setting;
    }
    for (const auto& setting : imc_table) {
        if (setting.key == key) return &setting;
    }
    for (const auto& setting : auto_pool) {
        if (setting.key == key) return &setting;
    }
    for (const auto& setting : free_pool) {
        if (setting.key == key) return &setting;
    }
    return nullptr;
}

bool available(const Setting& setting, const Json& root) {
#ifdef IMCP_FREE_EDITION
    if (setting.group == "imc") return false;
#endif
    return !root.path(setting.key).is_null();
}

const Setting* find_option(std::string_view group, std::string_view option) {
    for (const auto& setting : settings()) {
        if (setting.group == group && setting.option == option) return &setting;
    }
    for (const auto& setting : imc_table) {
        if (setting.group == group && setting.option == option) return &setting;
    }
    for (const auto& setting : auto_pool) {
        if (setting.group == group && setting.option == option) return &setting;
    }
    for (const auto& setting : free_pool) {
        if (setting.group == group && setting.option == option) return &setting;
    }
    return nullptr;
}

std::string setting_value_text(const Json& root, const Setting& setting) {
    const Json& value = root.path(setting.key);
    if (setting.key == "api.token" || setting.key == "imc.apiToken" || setting.key == "automation.defaultGamePassword") return value.is_null() || value.as_string().empty() ? "(unset)" : "***";
    return value.is_null() ? "(unset)" : value.dump(0);
}

bool parse_setting(const Setting& setting, std::string_view text, Json& value, std::string& error) {
    const std::string input = core::trim(std::string(text));
    switch (setting.kind) {
        case SettingKind::Flag: {
            bool flag = false;
            if (!parse_flag(input, flag)) {
                error = "expected on or off for " + std::string(setting.key);
                return false;
            }
            value = Json(flag);
            return true;
        }
        case SettingKind::Integer: {
            int number = 0;
            if (!parse_int(input, number)) {
                error = "expected a number for " + std::string(setting.key);
                return false;
            }
            if (number < setting.minimum || number > setting.maximum) {
                error = std::string(setting.key) + " must be between " + std::to_string(setting.minimum) + " and " +
                        std::to_string(setting.maximum);
                return false;
            }
            value = Json(static_cast<int64_t>(number));
            return true;
        }
        case SettingKind::Choice: {
            const std::string word = lower(input);
            if (setting.key == "randomId.mode") {
                if (word != "off" && word != "startup" && word != "pool") {
                    error = "mode must be off, startup or pool";
                    return false;
                }
            } else if (setting.key == "overlay.mode") {
                if (word != "auto" && word != "bedwars" && word != "off") {
                    error = "overlay mode must be auto, bedwars or off";
                    return false;
                }
            }
            value = Json(word);
            return true;
        }
        case SettingKind::Address: {
            if (!valid_host(input)) {
                error = "expected an IPv4 address such as 127.0.0.1";
                return false;
            }
            value = Json(input);
            return true;
        }
        case SettingKind::SocketUrl: {
            if (!valid_url(input, true)) {
                error = "expected ws:// or wss:// followed by a host";
                return false;
            }
            value = Json(input);
            return true;
        }
        case SettingKind::HttpUrl: {
            if (!valid_url(input, false)) {
                error = "expected http:// or https:// followed by a host";
                return false;
            }
            value = Json(input);
            return true;
        }
        case SettingKind::Mappings: {
            Json list = Json::array();
            if (!input.empty()) {
                size_t start = 0;
                while (start <= input.size()) {
                    const size_t comma = input.find(',', start);
                    const std::string part =
                        core::trim(input.substr(start, comma == std::string::npos ? std::string::npos : comma - start));
                    if (!part.empty()) {
                        const size_t equals = part.find('=');
                        if (equals == std::string::npos || equals == 0) {
                            error = "expected from=to pairs separated by commas";
                            return false;
                        }
                        Json item = Json::object();
                        item["from"] = core::trim(part.substr(0, equals));
                        item["to"] = core::trim(part.substr(equals + 1));
                        list.push(item);
                    }
                    if (comma == std::string::npos) break;
                    start = comma + 1;
                }
            }
            value = list;
            return true;
        }
        case SettingKind::Text: {
            if (input.empty() && setting.key != "nameProtect.name" &&
                setting.key != "api.token" && setting.key != "imc.apiToken" &&
                setting.key != "automation.defaultGamePassword" && setting.key != "imc.browserPath") {
                error = std::string(setting.key) + " cannot be empty";
                return false;
            }
            if (input.size() > 1024) {
                error = std::string(setting.key) + " is too long";
                return false;
            }
            value = Json(input);
            return true;
        }
    }
    error = "unsupported setting type";
    return false;
}

Json& put_ref(Json& root, std::string_view key_view) {
    const std::string key(key_view);
    Json* current = &root;
    size_t start = 0;
    while (true) {
        const size_t dot = key.find('.', start);
        const std::string part = key.substr(start, dot == std::string::npos ? std::string::npos : dot - start);
        current = &(*current)[part];
        if (dot == std::string::npos) return *current;
        start = dot + 1;
    }
}
bool validate_settings(Json& root, std::string& error) {
    error.clear();
    std::string adjusted;
    const Json defaults = Config::defaults();
    for (const auto* entry : all_settings()) {
        const Setting& setting = *entry;
        if (!available(setting, root)) continue;
        Json& current = put_ref(root, setting.key);
        if (setting.kind == SettingKind::Integer) {
            const Json fallback = defaults.path(setting.key);
            const int64_t minimum = setting.minimum;
            const int64_t maximum = setting.maximum;
            int64_t value = current.is_number() ? current.as_int() : fallback.as_int();
            if (value < minimum || value > maximum) {
                const int64_t clamped = value < minimum ? minimum : maximum;
                if (!adjusted.empty()) adjusted += ", ";
                adjusted += std::string(setting.key) + " " + std::to_string(value) + " -> " + std::to_string(clamped);
                value = clamped;
            }
            current = Json(value);
        } else if (setting.kind == SettingKind::Flag) {
            if (!current.is_boolean()) {
                const bool fallback = defaults.path(setting.key).is_boolean() ? defaults.path(setting.key).as_bool() : false;
                current = Json(fallback);
            }
        }
    }
    error = adjusted;
    return true;
}

}
