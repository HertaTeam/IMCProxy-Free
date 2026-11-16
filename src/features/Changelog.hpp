#pragma once

#include <string>
#include <vector>

namespace imcp::features {

struct ChangelogEntry {
    std::string version;
    std::string date;
    std::vector<std::string> changes;
};

const std::vector<ChangelogEntry>& changelog();
std::string app_version();

void print_changelog(int limit);

std::vector<std::string> changelog_lines(int limit);

}
