#include "features/GameAccounts.hpp"

#include <algorithm>
#include <cctype>
#include <fstream>
#include <sstream>

#include "core/Logger.hpp"
#include "core/Util.hpp"

namespace imcp::features {

namespace {
core::Logger logger("GameAccounts");

const char* kHeader =
    "# 游戏账号列表（凭据，勿提交）\n"
    "# 格式：账号 密码 [备注]\n"
    "# 由 /gameadd 写入，/logingame 使用\n\n";
}  // namespace

bool parse_account_index(const std::string& reference, int& index) {
    std::string text = core::trim(reference);
    if (!text.empty() && text[0] == '#') text.erase(0, 1);
    if (text.empty()) return false;
    if (!std::all_of(text.begin(), text.end(), [](unsigned char c) { return std::isdigit(c) != 0; })) return false;
    try {
        const int value = std::stoi(text);
        if (value < 1) return false;
        index = value;
        return true;
    } catch (...) {
        return false;
    }
}

GameAccounts::GameAccounts(std::string file) : file_(std::move(file)) { load(); }

void GameAccounts::load() {
    entries_.clear();
    std::ifstream stream(file_, std::ios::binary);
    if (!stream) return;
    std::string text((std::istreambuf_iterator<char>(stream)), std::istreambuf_iterator<char>());
    if (text.size() >= 3 && static_cast<unsigned char>(text[0]) == 0xEF &&
        static_cast<unsigned char>(text[1]) == 0xBB && static_cast<unsigned char>(text[2]) == 0xBF) {
        text.erase(0, 3);
    }
    std::istringstream lines(text);
    std::string line;
    while (std::getline(lines, line)) {
        line = core::trim(line);
        if (line.empty() || line[0] == '#') continue;
        std::istringstream fields(line);
        GameAccount entry;
        if (!(fields >> entry.account >> entry.password)) continue;
        std::string note;
        std::getline(fields, note);
        entry.note = core::trim(note);
        entries_.push_back(entry);
    }
}

void GameAccounts::save() const {
    std::ofstream stream(file_, std::ios::binary | std::ios::trunc);
    if (!stream) {
        logger.warn("cannot write " + file_);
        return;
    }
    stream << kHeader;
    for (const auto& entry : entries_) {
        stream << entry.account << " " << entry.password;
        if (!entry.note.empty()) stream << " " << entry.note;
        stream << "\n";
    }
}

bool GameAccounts::upsert(const std::string& account, const std::string& password, const std::string& note) {
    for (auto& entry : entries_) {
        if (core::to_lower(entry.account) != core::to_lower(account)) continue;
        entry.password = password;
        if (!note.empty()) entry.note = note;
        save();
        return true;
    }
    entries_.push_back(GameAccount{account, password, note});
    save();
    return true;
}

bool GameAccounts::remove(const std::string& reference) {
    const GameAccount* target = resolve(reference);
    if (target == nullptr) return false;
    const std::string account = target->account;
    entries_.erase(std::remove_if(entries_.begin(), entries_.end(),
                                  [&](const GameAccount& entry) { return entry.account == account; }),
                   entries_.end());
    save();
    return true;
}

const GameAccount* GameAccounts::resolve(const std::string& reference) const {
    std::string text = core::trim(reference);
    if (text.empty()) return nullptr;
    int index = 0;
    if (parse_account_index(text, index)) {
        if (index >= 1 && static_cast<size_t>(index) <= entries_.size()) return &entries_[static_cast<size_t>(index - 1)];
        return nullptr;
    }
    for (const auto& entry : entries_) {
        if (core::to_lower(entry.account) == core::to_lower(text)) return &entry;
    }
    return nullptr;
}

const GameAccount* GameAccounts::first() const {
    if (entries_.empty()) return nullptr;
    return &entries_.front();
}

std::string GameAccounts::describe() const {
    return std::to_string(entries_.size()) + " game account(s) in " + file_;
}

}  // namespace imcp::features
