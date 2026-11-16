#pragma once

#include <cstdint>
#include <mutex>
#include <set>
#include <memory>
#include <string>
#include <vector>

#include "core/Config.hpp"
#include "net/TcpListener.hpp"

namespace imcp::proxy {

class Server {
public:
    explicit Server(core::Config& config);

    bool start(std::string& error);
    void stop();
    bool running() const { return running_; }
    int player_count() const { return players_; }
    std::string current_id() const { return startup_id_; }
    void set_startup_id(std::string id) { startup_id_ = std::move(id); }
    std::string random_mode() const;

private:
    struct Slot {
        net::TcpListener listener;
        int protocol = 47;
        std::string version;
    };

    void handle_client(uintptr_t socket_handle, int protocol, const std::string& version);
    void handle_status(uintptr_t socket_handle, int protocol, const std::string& version);
    void handle_login(uintptr_t socket_handle, const std::string& requested, int protocol);
    std::string upstream_name(const std::string& requested);

    core::Config& config_;
    std::vector<std::unique_ptr<Slot>> slots_;
    bool running_ = false;
    int players_ = 0;
    std::string startup_id_;
    std::mutex pool_mutex_;
    std::set<std::string> active_ids_;
};

}  // namespace imcp::proxy
