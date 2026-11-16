#pragma once

#include <cstdint>
#include <string>
#include <string_view>

namespace imcp::core {

std::string uuid_from_bytes(const std::string& raw16);
std::string random_name(int length);
std::string to_lower(std::string value);
std::string trim(std::string value);
bool starts_with(std::string_view text, std::string_view prefix);
int utf16_length(const std::string& text);
std::string clamp_utf16(const std::string& text, int max_units);

}
