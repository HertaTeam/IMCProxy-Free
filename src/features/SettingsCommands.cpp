#include "features/SettingsCommands.hpp"

#include <algorithm>
#include <sstream>

#include "core/Logger.hpp"
#include "core/Settings.hpp"
#include "core/Util.hpp"
#include "features/Backup.hpp"

namespace imcp::features {

namespace {
core::Logger logger("Config");

const char* restart_note(std::string_view key) {
    if (key == "tcpHost" || key == "tcpPort" || key == "tcpPort1122" || key == "enable1122") return "restart listeners: /stop then /start";
    if (key == "api.enabled" || key == "api.host" || key == "api.port" || key == "api.token") return "restart listeners: /stop then /start";
    if (key == "debug") return "applies immediately";
    if (key == "nameProtect.enabled" || key == "nameProtect.name" || key.rfind("nameProtect.", 0) == 0) return "applies to new connections";
    if (key.rfind("serverNameSpoof.", 0) == 0) return "applies to new connections";
    return "applies immediately";
}

void put_value(core::Json& root, const std::string& key, const core::Json& value) {
    core::Json* current = &root;
    size_t start = 0;
    while (true) {
        const size_t dot = key.find('.', start);
        const std::string part = key.substr(start, dot == std::string::npos ? std::string::npos : dot - start);
        if (dot == std::string::npos) {
            (*current)[part] = value;
            return;
        }
        current = &(*current)[part];
        start = dot + 1;
    }
}
std::vector<std::string> split_words(const std::string& text) {
    std::vector<std::string> words;
    std::istringstream stream(text);
    std::string word;
    while (stream >> word) words.push_back(word);
    return words;
}

std::string join_words(const std::vector<std::string>& words) {
    std::string out;
    for (const auto& word : words) {
        if (!out.empty()) out += ' ';
        out += word;
    }
    return out;
}

bool group_exists(const core::Json& root, std::string_view group) {
    for (const auto* setting : core::all_settings()) {
        if (setting->group == group && core::available(*setting, root)) return true;
    }
    return false;
}
}

bool is_setting_group(const std::string& name) {
    static const char* groups[] = {"net", "id", "name", "spoof", "overlay", "auto", "api", "console", "imc"};
    return std::find(std::begin(groups), std::end(groups), name) != std::end(groups);
}

bool apply_setting(core::Config& config, const std::string& key, const std::string& text, std::string& error,
                   std::string& note) {
    const core::Setting* setting = core::find_setting(key);
    if (setting == nullptr) {
        error = "unknown setting \"" + key + "\"";
        return false;
    }
    if (!core::available(*setting, config.root())) {
        error = "\"" + key + "\" is not available in this edition";
        return false;
    }
    core::Json value;
    if (!core::parse_setting(*setting, text, value, error)) return false;

    core::Json candidate = config.root();
    put_value(candidate, key, value);

    backup_file("config.json");
    put_value(config.root(), key, value);
    if (!config.save()) {
        error = "cannot write " + config.path();
        return false;
    }
    note = restart_note(key);
    return true;
}

std::vector<std::string> setting_group_help() {
    std::vector<std::string> lines;
    const core::Json defaults = core::Config::defaults();
    std::string current;
    for (const auto* entry : core::all_settings()) {
        const core::Setting& setting = *entry;
        if (!core::available(setting, defaults)) continue;
        if (current != setting.group) {
            current = std::string(setting.group);
            lines.push_back("");
        }
        std::string line = "  /" + std::string(setting.group) + " " + std::string(setting.option) + " " +
                           std::string(setting.format);
        if (line.size() < 46) line.append(46 - line.size(), ' ');
        line += std::string(setting.help);
        lines.push_back(line);
    }
    return lines;
}

std::vector<std::string> run_setting_group(core::Config& config, const std::string& group, const std::string& rest,
                                           bool& failed) {
    std::vector<std::string> out;
    if (!group_exists(config.root(), group)) {
        out.push_back("unknown group /" + group);
        failed = true;
        return out;
    }
    const auto words = split_words(rest);
    if (words.empty()) {
        for (const auto* entry : core::all_settings()) {
            const core::Setting& setting = *entry;
            if (setting.group != group || !core::available(setting, config.root())) continue;
            std::string line = "  " + std::string(setting.option);
            if (line.size() < 14) line.append(14 - line.size(), ' ');
            line += core::setting_value_text(config.root(), setting);
            line += "   " + std::string(setting.format);
            out.push_back(line);
        }
        out.push_back("read one: /" + group + " <option>    write: /" + group + " <option> <value>");
        return out;
    }

    const core::Setting* setting = core::find_option(group, words[0]);
    if (setting == nullptr || !core::available(*setting, config.root())) {
        std::string line = "unknown option \"" + words[0] + "\" for /" + group + "; valid options: ";
        bool first = true;
        for (const auto* entry : core::all_settings()) {
            const core::Setting& item = *entry;
            if (item.group != group || !core::available(item, config.root())) continue;
            if (!first) line += ", ";
            line += std::string(item.option);
            first = false;
        }
        out.push_back(line);
        failed = true;
        return out;
    }

    if (words.size() == 1) {
        out.push_back("  " + std::string(setting->option) + " = " + core::setting_value_text(config.root(), *setting));
        out.push_back("  " + std::string(setting->format) + "   " + std::string(setting->help));
        return out;
    }

    const std::string text = join_words({words.begin() + 1, words.end()});
    std::string error;
    std::string note;
    if (!apply_setting(config, std::string(setting->key), text, error, note)) {
        out.push_back(error);
        out.push_back("current value kept: " + core::setting_value_text(config.root(), *setting));
        failed = true;
        return out;
    }
    out.push_back(std::string(setting->key) + " = " + core::setting_value_text(config.root(), *setting) + "   (" + note + ")");
    return out;
}

std::vector<std::string> run_config_root(core::Config& config, const std::string& rest, bool& failed) {
    std::vector<std::string> out;
    const std::string action = core::to_lower(core::trim(rest));
    if (action.empty() || action == "help") {
        out.push_back("config is edited through the dedicated commands, not one blob:");
        out.push_back("  /net      listen address, ports, upstream server");
        out.push_back("  /id       random id mode and length");
        out.push_back("  /name     name protection");
        out.push_back("  /spoof    server name spoofing");
        out.push_back("  /auto     in game automation");
        out.push_back("  /api      HTTP API");
        out.push_back("  /console  console behaviour");
        out.push_back("  /config reload   re-read config.json from disk");
        out.push_back("  /config validate check config.json without applying");
        out.push_back("  /config show     print the effective values");
        return out;
    }
    if (action == "reload") {
        core::Json before = config.root();
        std::string error;
        if (!config.reload(error)) {
            out.push_back("reload failed: " + error);
            out.push_back("running with the previous values");
            failed = true;
            return out;
        }
        std::string adjusted;
        if (!core::validate_settings(config.root(), adjusted)) {
            config.root() = before;
            config.save();
            out.push_back("reload rejected: " + adjusted);
            out.push_back("running with the previous values");
            failed = true;
            return out;
        }
        if (!adjusted.empty()) out.push_back("clamped out of range values: " + adjusted);
        core::Logger::set_verbose(config.get_bool("debug", false));
        out.push_back("config.json reloaded and applied");
        out.push_back("port or API changes still need /stop then /start");
        return out;
    }
    if (action == "validate") {
        std::string error;
        core::Json candidate = config.root();
        if (!config.reload(error)) {
            out.push_back("config.json is invalid: " + error);
            failed = true;
            return out;
        }
        if (!core::validate_settings(candidate, error)) {
            out.push_back("config.json is out of range: " + error);
            failed = true;
            return out;
        }
        out.push_back("config.json is valid");
        return out;
    }
    if (action == "show") {
        for (const auto* entry : core::all_settings()) {
            const core::Setting& setting = *entry;
            if (!core::available(setting, config.root())) continue;
            std::string line = "  " + std::string(setting.key);
            if (line.size() < 34) line.append(34 - line.size(), ' ');
            line += core::setting_value_text(config.root(), setting);
            out.push_back(line);
        }
        return out;
    }
    out.push_back("usage: /config [reload|validate|show]");
    failed = true;
    return out;
}

}
