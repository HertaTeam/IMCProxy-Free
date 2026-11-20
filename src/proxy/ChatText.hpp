#pragma once

#include <functional>
#include <string>
#include <vector>

#include "core/Json.hpp"

namespace imcp::proxy {

std::string component_plain(const std::string& json_text);

bool replace_in_component(core::Json& node, const std::vector<std::string>& names, const std::string& display);

bool rewrite_component_text(const std::string& json_text, const std::vector<std::string>& names,
                            const std::string& display, int max_chars, std::string& out);

std::string replace_plain_text(const std::string& text, const std::vector<std::string>& names,
                               const std::string& display);

bool map_component_text(core::Json& node, const std::function<std::string(const std::string&)>& transform);

}  // namespace imcp::proxy
