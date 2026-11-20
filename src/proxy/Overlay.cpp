#include "proxy/Overlay.hpp"

#include <windows.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <regex>

#include "core/Json.hpp"
#include "core/Logger.hpp"
#include "core/Protocol.hpp"
#include "core/Util.hpp"
#include "net/HttpClient.hpp"

#include <fstream>

namespace imcp::proxy {

namespace {
core::Logger logger("Overlay");
}


namespace {
long long now_ms() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
               std::chrono::steady_clock::now().time_since_epoch())
        .count();
}

std::string pad_cell(const std::string& text, size_t width) {
    if (text.size() >= width) return text.substr(0, width);
    return text + std::string(width - text.size(), ' ');
}

std::string fixed2(double value) {
    char buffer[32];
    std::snprintf(buffer, sizeof(buffer), "%.2f", value);
    return buffer;
}

bool looks_anomalous(int matches, int wins, double fkdr, double kd) {
    if (matches < 0 || wins < 0) return true;
    if (wins > matches) return true;
    if (matches < 15 && (fkdr >= 10.0 || kd >= 10.0)) return true;
    if (fkdr > 50.0 || kd > 20.0) return true;
    return false;
}

double compute_rating(int matches, int wins, double avg_beds, double fkdr, double kd) {
    if (matches <= 0) return 0.0;
    const double losses = std::max(1, matches - wins);
    const double wlr = wins / losses;
    auto clamp = [](double value, double low, double high) { return std::min(std::max(value, low), high); };
    const double f = clamp(std::log2((std::max(0.0, fkdr) + 1) / 2), -1, 3);
    const double b = clamp(std::log2(std::max(0.0, avg_beds) + 0.5), -1, 2);
    const double w = clamp(std::log2((wlr + 1) / 2), -1, 2);
    const double k = clamp(std::log2((std::max(0.0, kd) + 1) / 2), -1, 2);
    const double p = 0.45 * f + 0.4 * b + 0.1 * w + 0.05 * k;
    const double c = matches / (matches + 20.0);
    return clamp(1 + 1.25 * c * p, 0.1, 3);
}

const char* kPatterns[] = {"队的床", "床将在", "破坏自己队伍的床", "起床",
                           "床战",   "bedwars", "bed wars", "梦幻经验起床", "正在连接"};

std::string json_text(const std::string& text) {
    std::string out;
    for (char c : text) {
        if (c == '"' || c == '\\') {
            out.push_back('\\');
            out.push_back(c);
        } else if (c == '\n') {
            out += "\\n";
        } else if (static_cast<unsigned char>(c) >= 0x20) {
            out.push_back(c);
        }
    }
    return "{\"text\":\"" + out + "\"}";
}
}  // namespace

Overlay::Overlay(core::Config& config, Sender sender) : config_(config), sender_(std::move(sender)) {}

Overlay::~Overlay() { stop(); }

bool Overlay::enabled() const { return config_.get_bool("overlay.enabled", true); }
std::string Overlay::mode() const { return core::to_lower(config_.get_string("overlay.mode", "auto")); }

bool Overlay::is_active() const {
    if (!enabled() || mode() == "off") return false;
    if (mode() == "bedwars") return true;
    return detected_;
}

std::string Overlay::cache_path() const {
    return config_.get_string("overlay.cacheFile", ".overlay-cache.json");
}

void Overlay::load_cache() {
    std::ifstream stream(cache_path());
    if (!stream) return;
    std::string text((std::istreambuf_iterator<char>(stream)), std::istreambuf_iterator<char>());
    try {
        const core::Json parsed = core::Json::parse(text);
        const core::Json& rows = parsed["rows"];
        for (const auto& [name, node] : rows.members()) {
            OverlayRow row;
            row.name = name;
            row.matches = static_cast<int>(node.get_int("matches", 0));
            row.wins = static_cast<int>(node.get_int("wins", 0));
            row.losses = std::max(0, row.matches - row.wins);
            row.fkdr = node.path("fkdr").is_number() ? node.path("fkdr").as_number() : 0;
            row.kd = node.path("kd").is_number() ? node.path("kd").as_number() : 0;
            row.avg_beds = node.path("avgBeds").is_number() ? node.path("avgBeds").as_number() : 0;
            row.final_kills = static_cast<int>(node.get_int("finalKills", 0));
            row.beds_broken = static_cast<int>(node.get_int("bedsBroken", 0));
            row.kills = static_cast<int>(node.get_int("kills", 0));
            row.rating = node.path("rating").is_number() ? node.path("rating").as_number() : 0;
            row.anomaly = node.get_bool("anomaly", false);
            stats_[name] = row;
        }
        logger.info("Overlay cache loaded: " + std::to_string(stats_.size()) + " player(s)");
    } catch (...) {
        logger.warn("Overlay cache is unreadable, ignoring");
    }
}

