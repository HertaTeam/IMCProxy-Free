#pragma once

#include <string>
#include <vector>

namespace imcp::features {

struct GameAccount {
    std::string account;
    std::string password;
    std::string note;
};

class GameAccounts {
public:
    explicit GameAccounts(std::string file);

    const std::string& file() const { return file_; }
    void load();
    void save() const;

    const std::vector<GameAccount>& entries() const { return entries_; }

    bool upsert(const std::string& account, const std::string& password, const std::string& note = "");
    bool remove(const std::string& reference);
    const GameAccount* resolve(const std::string& reference) const;
    const GameAccount* first() const;
    std::string describe() const;

private:
    std::string file_;
    std::vector<GameAccount> entries_;
};

bool parse_account_index(const std::string& reference, int& index);

}  // namespace imcp::features
