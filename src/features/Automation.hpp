#pragma once

#include <cstdint>
#include <functional>
#include <map>
#include <string>

#include "core/Config.hpp"

namespace imcp::features {

class Automation {
public:
    using Sender = std::function<bool(const std::string& payload)>;

    explicit Automation(core::Config& config);
    ~Automation();

    void set_sender(Sender sender) { sender_ = std::move(sender); }
    void set_client_sender(Sender sender) { client_sender_ = std::move(sender); }
    void set_chat_packet_id(uint8_t id) { chat_id_ = id; }
    void set_game_credentials(std::string account, std::string password);

    void note_chat(const std::string& plain);

private:
    bool enabled() const;
    bool has_pending(const std::string& kind) const;
    void mark_pending(const std::string& kind);
    std::string current_password() const;
    void send(const std::string& message, const std::string& reason);
    void to_player(const std::string& message);

    core::Config& config_;
    Sender sender_;
    Sender client_sender_;
    uint8_t chat_id_ = 0x02;
    std::string account_;
    std::string password_;
    std::map<std::string, long long> pending_;
};

}  // namespace imcp::features
