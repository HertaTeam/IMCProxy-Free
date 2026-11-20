#include "net/HttpClient.hpp"

#include <cctype>

#include <windows.h>
#include <winhttp.h>

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
    std::string host;
    std::string path;
    INTERNET_PORT port = 443;
};

bool parse_url(const std::string& url, ParsedUrl& out, std::string& error) {
    std::string rest;
    if (core::starts_with(url, "https://")) {
        rest = url.substr(8);
        out.secure = true;
        out.port = 443;
    } else if (core::starts_with(url, "http://")) {
        rest = url.substr(7);
        out.secure = false;
        out.port = 80;
    } else {
        error = "unsupported URL scheme";
        return false;
    }
    const size_t slash = rest.find('/');
    std::string host = slash == std::string::npos ? rest : rest.substr(0, slash);
    out.path = slash == std::string::npos ? "/" : rest.substr(slash);
    const size_t colon = host.rfind(':');
    if (colon != std::string::npos) {
        try {
            out.port = static_cast<INTERNET_PORT>(std::stoi(host.substr(colon + 1)));
        } catch (...) {
        }
        host = host.substr(0, colon);
    }
    if (host.empty()) {
        error = "missing host";
        return false;
    }
    out.host = host;
    return true;
}
}  // namespace

HttpResponse http_request(const std::string& method, const std::string& url, const HeaderList& headers,
                          const std::string& body, int timeout_ms) {
    HttpResponse response;
    ParsedUrl parsed;
    if (!parse_url(url, parsed, response.error)) return response;

    HINTERNET session = WinHttpOpen(L"IMCProxy/1.6 (C++)", WINHTTP_ACCESS_TYPE_DEFAULT_PROXY, WINHTTP_NO_PROXY_NAME,
                                    WINHTTP_NO_PROXY_BYPASS, 0);
    if (!session) {
        response.error = "WinHttpOpen failed";
        return response;
    }
    WinHttpSetTimeouts(session, timeout_ms, timeout_ms, timeout_ms, timeout_ms);

    HINTERNET connection = WinHttpConnect(session, widen(parsed.host).c_str(), parsed.port, 0);
    if (!connection) {
        response.error = "WinHttpConnect failed";
        WinHttpCloseHandle(session);
        return response;
    }

    const std::wstring wide_method = widen(method);
    HINTERNET request = WinHttpOpenRequest(connection, wide_method.c_str(), widen(parsed.path).c_str(), nullptr,
                                           WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES,
                                           parsed.secure ? WINHTTP_FLAG_SECURE : 0);
    if (!request) {
        response.error = "WinHttpOpenRequest failed";
        WinHttpCloseHandle(connection);
        WinHttpCloseHandle(session);
        return response;
    }

    for (const auto& [name, value] : headers) {
        const std::wstring header = widen(name) + L": " + widen(value) + L"\r\n";
        WinHttpAddRequestHeaders(request, header.c_str(), static_cast<DWORD>(header.size()), WINHTTP_ADDREQ_FLAG_ADD);
    }

    const bool has_body = !body.empty();
    BOOL sent = WinHttpSendRequest(request, WINHTTP_NO_ADDITIONAL_HEADERS, 0,
                                   has_body ? const_cast<char*>(body.data()) : nullptr,
                                   static_cast<DWORD>(body.size()), static_cast<DWORD>(body.size()), 0);
    if (!sent || !WinHttpReceiveResponse(request, nullptr)) {
        response.error = "request failed: " + std::to_string(GetLastError());
        WinHttpCloseHandle(request);
        WinHttpCloseHandle(connection);
        WinHttpCloseHandle(session);
        return response;
    }

    DWORD status = 0;
    DWORD size = sizeof(status);
    WinHttpQueryHeaders(request, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER, WINHTTP_HEADER_NAME_BY_INDEX,
                        &status, &size, WINHTTP_NO_HEADER_INDEX);
    response.status = static_cast<int>(status);

    DWORD raw_size = 0;
    WinHttpQueryHeaders(request, WINHTTP_QUERY_RAW_HEADERS_CRLF, WINHTTP_HEADER_NAME_BY_INDEX, nullptr, &raw_size,
                        WINHTTP_NO_HEADER_INDEX);
    if (raw_size > sizeof(wchar_t)) {
        std::vector<wchar_t> raw(raw_size / sizeof(wchar_t) + 1, L'\0');
        if (WinHttpQueryHeaders(request, WINHTTP_QUERY_RAW_HEADERS_CRLF, WINHTTP_HEADER_NAME_BY_INDEX, raw.data(),
                                &raw_size, WINHTTP_NO_HEADER_INDEX)) {
            const int bytes = WideCharToMultiByte(CP_UTF8, 0, raw.data(), -1, nullptr, 0, nullptr, nullptr);
            if (bytes > 1) {
                std::string headers(static_cast<size_t>(bytes - 1), '\0');
                WideCharToMultiByte(CP_UTF8, 0, raw.data(), -1, headers.data(), bytes, nullptr, nullptr);
                size_t line_start = 0;
                while (line_start < headers.size()) {
                    const size_t line_end = headers.find("\r\n", line_start);
                    const std::string line = headers.substr(line_start, line_end == std::string::npos
                                                                              ? std::string::npos
                                                                              : line_end - line_start);
                    std::string lowered = line;
                    for (auto& ch : lowered) ch = static_cast<char>(std::tolower(static_cast<unsigned char>(ch)));
                    if (lowered.rfind("set-cookie:", 0) == 0) {
                        std::string cookie = line.substr(11);
                        while (!cookie.empty() && (cookie.front() == ' ' || cookie.front() == '\t')) cookie.erase(0, 1);
                        if (!cookie.empty()) response.set_cookies.push_back(cookie);
                    }
                    if (line_end == std::string::npos) break;
                    line_start = line_end + 2;
                }
            }
        }
    }
    if (!response.set_cookies.empty()) response.set_cookie = response.set_cookies.front();

    std::vector<char> buffer(16384);
    DWORD read = 0;
    while (WinHttpReadData(request, buffer.data(), static_cast<DWORD>(buffer.size()), &read) && read > 0) {
        response.body.append(buffer.data(), read);
        if (response.body.size() > 4 * 1024 * 1024) break;
    }

    WinHttpCloseHandle(request);
    WinHttpCloseHandle(connection);
    WinHttpCloseHandle(session);

    response.ok = response.status >= 200 && response.status < 300;
    return response;
}

HttpResponse http_get(const std::string& url, const std::string& user_agent, int timeout_ms) {
    HeaderList headers;
    headers.emplace_back("User-Agent", user_agent);
    headers.emplace_back("Accept", "application/json");
    return http_request("GET", url, headers, "", timeout_ms);
}

}  // namespace imcp::net
