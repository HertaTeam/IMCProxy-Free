#pragma once

#include <string>
#include <vector>

#include "core/Config.hpp"

namespace imcp::features {

bool is_setting_group(const std::string& name);
std::vector<std::string> setting_group_help();
std::vector<std::string> run_setting_group(core::Config& config, const std::string& group, const std::string& rest,
                                           bool& failed);
std::vector<std::string> run_config_root(core::Config& config, const std::string& rest, bool& failed);
bool apply_setting(core::Config& config, const std::string& key, const std::string& text, std::string& error,
                   std::string& note);

}