void Overlay::save_cache() const {
    core::Json rows = core::Json::object();
    for (const auto& [name, row] : stats_) {
        if (row.failed) continue;
        core::Json item = core::Json::object();
        item["matches"] = row.matches;
        item["wins"] = row.wins;
        item["fkdr"] = row.fkdr;
        item["kd"] = row.kd;
        item["avgBeds"] = row.avg_beds;
        item["finalKills"] = row.final_kills;
        item["bedsBroken"] = row.beds_broken;
        item["kills"] = row.kills;
        item["rating"] = row.rating;
        item["anomaly"] = row.anomaly;
        rows[name] = item;
    }
    if (rows.members().empty()) return;
    core::Json root = core::Json::object();
    root["rows"] = rows;
    std::ofstream stream(cache_path(), std::ios::binary | std::ios::trunc);
    if (stream) stream << root.dump(2) << "\n";
}

void Overlay::start() {
    if (running_) return;
    {
        std::lock_guard lock(mutex_);
        load_cache();
    }
    running_ = true;
    worker_ = std::thread([this] { worker(); });
}

void Overlay::stop() {
    running_ = false;
    if (worker_.joinable()) worker_.join();
    std::lock_guard lock(mutex_);
    save_cache();
}

void Overlay::set_self(const std::string& name) {
    if (name.empty()) return;
    std::lock_guard lock(mutex_);
    if (self_name_ == name) return;
    self_name_ = name;
    roster_.push_back(name);
    last_refresh_ms_ = 0;
}

void Overlay::note_chat(const std::string& plain) {
    if (!enabled() || mode() == "off") return;
    {
        std::lock_guard lock(mutex_);
        std::smatch match;
        static const std::regex room_pattern(
            "(?:正在连接|连接|进入)\\s*([a-z]{2,4}\\s*#?\\s*\\d+)|(bw\\s*#?\\s*\\d+)",
            std::regex::icase);
        if (std::regex_search(plain, match, room_pattern)) {
            std::string room = match[1].matched ? match[1].str() : match[2].str();
            room.erase(std::remove_if(room.begin(), room.end(),
                                      [](unsigned char c) { return std::isspace(c) != 0; }),
                       room.end());
            const bool is_new = room != room_;
            room_ = room;
            detected_ = true;
            if (is_new) {
                stats_.clear();
                pings_.clear();
                last_refresh_ms_ = 0;
                logger.info("BedWars room detected: " + room + " - querying stats");
            }
            return;
        }
        if (detected_) return;

        const std::string flat = core::to_lower(plain);
        for (const char* pattern : kPatterns) {
            if (flat.find(core::to_lower(pattern)) != std::string::npos) {
                detected_ = true;
                last_refresh_ms_ = 0;
                logger.info("BedWars detected from server chat - Tab overlay enabled");
                return;
            }
        }
    }
}

void Overlay::note_player_info(const std::vector<std::pair<std::string, int>>& entries) {
    if (entries.empty()) return;
    std::lock_guard lock(mutex_);
    for (const auto& [name, ping] : entries) {
        if (name.empty() || name.size() > 16) continue;
        if (ping > 0) pings_[name] = ping;
        if (std::find(roster_.begin(), roster_.end(), name) == roster_.end()) roster_.push_back(name);
    }
}

void Overlay::note_world_change() {
    bool was_showing = false;
    {
        std::lock_guard lock(mutex_);
        was_showing = detected_ || !stats_.empty();
        detected_ = false;
        room_.clear();
        stats_.clear();
        pings_.clear();
        fetched_ms_.clear();
        roster_.clear();
        last_refresh_ms_ = 0;
    }
    if (!was_showing) return;
    {
        std::lock_guard lock(mutex_);
        pending_clear_ = config_.get_bool("overlay.decorateTab", true);
    }
    logger.info("World changed - Tab overlay closed");
}

