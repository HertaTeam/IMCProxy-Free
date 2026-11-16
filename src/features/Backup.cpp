#include "features/Backup.hpp"

#include <algorithm>
#include <cstdio>
#include <ctime>
#include <filesystem>
#include <fstream>
#include <vector>

#include "core/Logger.hpp"

namespace imcp::features {

namespace {
core::Logger logger("Backup");
}


namespace {
constexpr int kMaxPerFile = 20;

std::string timestamp() {
    std::time_t now = std::time(nullptr);
    std::tm local{};
    localtime_s(&local, &now);
    char buffer[32];
    std::strftime(buffer, sizeof(buffer), "%Y%m%d-%H%M%S", &local);
    return buffer;
}

const char* kReadme =
    "This folder holds local backups (config + credentials).\n\n"
    "- Everything here is ignored by git.\n"
    "- Files named <name>-<timestamp>.<ext> are automatic backups taken before a change.\n"
    "- Folders named <timestamp>-<label>/ are manual snapshots taken by /backup.\n"
    "- Only the newest 20 automatic backups per file are kept.\n\n"
    "Safe to delete at any time.\n";

void prune(const std::filesystem::path& dir, const std::string& base, const std::string& extension) {
    std::vector<std::filesystem::directory_entry> stale;
    std::error_code error;
    for (const auto& entry : std::filesystem::directory_iterator(dir, error)) {
        if (!entry.is_regular_file()) continue;
        const std::string name = entry.path().filename().string();
        if (name.rfind(base + "-", 0) == 0 && name.size() > extension.size() &&
            name.compare(name.size() - extension.size(), extension.size(), extension) == 0) {
            stale.push_back(entry);
        }
    }
    std::sort(stale.begin(), stale.end(), [](const auto& left, const auto& right) {
        return std::filesystem::last_write_time(left) > std::filesystem::last_write_time(right);
    });
    for (size_t i = static_cast<size_t>(kMaxPerFile); i < stale.size(); ++i) {
        std::filesystem::remove(stale[i].path(), error);
    }
}
}  // namespace

std::string backup_dir() { return "backup"; }

std::string ensure_backup_dir() {
    std::error_code error;
    std::filesystem::create_directories(backup_dir(), error);
    const std::filesystem::path readme = std::filesystem::path(backup_dir()) / "README.txt";
    if (!std::filesystem::exists(readme)) {
        std::ofstream file(readme, std::ios::binary);
        if (file) file << kReadme;
    }
    return backup_dir();
}

std::string backup_file(const std::string& file, const std::string& subdir) {
    std::error_code error;
    if (!std::filesystem::is_regular_file(file, error)) return "";
    ensure_backup_dir();
    std::filesystem::path dir = backup_dir();
    if (!subdir.empty()) dir /= subdir;
    std::filesystem::create_directories(dir, error);

    const std::filesystem::path source(file);
    const std::string stem = source.stem().string();
    const std::string extension = source.extension().string();
    const std::filesystem::path target = dir / (stem + "-" + timestamp() + extension);
    std::filesystem::copy_file(file, target, std::filesystem::copy_options::overwrite_existing, error);
    if (error) {
        logger.warn("Backup failed for " + file + ": " + error.message());
        return "";
    }
    prune(dir, stem, extension);
    return target.string();
}

std::string snapshot(const std::string& label, const std::vector<std::string>& files) {
    const std::string stamp = timestamp();
    std::string folder = stamp;
    if (!label.empty()) folder += "-" + label;
    const std::filesystem::path dir = std::filesystem::path(backup_dir()) / folder;
    std::error_code error;
    std::filesystem::create_directories(dir, error);
    int copied = 0;
    for (const auto& file : files) {
        if (!std::filesystem::is_regular_file(file, error)) continue;
        std::filesystem::copy_file(file, dir / std::filesystem::path(file).filename(),
                                   std::filesystem::copy_options::overwrite_existing, error);
        if (!error) ++copied;
    }
    if (copied == 0) return "";
    return dir.string();
}


}  // namespace imcp::features
