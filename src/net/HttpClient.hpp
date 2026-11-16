#pragma once

#include <string>
#include <utility>
#include <vector>

namespace imcp::net {

struct HttpResponse {
    bool ok = false;
    int status = 0;
    std::string body;
    std::string set_cookie;
    std::string error;
};

using HeaderList = std::vector<std::pair<std::string, std::string>>;

HttpResponse http_request(const std::string& method, const std::string& url, const HeaderList& headers,
                          const std::string& body, int timeout_ms);

HttpResponse http_get(const std::string& url, const std::string& user_agent, int timeout_ms);

}  // namespace imcp::net