void Overlay::refresh(bool force) {
    if (!is_active() || !enabled()) return;
    const long long now = now_ms();
    const long long lifetime = static_cast<long long>(config_.get_int("overlay.refreshSeconds", 300)) * 1000LL;
    std::vector<std::string> names;
    {
        std::lock_guard lock(mutex_);
        for (const auto& name : roster_) {
            const auto cached = fetched_ms_.find(name);
            if (!force && cached != fetched_ms_.end() && now - cached->second < lifetime) continue;
            names.push_back(name);
            if (names.size() >= 40) break;
        }
    }
    if (names.empty()) return;
    for (const auto& name : names) fetch_one(name);
    {
        std::lock_guard lock(mutex_);
        for (const auto& name : names) fetched_ms_[name] = now;
        last_refresh_ms_ = now;
        save_cache();
    }
}

void Overlay::fetch_one(const std::string& name) {
    std::string base = config_.get_string("overlay.apiBase", "https://api.imc.re");
    while (!base.empty() && base.back() == '/') base.pop_back();
    const int timeout = static_cast<int>(config_.get_int("overlay.timeoutMs", 6000));
    const std::string url = base + "/stats/bedwars/players/" + name;

    net::HttpResponse response = net::http_get(url, "IMCProxy-Overlay", timeout);
    OverlayRow row;
    row.name = name;

    if (response.ok) {
        try {
            core::Json json = core::Json::parse(response.body);
            const core::Json& root = json;
            const core::Json& summary = root.has("summary") ? root["summary"] : root;
            core::Json metrics = summary.has("metrics") ? summary["metrics"] : core::Json::object();

            row.matches = static_cast<int>(summary.get_int("matches", 0));
            row.wins = static_cast<int>(summary.get_int("wins", 0));
            row.losses = std::max(0, row.matches - row.wins);
            row.fkdr = metrics.path("fkdr").is_number() ? metrics.path("fkdr").as_number() : 0;
            row.kd = metrics.path("kd").is_number() ? metrics.path("kd").as_number() : 0;
            row.avg_beds = metrics.path("avgBeds").is_number() ? metrics.path("avgBeds").as_number() : 0;
            row.final_kills = static_cast<int>(metrics.get_int("finalKills", 0));
            row.beds_broken = static_cast<int>(metrics.get_int("bedsBroken", 0));
            row.kills = static_cast<int>(metrics.get_int("kills", 0));
            row.ping = 0;
            row.rating = metrics.path("rating").is_number() ? metrics.path("rating").as_number() : 0;
            if (row.rating <= 0) row.rating = compute_rating(row.matches, row.wins, row.avg_beds, row.fkdr, row.kd);
            row.anomaly = looks_anomalous(row.matches, row.wins, row.fkdr, row.kd);
        } catch (...) {
            row.failed = true;
        }
    } else {
        row.failed = true;
        if (!warned_) {
            warned_ = true;
            logger.warn("Stats API unavailable: " + (response.error.empty() ? "HTTP " + std::to_string(response.status) : response.error));
        }
    }

    std::lock_guard lock(mutex_);
    if (row.failed) return;
    row.ping = pings_.count(name) ? pings_[name] : 0;
    stats_[name] = row;
    save_cache();
}

std::vector<OverlayRow> Overlay::ranked() const {
    std::vector<OverlayRow> rows;
    for (const auto& [name, row] : stats_) {
        if (row.failed || row.matches <= 0) continue;
        if (!roster_.empty()) {
            const bool in_room = std::any_of(roster_.begin(), roster_.end(), [&](const std::string& member) {
                return core::to_lower(member) == core::to_lower(name);
            });
            if (!in_room) continue;
        }
        rows.push_back(row);
    }
    std::sort(rows.begin(), rows.end(), [](const OverlayRow& a, const OverlayRow& b) { return a.fkdr > b.fkdr; });
    return rows;
}

