#pragma once

#include <atomic>
#include <functional>
#include <map>
#include <mutex>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#include "core/Config.hpp"

namespace imcp::proxy {

struct OverlayRow {
    std::string name;
    int matches = 0;
    int wins = 0;
    int losses = 0;
    double fkdr = 0.0;
    double kd = 0.0;
    double avg_beds = 0.0;
    double rating = 0.0;
    int final_kills = 0;
    int beds_broken = 0;
    int kills = 0;
    int ping = 0;
    bool anomaly = false;
    bool failed = false;
};

class Overlay {
public:
    using Sender = std::function<bool(const std::string& payload)>;

    Overlay(core::Config& config, Sender sender);
    ~Overlay();

    void start();
    void stop();

    void set_self(const std::string& name);
    void set_tab_packet_id(uint8_t id) { tab_id_ = id; }
    void note_chat(const std::string& plain);
    void note_player_info(const std::vector<std::pair<std::string, int>>& entries);
    void note_world_change();

    bool is_active() const;
    std::string describe() const;

private:
    void worker();
    void refresh(bool force);
    void fetch_one(const std::string& name);
    std::vector<OverlayRow> ranked() const;
    std::string build_header() const;
    std::string build_footer() const;
    void send_tab();
    void load_cache();
    void save_cache() const;
    std::string cache_path() const;
    bool enabled() const;
    std::string mode() const;

    core::Config& config_;
    Sender sender_;
    std::thread worker_;
    std::atomic<bool> running_{false};

    mutable std::mutex mutex_;
    std::map<std::string, OverlayRow> stats_;
    std::map<std::string, int> pings_;
    std::vector<std::string> roster_;
    std::string self_name_;
    std::string room_;
    bool detected_ = false;
    long long last_refresh_ms_ = 0;
    long long last_send_ms_ = 0;
    bool warned_ = false;
    uint8_t tab_id_ = 0x47;
};

}  // namespace imcp::proxy
