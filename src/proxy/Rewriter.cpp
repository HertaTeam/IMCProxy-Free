#include "proxy/Rewriter.hpp"

#include <algorithm>
#include <vector>

#include "core/Logger.hpp"
#include "core/Protocol.hpp"
#include "core/Util.hpp"
#include "proxy/ChatText.hpp"
#include "proxy/Overlay.hpp"

namespace imcp::proxy {

namespace {
core::Logger logger("ReverseProxy");

std::string clamp(std::string text, int max_chars) { return core::clamp_utf16(text, max_chars); }

bool replace_ci(const std::string& from, const std::string& to, bool case_insensitive, const std::string& input,
                std::string& output) {
    if (from.empty()) return false;
    std::string result;
    result.reserve(input.size());
    bool changed = false;
    size_t position = 0;
    while (position < input.size()) {
        bool hit = false;
        size_t offset = 0;
        if (input.size() - position >= from.size()) {
            if (!case_insensitive) {
                hit = input.compare(position, from.size(), from) == 0;
            } else {
                hit = true;
                for (size_t i = 0; i < from.size(); ++i) {
                    const unsigned char left = static_cast<unsigned char>(input[position + i]);
                    const unsigned char right = static_cast<unsigned char>(from[i]);
                    if (std::tolower(left) != std::tolower(right)) {
                        hit = false;
                        break;
                    }
                }
            }
        }
        if (hit) {
            result += to;
            position += from.size();
            changed = true;
            continue;
        }
        result.push_back(input[position]);
        ++position;
        (void)offset;
    }
    if (changed) output = std::move(result);
    return changed;
}
}

Rewriter::Rewriter(core::Config& config) : config_(config) {
    name_protect_ = config_.get_bool("nameProtect.enabled", false);
    display_ = config_.get_string("nameProtect.name", "");

    spoof_enabled_ = config_.get_bool("serverNameSpoof.enabled", false);
    spoof_case_insensitive_ = config_.get_bool("serverNameSpoof.caseInsensitive", true);
    spoof_chat_ = config_.get_bool("serverNameSpoof.targets.chat", true);
    spoof_tab_ = config_.get_bool("serverNameSpoof.targets.tab", true);
    spoof_title_ = config_.get_bool("serverNameSpoof.targets.title", true);
    spoof_brand_ = config_.get_bool("serverNameSpoof.targets.brand", true);
    spoof_scoreboard_ = config_.get_bool("serverNameSpoof.targets.scoreboard", true);

    const core::Json& mappings = config_.root().path("serverNameSpoof.mappings");
    if (mappings.is_array()) {
        for (const auto& item : mappings.items()) {
            if (!item.is_object()) continue;
            const core::Json& from = item["from"];
            const core::Json& to = item["to"];
            if (from.is_string() && to.is_string() && !from.as_string().empty()) {
                mappings_.emplace_back(from.as_string(), to.as_string());
            }
        }
    }
}

void Rewriter::set_protocol(int protocol) {
    protocol_ = protocol;
    if (protocol == 340) {
        ids_ = PacketIds{0x0F, 0x1A, 0x18, 0x48, 0x4A, 0x2E, 0x42, 0x45, 0x44, 0x23};
    } else {
        ids_ = PacketIds{};
    }
}

void Rewriter::set_map_archive(MapArchive& archive) {
    map_archive_ = &archive;
    map_session_ = archive.new_session();
}

void Rewriter::set_identity(const std::string& requested, const std::string& upstream) {
    names_.clear();
    if (!requested.empty()) names_.push_back(requested);
    if (!upstream.empty() && upstream != requested) names_.push_back(upstream);
}

std::string Rewriter::spoof_plain(const std::string& text) const {
    if (!spoof_enabled_) return text;
    std::string result = text;
    for (const auto& [from, to] : mappings_) {
        std::string replaced;
        if (replace_ci(from, to, spoof_case_insensitive_, result, replaced)) result = replaced;
    }
    return result;
}

bool Rewriter::spoof_component(std::string& json_text) const {
    if (!spoof_enabled_ || mappings_.empty()) return false;
    core::Json parsed;
    try {
        parsed = core::Json::parse(json_text);
    } catch (...) {
        return false;
    }
    const bool changed = map_component_text(parsed, [this](const std::string& text) { return spoof_plain(text); });
    if (!changed) return false;
    json_text = parsed.dump(0);
    return true;
}

std::string Rewriter::apply_plain(const std::string& text, int max_chars) const {
    std::string result = text;
    if (name_protect_ && !display_.empty() && !names_.empty()) {
        result = replace_plain_text(result, names_, display_);
    }
    result = spoof_plain(result);
    return clamp(result, max_chars);
}

std::string Rewriter::apply_component(const std::string& json_text, int max_chars, bool allow_spoof) const {
    std::string result = json_text;
    bool changed = false;
    if (name_protect_ && !display_.empty() && !names_.empty()) {
        std::string rewritten;
        if (rewrite_component_text(result, names_, display_, max_chars, rewritten)) {
            result = rewritten;
            changed = true;
        }
    }
    if (allow_spoof) {
        std::string spoofed = result;
        if (spoof_component(spoofed) && (max_chars <= 0 || static_cast<int>(spoofed.size()) <= max_chars)) {
            result = spoofed;
            changed = true;
        }
    }
    return changed ? result : json_text;
}

std::string Rewriter::apply_field(const std::string& text, int max_chars, bool allow_spoof) const {
    if (!text.empty() && (text.front() == '{' || text.front() == '[')) {
        return apply_component(text, max_chars, allow_spoof);
    }
    return apply_plain(text, max_chars);
}

std::string Rewriter::rewrite_chat(const std::string& payload) {
    if (!name_protect_ && !(spoof_enabled_ && spoof_chat_)) return payload;
    core::Reader reader(payload);
    reader.varint();
    std::string json = reader.string();
    std::string tail = std::string(reader.rest());

    std::string plain;
    try {
        plain = component_plain(json);
    } catch (...) {
        plain = json;
    }
    if (!plain.empty()) {
        logger.info("Server chat: " + plain);
        if (overlay_) overlay_->note_chat(plain);
        if (automation_) automation_->note_chat(plain);
    }

    std::string rewritten = apply_component(json, 32767, spoof_chat_);
    if (rewritten == json) return payload;

    core::Writer writer;
    writer.u8(static_cast<uint8_t>(payload[0]));
    writer.string(rewritten);
    writer.raw(tail);
    return writer.take();
}

std::string Rewriter::rewrite_brand(const std::string& payload) {
    if (!spoof_enabled_ || !spoof_brand_ || mappings_.empty()) return payload;
    core::Reader reader(payload);
    reader.varint();
    std::string channel;
    std::string brand;
    try {
        channel = reader.string();
        brand = reader.string();
    } catch (...) {
        return payload;
    }
    if (channel != "MC|Brand") return payload;

    const std::string spoofed = spoof_plain(brand);
    if (spoofed == brand || spoofed.empty()) return payload;

    core::Writer writer;
    writer.u8(static_cast<uint8_t>(payload[0]));
    writer.string(channel);
    writer.string(spoofed);
    return writer.take();
}

std::string Rewriter::rewrite_tab(const std::string& payload) {
    if (!name_protect_ && !(spoof_enabled_ && spoof_tab_)) return payload;
    core::Reader reader(payload);
    reader.varint();
    std::string header;
    std::string footer;
    try {
        header = reader.string();
        footer = reader.string();
    } catch (...) {
        return payload;
    }
    const std::string new_header = apply_component(header, 32767, spoof_tab_);
    const std::string new_footer = apply_component(footer, 32767, spoof_tab_);
    if (new_header == header && new_footer == footer) return payload;

    core::Writer writer;
    writer.u8(static_cast<uint8_t>(payload[0]));
    writer.string(new_header);
    writer.string(new_footer);
    return writer.take();
}

std::string Rewriter::rewrite_title(const std::string& payload) {
    if (!name_protect_ && !(spoof_enabled_ && spoof_title_)) return payload;
    core::Reader reader(payload);
    reader.varint();
    int32_t action = 0;
    try {
        action = reader.varint();
    } catch (...) {
        return payload;
    }
    if (action != 0 && action != 1) return payload;
    std::string json;
    try {
        json = reader.string();
    } catch (...) {
        return payload;
    }
    const std::string rewritten = apply_component(json, 32767, spoof_title_);
    if (rewritten == json) return payload;

    core::Writer writer;
    writer.u8(static_cast<uint8_t>(payload[0]));
    writer.varint(action);
    writer.string(rewritten);
    return writer.take();
}

std::string Rewriter::rewrite_player_info(const std::string& payload) {
    if (!name_protect_) {
        try {
            core::Reader reader(payload);
            reader.varint();
            const int32_t action = reader.varint();
            const int32_t count = reader.varint();
            if (action != 0 || count < 0 || count > 1024) return payload;
            std::vector<std::pair<std::string, int>> entries;
            for (int32_t i = 0; i < count; ++i) {
                reader.bytes(16);
                const std::string name = reader.string();
                const int32_t properties = reader.varint();
                for (int32_t p = 0; p < properties; ++p) {
                    reader.string();
                    reader.string();
                    if (reader.boolean()) reader.string();
                }
                reader.varint();
                const int32_t ping = reader.varint();
                entries.emplace_back(name, ping);
                if (reader.boolean()) reader.string();
            }
            if (overlay_ && !entries.empty()) overlay_->note_player_info(entries);
        } catch (...) {
        }
        return payload;
    }
    try {
        core::Reader reader(payload);
        reader.varint();
        const int32_t action = reader.varint();
        const int32_t count = reader.varint();
        if (count < 0 || count > 1024) return payload;

        std::vector<std::pair<std::string, int>> entries;
        core::Writer writer;
        writer.u8(static_cast<uint8_t>(payload[0]));
        writer.varint(action);
        writer.varint(count);

        for (int32_t i = 0; i < count; ++i) {
            const std::string uuid = reader.bytes(16);
            writer.raw(uuid);

            if (action == 0) {
                const std::string raw_name = reader.string();
                writer.string(apply_plain(raw_name, 16));
                const int32_t properties = reader.varint();
                writer.varint(properties);
                for (int32_t p = 0; p < properties; ++p) {
                    writer.string(reader.string());
                    writer.string(reader.string());
                    const bool signed_value = reader.boolean();
                    writer.boolean(signed_value);
                    if (signed_value) writer.string(reader.string());
                }
                writer.varint(reader.varint());
                const int32_t ping = reader.varint();
                writer.varint(ping);
                entries.emplace_back(raw_name, ping);
                const bool has_display = reader.boolean();
                writer.boolean(has_display);
                if (has_display) writer.string(apply_component(reader.string(), 32767));
            } else if (action == 1) {
                writer.varint(reader.varint());
            } else if (action == 2) {
                writer.varint(reader.varint());
            } else if (action == 3) {
                const bool has_display = reader.boolean();
                writer.boolean(has_display);
                if (has_display) writer.string(apply_component(reader.string(), 32767));
            }
        }
        if (overlay_ && !entries.empty()) overlay_->note_player_info(entries);
        return writer.take();
    } catch (...) {
        return payload;
    }
}

std::string Rewriter::rewrite_objective(const std::string& payload) {
    try {
        core::Reader reader(payload);
        reader.varint();
        const std::string name = reader.string();
        const uint8_t action = reader.u8();

        core::Writer writer;
        writer.u8(static_cast<uint8_t>(payload[0]));
        writer.string(name);
        writer.u8(action);
        if (action == 0 || action == 2) {
            writer.string(apply_field(reader.string(), 32, spoof_scoreboard_));
            writer.string(reader.string());
        }
        return writer.take();
    } catch (...) {
        return payload;
    }
}

std::string Rewriter::rewrite_score(const std::string& payload) {
    try {
        core::Reader reader(payload);
        reader.varint();
        std::string score_name;
        std::string objective;
        uint8_t action = 0;
        if (protocol_ == 340) {
            action = static_cast<uint8_t>(reader.varint());
            score_name = reader.string();
            objective = reader.string();
        } else {
            score_name = reader.string();
            action = reader.u8();
            objective = reader.string();
        }
        const bool has_value = action != 1;
        int32_t value = 0;
        if (has_value) value = reader.varint();

        const std::string new_name = apply_plain(score_name, 40);
        const std::string new_objective = apply_plain(objective, 40);
        if (new_name == score_name && new_objective == objective) return payload;

        core::Writer writer;
        writer.u8(static_cast<uint8_t>(payload[0]));
        if (protocol_ == 340) {
            writer.varint(action);
            writer.string(new_name);
            writer.string(new_objective);
        } else {
            writer.string(new_name);
            writer.u8(action);
            writer.string(new_objective);
        }
        if (has_value) writer.varint(value);
        return writer.take();
    } catch (...) {
        return payload;
    }
}

std::string Rewriter::rewrite_team(const std::string& payload) {
    try {
        core::Reader reader(payload);
        reader.varint();
        const std::string team = reader.string();
        const uint8_t mode = reader.u8();

        core::Writer writer;
        writer.u8(static_cast<uint8_t>(payload[0]));
        writer.string(team);
        writer.u8(mode);

        if (mode == 0 || mode == 2) {
            writer.string(apply_field(reader.string(), 32, spoof_scoreboard_));
            writer.string(apply_field(reader.string(), 16, spoof_scoreboard_));
            writer.string(apply_field(reader.string(), 16, spoof_scoreboard_));
            writer.u8(reader.u8());
            writer.string(reader.string());
            if (protocol_ == 340) {
                writer.string(reader.string());
            }
            writer.u8(reader.u8());
        }
        if (mode == 0 || mode == 3 || mode == 4) {
            const int32_t players = reader.varint();
            writer.varint(players);
            for (int32_t i = 0; i < players; ++i) writer.string(apply_plain(reader.string(), 40));
        }
        return writer.take();
    } catch (...) {
        return payload;
    }
}

std::string Rewriter::process(const std::string& payload) {
    if (payload.empty()) return payload;
    if (map_archive_ && static_cast<uint8_t>(payload[0]) == (protocol_ == 340 ? 0x24 : 0x34)) {
        map_archive_->note(map_session_, protocol_, payload);
        return payload;
    }
    if (payload[0] == static_cast<char>(ids_.join_game)) {
        if (map_archive_) map_session_ = map_archive_->new_session();
        if (overlay_) overlay_->note_world_change();
        return payload;
    }
    if (payload[0] == static_cast<char>(ids_.chat)) return rewrite_chat(payload);
    if (payload[0] == static_cast<char>(ids_.player_info)) return rewrite_player_info(payload);
    if (payload[0] == static_cast<char>(ids_.objective)) {
        return (name_protect_ || spoof_scoreboard_) ? rewrite_objective(payload) : payload;
    }
    if (payload[0] == static_cast<char>(ids_.score)) {
        return (name_protect_ || spoof_scoreboard_) ? rewrite_score(payload) : payload;
    }
    if (payload[0] == static_cast<char>(ids_.team)) {
        return (name_protect_ || spoof_scoreboard_) ? rewrite_team(payload) : payload;
    }
    if (payload[0] == static_cast<char>(ids_.brand)) return rewrite_brand(payload);
    if (payload[0] == static_cast<char>(ids_.title)) return rewrite_title(payload);
    if (payload[0] == static_cast<char>(ids_.tab)) return rewrite_tab(payload);
    if (payload[0] == static_cast<char>(ids_.kick)) {
        try {
            core::Reader reader(payload);
            reader.varint();
            logger.warn("Server kicked: " + component_plain(reader.string()));
        } catch (...) {
        }
        return payload;
    }
    return payload;
}

}