std::string Overlay::build_header() const {
    const std::string s = "\xc2\xa7";
    const std::vector<OverlayRow> rows = ranked();
    const size_t top = static_cast<size_t>(std::max<int64_t>(1, config_.get_int("overlay.topRows", 10)));
    std::string header = s + "8" + s + "lIMC Overlay " + s + "7\xc2\xb7 " + s + "fBedWars";
    if (!room_.empty()) header += " " + s + "8" + room_;
    header += "\n" + s + "7" + pad_cell("Name", 15) + " " + pad_cell("Final", 5) + " " + pad_cell("F/D", 5) + " " +
              pad_cell("Wins", 4) + " " + pad_cell("W/L", 5) + " " + pad_cell("Beds", 4) + " " + pad_cell("BB/L", 5) +
              " " + pad_cell("Ping", 4) + " " + pad_cell("K/D", 5);

    for (size_t i = 0; i < rows.size() && i < top; ++i) {
        const OverlayRow& row = rows[i];
        const std::string paint = row.anomaly ? s + "c" : s + "f";
        const std::string wl = fixed2(static_cast<double>(row.wins) / std::max(1, row.losses));
        const std::string bbl = fixed2(static_cast<double>(row.beds_broken) / std::max(1, row.losses));
        const std::string ping = row.ping > 0 ? std::to_string(row.ping) : "-";
        header += "\n" + paint + pad_cell(row.anomaly ? row.name + "!" : row.name, 15) + " " + s + "b" +
                  pad_cell(std::to_string(row.final_kills), 5) + " " + pad_cell(fixed2(row.fkdr), 5) + " " + s + "a" +
                  pad_cell(std::to_string(row.wins), 4) + " " + pad_cell(wl, 5) + " " + s + "e" +
                  pad_cell(std::to_string(row.beds_broken), 4) + " " + pad_cell(bbl, 5) + " " + s + "7" +
                  pad_cell(ping, 4) + " " + s + "c" + pad_cell(fixed2(row.kd), 5);
    }
    return header;
}

std::string Overlay::build_footer() const {
    const std::string s = "\xc2\xa7";
    const std::vector<OverlayRow> rows = ranked();
    int suspect = 0;
    for (const auto& row : rows) suspect += row.anomaly ? 1 : 0;
    const std::string suffix = suspect > 0 ? " " + s + "c| " + std::to_string(suspect) + " suspicious" : "";

    if (self_name_.empty()) return s + "8no player linked";
    for (const auto& row : rows) {
        if (core::to_lower(row.name) != core::to_lower(self_name_)) continue;
        return s + "eYou " + s + "f" + row.name + " " + s + "7| " + s + "a" + std::to_string(row.wins) + "W" + s +
               "7/" + s + "f" + std::to_string(row.matches) + "M " + s + "eF/D " + s + "f" + fixed2(row.fkdr) + " " +
               s + "eK/D " + s + "f" + fixed2(row.kd) + " " + s + "eBeds " + s + "f" +
               std::to_string(row.beds_broken) + suffix;
    }
    return s + "eYou " + s + "f" + self_name_ + " " + s + "7| " + s + "8no stats yet" + suffix;
}

void Overlay::send_tab() {
    std::string header;
    std::string footer;
    {
        std::lock_guard lock(mutex_);
        header = build_header();
        footer = build_footer();
    }
    core::Writer writer;
    writer.u8(tab_id_);
    writer.string(json_text(header));
    writer.string(json_text(footer));
    if (sender_) sender_(writer.take());
    last_send_ms_ = now_ms();
}

void Overlay::worker() {
    while (running_) {
        std::this_thread::sleep_for(std::chrono::milliseconds(500));
        if (!running_) break;
        bool clear_now = false;
        {
            std::lock_guard lock(mutex_);
            clear_now = pending_clear_;
            pending_clear_ = false;
        }
        if (clear_now && sender_) {
            core::Writer writer;
            writer.u8(tab_id_);
            writer.string("{\"text\":\"\"}");
            writer.string("{\"text\":\"\"}");
            sender_(writer.take());
            last_send_ms_ = now_ms();
        }
        if (!is_active()) continue;
        if (!config_.get_bool("overlay.decorateTab", true)) continue;
        if (now_ms() - last_send_ms_ < 2000) continue;
        refresh(false);
        send_tab();
    }
}

std::string Overlay::describe() const {
    std::lock_guard lock(mutex_);
    return "overlay: enabled=" + std::string(enabled() ? "true" : "false") + " mode=" + mode() +
           " detected=" + std::string(detected_ ? "true" : "false") + " room=" + (room_.empty() ? "-" : room_) +
           " roster=" + std::to_string(roster_.size()) + " stats=" + std::to_string(ranked().size());
}


}  // namespace imcp::proxy
