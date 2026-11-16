#pragma once

#include <string>
#include <vector>

namespace imcp::features {

std::string backup_dir();
std::string ensure_backup_dir();
std::string backup_file(const std::string& file, const std::string& subdir = "");
std::string snapshot(const std::string& label, const std::vector<std::string>& files);

}  // namespace imcp::features
