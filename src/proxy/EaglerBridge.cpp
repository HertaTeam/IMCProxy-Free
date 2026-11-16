#include "proxy/EaglerBridge.hpp"

#include <atomic>
#include <mutex>
#include <thread>

#include "core/Logger.hpp"
#include "core/Protocol.hpp"
#include "core/Util.hpp"
#include "proxy/McStream.hpp"
#include "proxy/Rewriter.hpp"


namespace imcp::proxy {

namespace {
core::Logger logger("EaglerClient");
}


namespace {
constexpr uint8_t kCsLogin = 0x01;
constexpr uint8_t kCsUsername = 0x04;
constexpr uint8_t kCsSkin = 0x07;
constexpr uint8_t kCsReady = 0x08;
constexpr uint8_t kScIdentify = 0x02;
constexpr uint8_t kScUuid = 0x05;
constexpr uint8_t kScReady = 0x09;
constexpr uint8_t kScDisconnect = 0xFF;

std::string make_login_packet(const UpstreamOptions& options) {
    core::Writer writer;
    writer.u8(kCsLogin);
    writer.u8(0x02);
    writer.u16(0x01);
    writer.u16(0x03);
    writer.u16(0x01);
    writer.u16(static_cast<uint16_t>(options.protocol));
    writer.string("EaglerReverseProxy");
    writer.string("1.0.0");
    writer.u8(0x00);
    writer.string(options.username);
    return writer.take();
}

std::string make_username_packet(const std::string& username) {
    core::Writer writer;
    writer.u8(kCsUsername);
    writer.string(username);
    writer.string("default");
    writer.u8(0x00);
    return writer.take();
}

std::string make_skin_packet(int skin_id) {
    static const unsigned char magic[] = {0x00, 0x05, 0x01, 0x00, 0x00, 0x00};
    core::Writer writer;
    writer.u8(kCsSkin);
    writer.string("skin_v1");
    writer.raw(std::string(reinterpret_cast<const char*>(magic), sizeof(magic)));
    writer.varint(skin_id);
    return writer.take();
}
}

bool eagler_connect(net::WsClient& ws, const UpstreamOptions& options, UpstreamResult& result) {
    if (!ws.connect(options.url, options.origin, options.user_agent, result.error)) return false;
    logger.info("WebSocket connected, starting Eaglercraft handshake...");

    std::string error;
    if (!ws.send_binary(make_login_packet(options), error)) {
        result.error = error;
        return false;
    }

    bool identified = false;
    bool ready = false;
    while (!ready) {
        std::string payload;
        net::WsClient::FrameType type = net::WsClient::FrameType::Binary;
        if (!ws.receive(payload, type, error)) {
            result.error = error;
            return false;
        }
        if (type != net::WsClient::FrameType::Binary || payload.empty()) {
            result.error = "received non-binary WebSocket frame during handshake";
            return false;
        }

        uint8_t id = static_cast<uint8_t>(payload[0]);
        if (id == kScDisconnect) {
            core::Reader reader(std::string_view(payload).substr(1));
            try {
                reader.u16();
                result.error = "server disconnected: " + reader.string();
            } catch (...) {
                result.error = "server disconnected during handshake";
            }
            return false;
        }

        if (id == kScIdentify && !identified) {
            core::Reader reader(std::string_view(payload).substr(1));
            try {
                reader.u16();
                reader.u16();
                result.brand = reader.string();
                result.version = reader.string();
            } catch (...) {
                result.error = "cannot parse identify packet";
                return false;
            }
            logger.info("Server: " + result.brand + " v" + result.version);

            if (!ws.send_binary(make_username_packet(options.username), error)) {
                result.error = error;
                return false;
            }
            identified = true;
        } else if (id == kScUuid && identified && result.uuid.empty()) {
            core::Reader reader(std::string_view(payload).substr(1));
            try {
                std::string assigned = reader.string();
                std::string raw_uuid = reader.bytes(16);
                result.uuid = core::uuid_from_bytes(raw_uuid);
                result.username = assigned;
                if (assigned != options.username) {
                    logger.warn("Server assigned ID \"" + assigned + "\", requested \"" + options.username + "\"");
                }
            } catch (...) {
                result.error = "cannot parse uuid packet";
                return false;
            }
            logger.info("UUID: " + result.uuid);

            if (!ws.send_binary(make_skin_packet(options.skin_id), error)) {
                result.error = error;
                return false;
            }
            core::Writer ready_writer;
            ready_writer.u8(kCsReady);
            if (!ws.send_binary(ready_writer.take(), error)) {
                result.error = error;
                return false;
            }
        } else if (id == kScReady) {
            ready = true;
        }
    }

    logger.info("Handshake complete");
    result.ok = true;
    return true;
}

void run_bridge(uintptr_t client_socket, net::WsClient& ws, const std::string& player_name, Rewriter& rewriter,
                std::shared_ptr<std::mutex> write_mutex) {
    std::atomic<bool> stop{false};

    std::thread to_upstream([&] {
        std::string payload;
        std::string error;
        while (!stop.load()) {
            if (!receive_packet(client_socket, payload, error)) {
                if (!stop.load()) logger.info("[" + player_name + "] client disconnected");
                break;
            }
            if (!ws.send_binary(payload, error)) {
                logger.warn("[" + player_name + "] upstream send failed: " + error);
                break;
            }
        }
        stop = true;
    });

    std::string payload;
    net::WsClient::FrameType type = net::WsClient::FrameType::Binary;
    std::string error;
    while (!stop.load()) {
        if (!ws.receive(payload, type, error)) {
            logger.info("[" + player_name + "] upstream closed: " + error);
            break;
        }
        if (type != net::WsClient::FrameType::Binary || payload.empty()) continue;
        if (static_cast<uint8_t>(payload[0]) == 0x46) continue;
        payload = rewriter.process(payload);
        if (payload.empty()) continue;
        std::lock_guard client_lock(*write_mutex);
        if (!send_all(client_socket, frame_packet(payload))) {
            logger.info("[" + player_name + "] client write failed");
            break;
        }
    }

    stop = true;
    if (to_upstream.joinable()) to_upstream.join();
}

}
