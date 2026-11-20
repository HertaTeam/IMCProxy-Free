#include <winsock2.h>

#include "proxy/Server.hpp"

#include <memory>
#include <set>

#include "core/Logger.hpp"
#include "core/Protocol.hpp"
#include "core/Util.hpp"
#include "features/Automation.hpp"
#include "features/GameAccounts.hpp"
#include "net/WsClient.hpp"
#include "proxy/EaglerBridge.hpp"
#include "proxy/McStream.hpp"
#include "proxy/Rewriter.hpp"
#include "proxy/Overlay.hpp"

namespace imcp::proxy {

namespace {
core::Logger logger("ReverseProxy");

constexpr uint8_t kLoginDisconnect = 0x00;
constexpr uint8_t kLoginSuccess = 0x02;

std::string escape_json(const std::string& text) {
    std::string out;
    for (char c : text) {
        if (c == '"' || c == '\\') {
            out.push_back('\\');
            out.push_back(c);
        } else if (static_cast<unsigned char>(c) < 0x20) {
            out.push_back(' ');
        } else {
            out.push_back(c);
        }
    }
    return out;
}

std::string disconnect_packet(const std::string& reason) {
    core::Writer writer;
    writer.u8(kLoginDisconnect);
    writer.string("{\"text\":\"" + escape_json(reason) + "\"}");
    return writer.take();
}
}  // namespace

Server::Server(core::Config& config) : config_(config) {}

std::string Server::random_mode() const { return config_.get_string("randomId.mode", "off"); }

std::string Server::upstream_name(const std::string& requested) {
    const std::string mode = random_mode();
    if (mode == "off") return requested;
    if (mode == "startup") {
        if (startup_id_.empty()) {
            const int length = static_cast<int>(config_.get_int("randomId.length", 8));
            startup_id_ = core::random_name(length < 3 ? 3 : length > 16 ? 16 : length);
        }
        return startup_id_;
    }
    const int length = static_cast<int>(config_.get_int("randomId.length", 8));
    return core::random_name(length < 3 ? 3 : length > 16 ? 16 : length);
}

bool Server::start(std::string& error) {
    const std::string host = config_.get_string("tcpHost", "0.0.0.0");
    const uint16_t port = static_cast<uint16_t>(config_.get_int("tcpPort", 25565));
    const bool enable_1122 = config_.get_bool("enable1122", true);
    const uint16_t port_1122 = static_cast<uint16_t>(config_.get_int("tcpPort1122", 25566));

    auto slot = std::make_unique<Slot>();
    slot->protocol = 47;
    slot->version = "1.8.9";
    const int protocol = slot->protocol;
    const std::string version = slot->version;
    auto handler = [this, protocol, version](uintptr_t socket_handle) {
        handle_client(socket_handle, protocol, version);
    };
    if (!slot->listener.start(host, port, handler, error)) return false;
    slots_.push_back(std::move(slot));

    if (enable_1122) {
        auto beta = std::make_unique<Slot>();
        beta->protocol = 340;
        beta->version = "1.12.2";
        const int beta_protocol = beta->protocol;
        const std::string beta_version = beta->version;
        auto beta_handler = [this, beta_protocol, beta_version](uintptr_t socket_handle) {
            handle_client(socket_handle, beta_protocol, beta_version);
        };
        std::string beta_error;
        if (beta->listener.start(host, port_1122, beta_handler, beta_error)) {
            slots_.push_back(std::move(beta));
        } else {
            logger.warn("Cannot listen on " + std::to_string(port_1122) + ": " + beta_error);
        }
    }

    running_ = true;
    return true;
}

void Server::stop() {
    for (auto& slot : slots_) slot->listener.stop();
    slots_.clear();
    running_ = false;
}

void Server::handle_client(uintptr_t socket_handle, int protocol, const std::string& version) {
    set_socket_timeout(socket_handle, 30);

    std::string payload;
    std::string error;
    if (!receive_packet(socket_handle, payload, error)) {
        logger.debug("client dropped before handshake: " + error);
        return;
    }

    core::Reader reader(payload);
    try {
        if (reader.varint() != 0x00) return;
    } catch (...) {
        return;
    }

    int32_t client_protocol = 0;
    std::string address;
    uint16_t port = 0;
    int32_t next_state = 0;
    try {
        client_protocol = reader.varint();
        address = reader.string();
        port = reader.u16();
        next_state = reader.varint();
    } catch (...) {
        return;
    }
    logger.debug("handshake [" + version + "]: protocol=" + std::to_string(client_protocol) + " host=" + address + ":" +
                 std::to_string(port) + " state=" + std::to_string(next_state));

    if (next_state == 1) {
        handle_status(socket_handle, protocol, version);
        return;
    }
    if (next_state != 2) return;

    if (!receive_packet(socket_handle, payload, error)) return;
    core::Reader login_reader(payload);
    std::string username;
    try {
        if (login_reader.varint() != 0x00) return;
        username = login_reader.string();
    } catch (...) {
        return;
    }

    handle_login(socket_handle, username, protocol);
}

void Server::handle_status(uintptr_t socket_handle, int protocol, const std::string& version) {
    std::string payload;
    std::string error;
    if (!receive_packet(socket_handle, payload, error)) return;
    if (payload.empty() || static_cast<uint8_t>(payload[0]) != 0x00) return;

    const std::string banner = version == "1.12.2" ? "IMCProxy Free (1.12.2 Beta)" : "IMCProxy Free";
    const int max_players = static_cast<int>(config_.get_int("maxPlayers", 1));
    const std::string json = "{\"version\":{\"name\":\"" + version + "\",\"protocol\":" + std::to_string(protocol) +
                             "},\"players\":{\"max\":" + std::to_string(max_players) + ",\"online\":" +
                             std::to_string(players_) + "},\"description\":{\"text\":\"" + escape_json(banner) + "\"}}";

    core::Writer response;
    response.varint(0x00);
    response.string(json);
    if (!send_packet(socket_handle, response.take(), error)) return;

    if (!receive_packet(socket_handle, payload, error)) return;
    if (payload.size() >= 9 && static_cast<uint8_t>(payload[0]) == 0x01) {
        core::Writer pong;
        pong.u8(0x01);
        pong.raw(std::string(payload.data() + 1, payload.size() - 1));
        send_packet(socket_handle, pong.take(), error);
    }
}

void Server::handle_login(uintptr_t socket_handle, const std::string& requested, int protocol) {
    std::string name;
    std::string account_password;

    const std::string mode = core::to_lower(random_mode());
    const bool prefer_accounts = config_.get_bool("randomId.preferAccounts", true);
    if (prefer_accounts && mode != "off") {
        features::GameAccounts accounts(config_.get_string("automation.gameAccountsFile", "game-accounts.txt"));
        const features::GameAccount* picked = nullptr;
        {
            std::lock_guard lock(pool_mutex_);
            for (const auto& entry : accounts.entries()) {
                if (active_ids_.count(core::to_lower(entry.account)) != 0) continue;
                if (entry.account.empty()) continue;
                picked = &entry;
                break;
            }
            if (picked != nullptr) active_ids_.insert(core::to_lower(picked->account));
        }
        if (picked != nullptr) {
            name = picked->account;
            account_password = picked->password;
            logger.info("Game account \"" + name + "\" selected from game-accounts.txt");
        } else {
            name = upstream_name(requested);
            logger.info("No free game account available; using generated ID \"" + name + "\"");
        }
    } else {
        name = (mode == "off" && !startup_id_.empty()) ? startup_id_ : upstream_name(requested);
    }

    if (account_password.empty()) {
        features::GameAccounts accounts(config_.get_string("automation.gameAccountsFile", "game-accounts.txt"));
        for (const auto& entry : accounts.entries()) {
            if (core::to_lower(entry.account) != core::to_lower(name)) continue;
            account_password = entry.password;
            break;
        }
    }
    logger.info("\xe2\x86\x92 Player connected: " + requested);

    net::WsClient ws;
    UpstreamOptions options;
    options.url = config_.get_string("eaglerServer", "");
    options.origin = config_.get_string("eaglerOrigin", "");
    options.user_agent = config_.get_string("eaglerUserAgent", "");
    options.username = name;
    options.protocol = protocol;
    options.skin_id = static_cast<int>(config_.get_int("defaultSkinId", 0));

    UpstreamResult result;
    if (!eagler_connect(ws, options, result)) {
        logger.error("[" + requested + "] upstream handshake failed: " + result.error);
        std::string error;
        send_packet(socket_handle, disconnect_packet("Upstream connection failed: " + result.error), error);
        shutdown(static_cast<SOCKET>(socket_handle), SD_SEND);
        {
            std::lock_guard lock(pool_mutex_);
            active_ids_.erase(core::to_lower(name));
        }
        Sleep(150);
        return;
    }

    core::Writer success;
    success.u8(kLoginSuccess);
    success.string(result.uuid);
    success.string(result.username.empty() ? name : result.username);
    std::string error;
    if (!send_packet(socket_handle, success.take(), error)) {
        ws.close();
        {
            std::lock_guard lock(pool_mutex_);
            active_ids_.erase(core::to_lower(name));
        }
        return;
    }

    set_socket_timeout(socket_handle, 0);
    players_ += 1;
    logger.info("  ID sent to the server: " + (result.username.empty() ? name : result.username) + ", UUID: " + result.uuid);
    if (!result.username.empty() && result.username != requested) {
        logger.info("  Upstream ID seen by the server (random ID mode): " + result.username);
    }

    auto write_mutex = std::make_shared<std::mutex>();
    Overlay overlay(config_, [socket_handle, write_mutex](const std::string& payload) {
        std::lock_guard lock(*write_mutex);
        return send_all(socket_handle, frame_packet(payload));
    });
    overlay.set_self(result.username.empty() ? name : result.username);
    overlay.set_tab_packet_id(protocol == 340 ? 0x4A : 0x47);
    overlay.start();

    features::Automation automation(config_);
    automation.set_game_credentials(name, account_password);
    automation.set_chat_packet_id(protocol == 340 ? 0x0F : 0x02);
    automation.set_sender([&ws](const std::string& message) {
        core::Writer writer;
        writer.u8(0x01);
        writer.string(message);
        std::string send_error;
        return ws.send_binary(writer.take(), send_error);
    });
    automation.set_client_sender([socket_handle, write_mutex](const std::string& payload) {
        std::lock_guard lock(*write_mutex);
        return send_all(socket_handle, frame_packet(payload));
    });

    Rewriter rewriter(config_);
    rewriter.set_identity(requested, result.username);
    rewriter.set_protocol(protocol);
    rewriter.set_map_archive(maps_);
    rewriter.set_overlay(&overlay);
    rewriter.set_automation(&automation);
    run_bridge(socket_handle, ws, requested, rewriter, write_mutex);
    overlay.stop();

    {
        std::lock_guard lock(pool_mutex_);
        active_ids_.erase(core::to_lower(result.username.empty() ? name : result.username));
    }
    players_ -= 1;
    ws.close();
    logger.info("\xe2\x86\x90 Player disconnected: " + requested);
}

}  // namespace imcp::proxy
