#pragma once

#include <string>
#include <utility>
#include <vector>

#include "core/Config.hpp"
#include "features/Automation.hpp"
#include "proxy/MapArchive.hpp"

namespace imcp::proxy {

class Overlay;

class Rewriter {
public:
    explicit Rewriter(core::Config& config);

    void set_identity(const std::string& requested, const std::string& upstream);
    void set_protocol(int protocol);
    void set_overlay(Overlay* overlay) { overlay_ = overlay; }
    void set_automation(features::Automation* automation) { automation_ = automation; }
    void set_map_archive(MapArchive& archive);

    std::string process(const std::string& payload);

private:
    std::string rewrite_chat(const std::string& payload);
    std::string rewrite_brand(const std::string& payload);
    std::string rewrite_tab(const std::string& payload);
    std::string rewrite_title(const std::string& payload);
    std::string rewrite_player_info(const std::string& payload);
    std::string rewrite_objective(const std::string& payload);
    std::string rewrite_score(const std::string& payload);
    std::string rewrite_team(const std::string& payload);
    bool spoof_component(std::string& json_text) const;
    std::string spoof_plain(const std::string& text) const;
    std::string apply_component(const std::string& json_text, int max_chars, bool allow_spoof = true) const;
    std::string apply_plain(const std::string& text, int max_chars) const;
    std::string apply_field(const std::string& text, int max_chars, bool allow_spoof = true) const;

    core::Config& config_;
    std::vector<std::string> names_;
    std::vector<std::pair<std::string, std::string>> mappings_;
    std::string display_;
    bool name_protect_ = false;
    bool spoof_enabled_ = false;
    bool spoof_case_insensitive_ = true;
    bool spoof_chat_ = false;
    bool spoof_tab_ = false;
    bool spoof_title_ = false;
    bool spoof_brand_ = false;
    bool spoof_scoreboard_ = false;
    struct PacketIds {
        uint8_t chat = 0x02;
        uint8_t kick = 0x40;
        uint8_t brand = 0x3F;
        uint8_t title = 0x45;
        uint8_t tab = 0x47;
        uint8_t player_info = 0x38;
        uint8_t objective = 0x3B;
        uint8_t score = 0x3C;
        uint8_t team = 0x3E;
        uint8_t join_game = 0x01;
    };

    int protocol_ = 47;
    PacketIds ids_;
    Overlay* overlay_ = nullptr;
    MapArchive* map_archive_ = nullptr;
    MapArchive::Session map_session_ = 0;
    features::Automation* automation_ = nullptr;
};

}  // namespace imcp::proxy
