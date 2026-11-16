#pragma once

#include <string>

namespace imcp::features {

void ensure_runtime_files(const std::string& game_account, const std::string& imc_account,
                          const std::string& bind_code);

}  // namespace imcp::features
