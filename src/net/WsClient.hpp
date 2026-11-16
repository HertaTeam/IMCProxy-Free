#pragma once

#include <cstdint>
#include <functional>
#include <string>

namespace imcp::net {

class WsClient {
public:
    enum class FrameType { Binary, Text, Closed };

    WsClient() = default;
    ~WsClient();

    WsClient(const WsClient&) = delete;
    WsClient& operator=(const WsClient&) = delete;

    bool connect(const std::string& url, const std::string& origin, const std::string& user_agent,
                 std::string& error);
    bool send_binary(const std::string& payload, std::string& error);
    bool send_text(const std::string& payload, std::string& error);
    bool receive(std::string& payload, FrameType& type, std::string& error);
    void close();

private:
    void close_handles();
    bool pump_receive(std::string& payload, FrameType& type, std::string& error, bool& would_block);

    void* session_ = nullptr;
    void* connection_ = nullptr;
    void* request_ = nullptr;
    void* websocket_ = nullptr;
    bool secure_ = true;
};

}
