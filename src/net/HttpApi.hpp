#pragma once

#include <functional>
#include <string>
#include <vector>

#include "core/Config.hpp"
#include "net/TcpListener.hpp"

namespace imcp::proxy {
class Server;
}

namespace imcp::net {

class HttpApi {
public:
    using CommandHandler = std::function<std::vector<std::string>(const std::string&)>;

    HttpApi(core::Config& config, proxy::Server* server, CommandHandler handler);
    ~HttpApi();

    bool start(std::string& error);
    void stop();
    bool running() const { return listener_.running(); }

private:
    void handle_client(uintptr_t socket_handle);
    std::string route(const std::string& method, const std::string& path, const std::string& body);

    core::Config& config_;
    proxy::Server* server_ = nullptr;
    CommandHandler handler_;
    TcpListener listener_;
};

}  // namespace imcp::net
