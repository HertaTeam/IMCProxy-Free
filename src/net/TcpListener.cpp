#include "net/TcpListener.hpp"

#include <winsock2.h>
#include <ws2tcpip.h>

#include <atomic>
#include <thread>

#pragma comment(lib, "ws2_32.lib")

namespace imcp::net {

namespace {
std::atomic<int> g_wsa_refs{0};

bool ensure_wsa(std::string& error) {
    if (g_wsa_refs.fetch_add(1) == 0) {
        WSADATA data{};
        if (WSAStartup(MAKEWORD(2, 2), &data) != 0) {
            error = "WSAStartup failed";
            return false;
        }
    }
    return true;
}
}

TcpListener::~TcpListener() { stop(); }

bool TcpListener::start(const std::string& host, uint16_t port, ClientHandler handler, std::string& error) {
    if (!ensure_wsa(error)) return false;

    SOCKET socket_handle = ::socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (socket_handle == INVALID_SOCKET) {
        error = "socket() failed: " + std::to_string(WSAGetLastError());
        return false;
    }

    BOOL reuse = TRUE;
    setsockopt(socket_handle, SOL_SOCKET, SO_REUSEADDR, reinterpret_cast<const char*>(&reuse), sizeof(reuse));

    sockaddr_in address{};
    address.sin_family = AF_INET;
    address.sin_port = htons(port);
    if (host.empty() || host == "0.0.0.0") {
        address.sin_addr.s_addr = INADDR_ANY;
    } else {
        inet_pton(AF_INET, host.c_str(), &address.sin_addr);
    }

    if (bind(socket_handle, reinterpret_cast<sockaddr*>(&address), sizeof(address)) == SOCKET_ERROR) {
        error = "bind() failed: " + std::to_string(WSAGetLastError());
        closesocket(socket_handle);
        return false;
    }
    if (listen(socket_handle, SOMAXCONN) == SOCKET_ERROR) {
        error = "listen() failed: " + std::to_string(WSAGetLastError());
        closesocket(socket_handle);
        return false;
    }

    listen_socket_ = static_cast<uintptr_t>(socket_handle);
    port_ = port;
    handler_ = std::move(handler);
    running_ = true;
    thread_ = std::thread([this] { accept_loop(); });
    return true;
}

void TcpListener::accept_loop() {
    while (running_) {
        SOCKET client = accept(static_cast<SOCKET>(listen_socket_), nullptr, nullptr);
        if (client == INVALID_SOCKET) {
            if (!running_) break;
            continue;
        }
        if (handler_) {
            std::thread([handler = handler_, client] {
                handler(static_cast<uintptr_t>(client));
                closesocket(client);
            }).detach();
        } else {
            closesocket(client);
        }
    }
}

void TcpListener::stop() {
    if (!running_) return;
    running_ = false;
    if (listen_socket_ != static_cast<uintptr_t>(~0ull)) {
        closesocket(static_cast<SOCKET>(listen_socket_));
        listen_socket_ = static_cast<uintptr_t>(~0ull);
    }
    if (thread_.joinable()) thread_.join();
}

}
