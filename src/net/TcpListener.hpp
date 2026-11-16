#pragma once

#include <cstdint>
#include <functional>
#include <string>
#include <thread>

namespace imcp::net {

class TcpListener {
public:
    using ClientHandler = std::function<void(uintptr_t socket)>;

    TcpListener() = default;
    ~TcpListener();

    bool start(const std::string& host, uint16_t port, ClientHandler handler, std::string& error);
    void stop();
    bool running() const { return running_; }
    uint16_t port() const { return port_; }

private:
    void accept_loop();

    uintptr_t listen_socket_ = static_cast<uintptr_t>(~0ull);
    uint16_t port_ = 0;
    bool running_ = false;
    std::thread thread_;
    ClientHandler handler_;
};

}
