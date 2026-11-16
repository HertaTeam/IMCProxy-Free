#include "net/WsClient.hpp"

#include <windows.h>
#include <winhttp.h>

#include <string>
#include <vector>

#include "core/Util.hpp"

#pragma comment(lib, "winhttp.lib")

namespace imcp::net {

namespace {
std::wstring widen(const std::string& text) {
    if (text.empty()) return L"";
    int size = MultiByteToWideChar(CP_UTF8, 0, text.c_str(), -1, nullptr, 0);
    std::wstring result(static_cast<size_t>(size > 0 ? size - 1 : 0), L'\0');
    if (size > 1) MultiByteToWideChar(CP_UTF8, 0, text.c_str(), -1, result.data(), size);
    return result;
}

struct ParsedUrl {
    bool secure = true;
    std::wstring host;
    std::wstring path;
    INTERNET_PORT port = 443;
};

bool parse_url(const std::string& url, ParsedUrl& out, std::string& error) {
    std::string rest;
    if (core::starts_with(url, "wss://")) {
        rest = url.substr(6);
        out.secure = true;
        out.port = 443;
    } else if (core::starts_with(url, "ws://")) {
        rest = url.substr(5);
        out.secure = false;
        out.port = 80;
    } else {
        error = "unsupported WebSocket URL scheme";
        return false;
    }

    size_t slash = rest.find('/');
    std::string host = slash == std::string::npos ? rest : rest.substr(0, slash);
    std::string path = slash == std::string::npos ? "/" : rest.substr(slash);

    size_t colon = host.rfind(':');
    if (colon != std::string::npos && host.find(']') == std::string::npos) {
        try {
            out.port = static_cast<INTERNET_PORT>(std::stoi(host.substr(colon + 1)));
        } catch (...) {
            error = "invalid port in WebSocket URL";
            return false;
        }
        host = host.substr(0, colon);
    }
    if (host.empty()) {
        error = "missing host";
        return false;
    }
    out.host = widen(host);
    out.path = widen(path);
    return true;
}
}

WsClient::~WsClient() { close(); }

void WsClient::close_handles() {
    if (websocket_) {
        WinHttpWebSocketClose(websocket_, WINHTTP_WEB_SOCKET_SUCCESS_CLOSE_STATUS, nullptr, 0);
        WinHttpCloseHandle(websocket_);
        websocket_ = nullptr;
    }
    if (request_) {
        WinHttpCloseHandle(request_);
        request_ = nullptr;
    }
    if (connection_) {
        WinHttpCloseHandle(connection_);
        connection_ = nullptr;
    }
    if (session_) {
        WinHttpCloseHandle(session_);
        session_ = nullptr;
    }
}

void WsClient::close() { close_handles(); }

bool WsClient::connect(const std::string& url, const std::string& origin, const std::string& user_agent,
                       std::string& error) {
    close_handles();

    ParsedUrl parsed;
    if (!parse_url(url, parsed, error)) return false;

    session_ = WinHttpOpen(L"IMCProxy/1.6 (C++)", WINHTTP_ACCESS_TYPE_DEFAULT_PROXY, WINHTTP_NO_PROXY_NAME,
                           WINHTTP_NO_PROXY_BYPASS, 0);
    if (!session_) {
        error = "WinHttpOpen failed: " + std::to_string(GetLastError());
        return false;
    }
    WinHttpSetTimeouts(session_, 15000, 15000, 15000, 60000);

    connection_ = WinHttpConnect(session_, parsed.host.c_str(), parsed.port, 0);
    if (!connection_) {
        error = "WinHttpConnect failed: " + std::to_string(GetLastError());
        close_handles();
        return false;
    }

    DWORD flags = parsed.secure ? WINHTTP_FLAG_SECURE : 0;
    request_ = WinHttpOpenRequest(connection_, L"GET", parsed.path.c_str(), nullptr, WINHTTP_NO_REFERER,
                                  WINHTTP_DEFAULT_ACCEPT_TYPES, flags);
    if (!request_) {
        error = "WinHttpOpenRequest failed: " + std::to_string(GetLastError());
        close_handles();
        return false;
    }

    std::wstring headers = L"User-Agent: " + widen(user_agent) + L"\r\n";
    if (!origin.empty()) headers += L"Origin: " + widen(origin) + L"\r\n";
    WinHttpAddRequestHeaders(request_, headers.c_str(), static_cast<DWORD>(headers.size()),
                             WINHTTP_ADDREQ_FLAG_ADD | WINHTTP_ADDREQ_FLAG_REPLACE);

    if (!WinHttpSetOption(request_, WINHTTP_OPTION_UPGRADE_TO_WEB_SOCKET, nullptr, 0)) {
        error = "cannot request WebSocket upgrade: " + std::to_string(GetLastError());
        close_handles();
        return false;
    }

    if (!WinHttpSendRequest(request_, WINHTTP_NO_ADDITIONAL_HEADERS, 0, nullptr, 0, 0, 0)) {
        error = "WinHttpSendRequest failed: " + std::to_string(GetLastError());
        close_handles();
        return false;
    }

    if (!WinHttpReceiveResponse(request_, nullptr)) {
        error = "WinHttpReceiveResponse failed: " + std::to_string(GetLastError());
        close_handles();
        return false;
    }

    DWORD status = 0;
    DWORD status_size = sizeof(status);
    WinHttpQueryHeaders(request_, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                        WINHTTP_HEADER_NAME_BY_INDEX, &status, &status_size, WINHTTP_NO_HEADER_INDEX);
    if (status != 101) {
        error = "upstream returned HTTP " + std::to_string(status);
        close_handles();
        return false;
    }

    websocket_ = WinHttpWebSocketCompleteUpgrade(request_, 0);
    if (!websocket_) {
        error = "WebSocket upgrade failed: " + std::to_string(GetLastError());
        close_handles();
        return false;
    }
    WinHttpCloseHandle(request_);
    request_ = nullptr;
    return true;
}

bool WsClient::send_binary(const std::string& payload, std::string& error) {
    if (!websocket_) {
        error = "WebSocket is not connected";
        return false;
    }
    DWORD result = WinHttpWebSocketSend(websocket_, WINHTTP_WEB_SOCKET_BINARY_MESSAGE_BUFFER_TYPE,
                                        const_cast<char*>(payload.data()), static_cast<DWORD>(payload.size()));
    if (result != ERROR_SUCCESS) {
        error = "WinHttpWebSocketSend failed: " + std::to_string(result);
        return false;
    }
    return true;
}

bool WsClient::send_text(const std::string& payload, std::string& error) {
    if (!websocket_) {
        error = "WebSocket is not connected";
        return false;
    }
    DWORD result = WinHttpWebSocketSend(websocket_, WINHTTP_WEB_SOCKET_UTF8_MESSAGE_BUFFER_TYPE,
                                        const_cast<char*>(payload.data()), static_cast<DWORD>(payload.size()));
    if (result != ERROR_SUCCESS) {
        error = "WinHttpWebSocketSend(text) failed: " + std::to_string(result);
        return false;
    }
    return true;
}

bool WsClient::receive(std::string& payload, FrameType& type, std::string& error) {
    payload.clear();
    while (true) {
        std::vector<char> buffer(65536);
        DWORD read = 0;
        WINHTTP_WEB_SOCKET_BUFFER_TYPE buffer_type = WINHTTP_WEB_SOCKET_BINARY_MESSAGE_BUFFER_TYPE;
        DWORD result = WinHttpWebSocketReceive(websocket_, buffer.data(), static_cast<DWORD>(buffer.size()), &read,
                                                &buffer_type);
        if (result != ERROR_SUCCESS) {
            error = "WinHttpWebSocketReceive failed: " + std::to_string(result);
            type = FrameType::Closed;
            return false;
        }
        if (read > 0) payload.append(buffer.data(), read);

        switch (buffer_type) {
            case WINHTTP_WEB_SOCKET_UTF8_MESSAGE_BUFFER_TYPE:
                type = FrameType::Text;
                return true;
            case WINHTTP_WEB_SOCKET_BINARY_MESSAGE_BUFFER_TYPE:
                type = FrameType::Binary;
                return true;
            case WINHTTP_WEB_SOCKET_UTF8_FRAGMENT_BUFFER_TYPE:
            case WINHTTP_WEB_SOCKET_BINARY_FRAGMENT_BUFFER_TYPE:
                continue;
            case WINHTTP_WEB_SOCKET_CLOSE_BUFFER_TYPE:
                type = FrameType::Closed;
                error = "WebSocket closed by peer";
                return false;
            default:
                type = FrameType::Binary;
                return true;
        }
    }
}

}
