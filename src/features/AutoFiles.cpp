#include "features/AutoFiles.hpp"

#include <filesystem>
#include <fstream>

#include "core/Logger.hpp"

namespace imcp::features {

namespace {
core::Logger logger("AutoFiles");
}


namespace {
void ensure_file(const std::string& path, const std::string& content) {
    std::error_code error;
    if (std::filesystem::exists(path, error)) return;
    std::filesystem::create_directories(std::filesystem::path(path).parent_path(), error);
    std::ofstream stream(path, std::ios::binary | std::ios::trunc);
    if (!stream) {
        logger.warn("Cannot create " + path);
        return;
    }
    stream << content;
    logger.info("Created " + path);
}
}  // namespace

void ensure_runtime_files(const std::string& game_account, const std::string& imc_account,
                          const std::string& bind_code) {
    (void)imc_account;
    (void)bind_code;
    ensure_file(game_account, "# <game account> <game password>\n");
    ensure_file("game-accounts.txt", "# 游戏账号列表（凭据，勿提交）\n# 格式：账号 密码 [备注]\n\n");
}


}  // namespace imcp::features
