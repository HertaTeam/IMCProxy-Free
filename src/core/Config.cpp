#include "core/Config.hpp"

#include <filesystem>
#include <fstream>
#include <sstream>

namespace imcp::core {

namespace {
Json map_of(std::initializer_list<std::pair<const char*, Json>> items) {
    Json object = Json::object();
    for (const auto& [key, value] : items) object[key] = value;
    return object;
}

std::vector<std::string> split(std::string_view text, char separator) {
    std::vector<std::string> parts;
    size_t start = 0;
    while (start <= text.size()) {
        size_t pos = text.find(separator, start);
        parts.emplace_back(text.substr(start, pos == std::string_view::npos ? text.size() - start : pos - start));
        if (pos == std::string_view::npos) break;
        start = pos + 1;
    }
    return parts;
}
}

Json Config::defaults() {
    Json root = Json::object();
    root["tcpHost"] = "0.0.0.0";
    root["tcpPort"] = 25565;
    root["tcpPort1122"] = 25566;
    root["enable1122"] = true;
    root["eaglerServer"] = "wss://mc.smgoro.com";
    root["eaglerOrigin"] = "https://ws.imc.re";
    root["eaglerUserAgent"] =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/130.0.0.0 Safari/537.36";
    root["maxPlayers"] = 1;
    root["defaultSkinId"] = 0;
    root["debug"] = true;

    root["randomId"] = map_of({{"auto", true}, {"mode", "startup"}, {"length", 8}, {"preferAccounts", true}});
    root["console"] = map_of({{"autoHelp", false}, {"autoStatus", false}, {"echo", true}});

    root["nameProtect"] = map_of({{"enabled", false},
                                  {"name", ""},
                                  {"playlist", true},
                                  {"chat", true},
                                  {"scoreboard", true}});

    Json mappings = Json::array();
    Json mapping = map_of({{"from", "imc"}, {"to", "hey pixel"}});
    mappings.push(mapping);

    Json targets = map_of({{"chat", true}, {"tab", true}, {"scoreboard", true}, {"title", true}, {"brand", true}});
    Json spoof = Json::object();
    spoof["enabled"] = true;
    spoof["caseInsensitive"] = true;
    spoof["mappings"] = mappings;
    spoof["targets"] = targets;
    root["serverNameSpoof"] = spoof;

    root["automation"] = map_of({{"enabled", true},
                                 {"gameAccountFile", "game-account.txt"},
                                 {"gameAccountsFile", "game-accounts.txt"},
                                 {"defaultGamePassword", ""},
                                 {"inGameReplies", true},
                                 {"autoLoginOnJoin", true},
                                 {"autoRegisterOnJoin", true}});

    root["overlay"] = map_of({{"enabled", true},
                              {"mode", "auto"},
                              {"cacheFile", ".overlay-cache.json"},
                              {"apiBase", "https://api.imc.re"},
                              {"refreshSeconds", 300},
                              {"topRows", 10},
                              {"decorateTab", true},
                              {"timeoutMs", 6000}});
    root["api"] = map_of({{"enabled", true}, {"host", "127.0.0.1"}, {"port", 8790}, {"token", ""}});

    return root;
}

void Config::merge_missing(Json& target, const Json& fallback) {
    if (!fallback.is_object()) return;
    if (!target.is_object()) {
        target = fallback;
        return;
    }
    for (const auto& [key, value] : fallback.members()) {
        if (!target.has(key)) {
            target[key] = value;
        } else if (value.is_object()) {
            merge_missing(target[key], value);
        }
    }
}

bool Config::load(const std::string& path) {
    path_ = path;
    Json defaults_root = defaults();
    std::ifstream file(path);
    if (!file) {
        root_ = defaults_root;
        return save();
    }
    std::stringstream buffer;
    buffer << file.rdbuf();
    try {
        root_ = Json::parse(buffer.str());
    } catch (...) {
        root_ = defaults_root;
        return save();
    }
    merge_missing(root_, defaults_root);
    return save();
}

bool Config::reload(std::string& error) {
    std::ifstream file(path_);
    if (!file) {
        error = "cannot open " + path_;
        return false;
    }
    std::stringstream buffer;
    buffer << file.rdbuf();
    Json parsed;
    try {
        parsed = Json::parse(buffer.str());
    } catch (const std::exception& exception) {
        error = std::string("invalid JSON: ") + exception.what();
        return false;
    }
    if (!parsed.is_object()) {
        error = "config root must be a JSON object";
        return false;
    }
    merge_missing(parsed, defaults());
    root_ = std::move(parsed);
    error.clear();
    return true;
}

bool Config::save() const { return save_as(path_); }

bool Config::save_as(const std::string& path) const {
    std::ofstream file(path, std::ios::binary | std::ios::trunc);
    if (!file) return false;
    file << root_.dump(2) << "\n";
    return true;
}

std::string Config::get_string(std::string_view dotted, std::string fallback) const {
    const Json& value = root_.path(dotted);
    return value.is_string() ? value.as_string() : fallback;
}

int64_t Config::get_int(std::string_view dotted, int64_t fallback) const {
    const Json& value = root_.path(dotted);
    return value.is_number() ? value.as_int() : fallback;
}

bool Config::get_bool(std::string_view dotted, bool fallback) const {
    const Json& value = root_.path(dotted);
    return value.is_boolean() ? value.as_bool() : fallback;
}

bool Config::set_string(std::string_view dotted, std::string value) {
    auto parts = split(dotted, '.');
    Json* current = &root_;
    for (size_t i = 0; i + 1 < parts.size(); ++i) current = &(*current)[parts[i]];
    (*current)[parts.back()] = Json(std::move(value));
    return true;
}

bool Config::set_int(std::string_view dotted, int64_t value) {
    auto parts = split(dotted, '.');
    Json* current = &root_;
    for (size_t i = 0; i + 1 < parts.size(); ++i) current = &(*current)[parts[i]];
    (*current)[parts.back()] = Json(value);
    return true;
}

bool Config::set_bool(std::string_view dotted, bool value) {
    auto parts = split(dotted, '.');
    Json* current = &root_;
    for (size_t i = 0; i + 1 < parts.size(); ++i) current = &(*current)[parts[i]];
    (*current)[parts.back()] = Json(value);
    return true;
}

}
