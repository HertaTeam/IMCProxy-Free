#pragma once

#include <span>
#include <string>
#include <string_view>
#include <vector>

#include "core/Json.hpp"

namespace imcp::core {

enum class SettingKind { Flag, Integer, Text, Choice, Address, SocketUrl, HttpUrl, Mappings };

struct Setting {
    std::string_view group;
    std::string_view option;
    std::string_view key;
    SettingKind kind;
    std::string_view format;
    std::string_view help;
    int minimum = 0;
    int maximum = 0;
};

std::span<const Setting> settings();
std::vector<const Setting*> all_settings();
const Setting* find_setting(std::string_view key);
const Setting* find_option(std::string_view group, std::string_view option);
bool available(const Setting& setting, const Json& root);
bool parse_setting(const Setting& setting, std::string_view text, Json& value, std::string& error);
bool validate_settings(Json& root, std::string& error);
std::string setting_value_text(const Json& root, const Setting& setting);

}
