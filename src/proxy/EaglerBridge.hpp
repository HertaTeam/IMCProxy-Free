#pragma once

#include <cstdint>
#include <string>

#include "net/WsClient.hpp"

#include <memory>
#include <mutex>

namespace imcp::proxy {

struct UpstreamResult {
    bool ok = false;
    std::string error;
    std::string uuid;
    std::string username;
    std::string brand;
    std::string version;
};

struct UpstreamOptions {
    std::string url;
    std::string origin;
    std::string user_agent;
    std::string username;
    int protocol = 47;
    int skin_id = 0;
};

bool eagler_connect(net::WsClient& ws, const UpstreamOptions& options, UpstreamResult& result);

class Rewriter;

void run_bridge(uintptr_t client_socket, net::WsClient& ws, const std::string& player_name,
                Rewriter& rewriter, std::shared_ptr<std::mutex> write_mutex);

}
