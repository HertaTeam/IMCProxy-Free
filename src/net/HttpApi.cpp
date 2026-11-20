#include "net/HttpApi.hpp"

#include <winsock2.h>

#include <map>
#include <sstream>

#include "core/Json.hpp"
#include "core/Logger.hpp"
#include "core/Util.hpp"
#include "features/Backup.hpp"
#include "features/SettingsCommands.hpp"
#include "features/Changelog.hpp"
#include "proxy/McStream.hpp"
#include "proxy/Server.hpp"

namespace imcp::net {

namespace {
core::Logger logger("Api");
}


namespace {
std::string status_text(int code) {
    switch (code) {
        case 200: return "OK";
        case 400: return "Bad Request";
        case 404: return "Not Found";
        case 405: return "Method Not Allowed";
        default: return "Internal Server Error";
    }
}

std::string http_response(int code, const std::string& body) {
    std::ostringstream stream;
    stream << "HTTP/1.1 " << code << " " << status_text(code) << "\r\n";
    stream << "Content-Type: application/json; charset=utf-8\r\n";
    stream << "Content-Length: " << body.size() << "\r\n";
    stream << "Connection: close\r\n\r\n";
    stream << body;
    return stream.str();
}

std::string ok_json(const core::Json& payload) { return payload.dump(2); }

core::Json error_json(const std::string& message) {
    core::Json root = core::Json::object();
    root["ok"] = false;
    root["error"] = message;
    return root;
}

void flatten(const core::Json& node, const std::string& prefix, std::vector<std::pair<std::string, core::Json>>& out) {
    if (!node.is_object()) return;
    for (const auto& [key, value] : node.members()) {
        std::string path = prefix.empty() ? key : prefix + "." + key;
        if (value.is_object()) {
            out.emplace_back(path, value);
            flatten(value, path, out);
        } else {
            out.emplace_back(path, value);
        }
    }
}

bool is_secret_key(const std::string& key) {
    return key == "api.token" || key == "imc.apiToken" || key == "automation.defaultGamePassword";
}

core::Json masked_value(const std::string& key, const core::Json& value) {
    if (!is_secret_key(key)) return value;
    if (value.is_string() && value.as_string().empty()) return value;
    return core::Json("***");
}

std::string query_param(const std::string& query, const std::string& name) {
    size_t start = 0;
    while (start <= query.size()) {
        const size_t amp = query.find('&', start);
        const std::string pair = query.substr(start, amp == std::string::npos ? std::string::npos : amp - start);
        const size_t equals = pair.find('=');
        const std::string key = equals == std::string::npos ? pair : pair.substr(0, equals);
        if (key == name) return equals == std::string::npos ? "" : pair.substr(equals + 1);
        if (amp == std::string::npos) break;
        start = amp + 1;
    }
    return "";
}

bool as_number(const std::string& text, double& out) {
    try {
        size_t used = 0;
        out = std::stod(text, &used);
        return used == text.size();
    } catch (...) {
        return false;
    }
}
}  // namespace

HttpApi::HttpApi(core::Config& config, proxy::Server* server, CommandHandler handler)
    : config_(config), server_(server), handler_(std::move(handler)) {}

HttpApi::~HttpApi() { stop(); }

bool HttpApi::start(std::string& error) {
    if (!config_.get_bool("api.enabled", true)) {
        logger.info("HTTP API disabled (config.json -> api.enabled = false).");
        error = "disabled";
        return false;
    }
    const std::string host = config_.get_string("api.host", "127.0.0.1");
    const uint16_t port = static_cast<uint16_t>(config_.get_int("api.port", 8790));
    auto callback = [this](uintptr_t socket_handle) { handle_client(socket_handle); };
    std::string listen_error;
    if (!listener_.start(host, port, callback, listen_error)) {
        logger.error("HTTP API failed to listen on " + host + ":" + std::to_string(port) + ": " + listen_error);
        error = listen_error;
        return false;
    }
    logger.info("HTTP API: http://" + host + ":" + std::to_string(port) + "/api");
    if (!config_.get_string("api.token", "").empty()) {
        logger.info("HTTP API token required (?token=... or X-Api-Token)");
    }
    return true;
}

void HttpApi::stop() { listener_.stop(); }

void HttpApi::handle_client(uintptr_t socket_handle) {
    try {
    proxy::set_socket_timeout(socket_handle, 10);
    std::string request;
    char buffer[4096];
    while (request.find("\r\n\r\n") == std::string::npos) {
        int read = recv(static_cast<SOCKET>(socket_handle), buffer, sizeof(buffer), 0);
        if (read <= 0) return;
        request.append(buffer, static_cast<size_t>(read));
        if (request.size() > 65536) return;
    }

    size_t header_end = request.find("\r\n\r\n");
    std::string headers = request.substr(0, header_end);
    std::string body = request.substr(header_end + 4);

    std::istringstream lines(headers);
    std::string request_line;
    std::getline(lines, request_line);
    std::istringstream first(request_line);
    std::string method;
    std::string path;
    std::string version;
    first >> method >> path >> version;
    std::string query;
    const size_t question = path.find('?');
    if (question != std::string::npos) {
        query = path.substr(question + 1);
        path = path.substr(0, question);
    }

    size_t content_length = 0;
    std::string token;
    std::string line;
    while (std::getline(lines, line)) {
        if (!line.empty() && line.back() == '\r') line.pop_back();
        std::string lowered = line;
        for (auto& c : lowered) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
        if (lowered.rfind("x-api-token:", 0) == 0) {
            token = core::trim(line.substr(12));
        } else if (lowered.rfind("authorization:", 0) == 0) {
            std::string bearer = core::trim(line.substr(14));
            if (bearer.size() > 7 && core::to_lower(bearer.substr(0, 7)) == "bearer ") bearer = core::trim(bearer.substr(7));
            token = bearer;
        } else if (lowered.rfind("content-length:", 0) == 0) {
            try {
                content_length = static_cast<size_t>(std::stoul(line.substr(15)));
            } catch (...) {
            }
        }
    }
    while (body.size() < content_length) {
        int read = recv(static_cast<SOCKET>(socket_handle), buffer, sizeof(buffer), 0);
        if (read <= 0) break;
        body.append(buffer, static_cast<size_t>(read));
    }
    if (body.size() > content_length) body.resize(content_length);

    if (token.empty()) token = query_param(query, "token");
    std::string response = route(method, path, body, query, token);
    proxy::send_all(socket_handle, response);
    shutdown(static_cast<SOCKET>(socket_handle), SD_SEND);
    } catch (const std::exception& error) {
        logger.error(std::string("http handler failed: ") + error.what());
    } catch (...) {
        logger.error("http handler failed: unknown error");
    }
}

std::string HttpApi::route(const std::string& method, const std::string& path, const std::string& body,
                           const std::string& query, const std::string& token) {
    (void)query;
    const std::string prefix = "/api";
    if (path.rfind(prefix, 0) != 0) return http_response(404, ok_json(error_json("not found")));

    std::string route_path = path.substr(prefix.size());
    if (route_path.empty()) route_path = "/";

    const std::string expected_token = config_.get_string("api.token", "");
    if (!expected_token.empty() && token != expected_token) {
        return http_response(401, ok_json(error_json("unauthorized: send X-Api-Token, Authorization: Bearer, or ?token=")));
    }

    if (route_path == "/" && method == "GET") {
        core::Json root = core::Json::object();
        root["ok"] = true;
        root["name"] = "IMCProxy";
        root["version"] = features::app_version();
        core::Json endpoints = core::Json::array();
        for (const char* item : {"GET /api/status", "GET /api/config", "GET /api/config/<key>",
                                 "POST /api/config/<key>", "POST /api/start", "POST /api/stop",
                                 "POST /api/command", "GET /api/changelog", "GET /api/version"}) {
            endpoints.push(core::Json(item));
        }
        root["endpoints"] = endpoints;
        return http_response(200, ok_json(root));
    }

    if (route_path == "/version" && method == "GET") {
        core::Json root = core::Json::object();
        root["ok"] = true;
        root["version"] = features::app_version();
        core::Json entries = core::Json::array();
        for (const auto& entry : features::changelog()) {
            core::Json item = core::Json::object();
            item["version"] = entry.version;
            item["date"] = entry.date;
            entries.push(item);
        }
        root["changelog"] = entries;
        return http_response(200, ok_json(root));
    }

    if (route_path == "/changelog" && method == "GET") {
        core::Json root = core::Json::object();
        root["ok"] = true;
        core::Json entries = core::Json::array();
        for (const auto& entry : features::changelog()) {
            core::Json item = core::Json::object();
            item["version"] = entry.version;
            item["date"] = entry.date;
            core::Json changes = core::Json::array();
            for (const auto& change : entry.changes) changes.push(core::Json(change));
            item["changes"] = changes;
            entries.push(item);
        }
        root["entries"] = entries;
        return http_response(200, ok_json(root));
    }

    if (route_path == "/status" && method == "GET") {
        core::Json root = core::Json::object();
        root["ok"] = true;
        root["running"] = server_ ? server_->running() : false;
        core::Json listen = core::Json::object();
        listen["v189"] = config_.get_string("tcpHost", "0.0.0.0") + ":" + std::to_string(config_.get_int("tcpPort", 25565));
        listen["v1122"] = config_.get_bool("enable1122", true)
                              ? config_.get_string("tcpHost", "0.0.0.0") + ":" +
                                    std::to_string(config_.get_int("tcpPort1122", 25566))
                              : "disabled";
        root["listen"] = listen;
        root["upstream"] = config_.get_string("eaglerServer", "");
        root["playerCount"] = server_ ? server_->player_count() : 0;
        return http_response(200, ok_json(root));
    }

    if (route_path == "/config" && method == "GET") {
        core::Json root = core::Json::object();
        root["ok"] = true;
        core::Json settings = core::Json::array();
        std::vector<std::pair<std::string, core::Json>> flat;
        flatten(config_.root(), "", flat);
        for (const auto& [key, value] : flat) {
            if (value.is_object()) continue;
            core::Json item = core::Json::object();
            item["key"] = key;
            item["value"] = masked_value(key, value);
            settings.push(item);
        }
        root["settings"] = settings;
        return http_response(200, ok_json(root));
    }

    if (route_path.rfind("/config/", 0) == 0) {
        const std::string key = route_path.substr(8);
        const core::Json& current = config_.root().path(key);
        if (current.is_null()) return http_response(404, ok_json(error_json("unknown setting \"" + key + "\"")));

        if (method == "GET") {
            core::Json root = core::Json::object();
            root["ok"] = true;
            root["key"] = key;
            root["value"] = masked_value(key, current);
            return http_response(200, ok_json(root));
        }

        if (method == "POST") {
            std::string value_text;
            bool has_value = false;
            try {
                core::Json parsed = core::Json::parse(body);
                if (parsed.is_object() && parsed.has("value")) {
                    value_text = parsed["value"].is_string() ? parsed["value"].as_string() : parsed["value"].dump(0);
                    has_value = true;
                } else {
                    value_text = body;
                    has_value = true;
                }
            } catch (...) {
                value_text = body;
                has_value = true;
            }
            if (!has_value) return http_response(400, ok_json(error_json("missing value")));

            std::string error;
            std::string note;
            if (!features::apply_setting(config_, key, value_text, error, note)) {
                return http_response(400, ok_json(error_json(error)));
            }
            features::backup_file("config.json");
            config_.save();

            core::Json root = core::Json::object();
            root["ok"] = true;
            root["key"] = key;
            root["value"] = config_.root().path(key);
            return http_response(200, ok_json(root));
        }
        return http_response(405, ok_json(error_json("method not allowed")));
    }

    if (route_path == "/start" && method == "POST") {
        std::string error;
        bool started = server_ && server_->running();
        if (!started && server_) started = server_->start(error);
        core::Json root = core::Json::object();
        root["ok"] = started;
        root["running"] = server_ ? server_->running() : false;
        if (!started) root["error"] = error;
        return http_response(started ? 200 : 500, ok_json(root));
    }

    if (route_path == "/stop" && method == "POST") {
        if (server_) server_->stop();
        core::Json root = core::Json::object();
        root["ok"] = true;
        root["running"] = false;
        return http_response(200, ok_json(root));
    }

    if (route_path == "/command" && method == "POST") {
        std::string line;
        try {
            core::Json parsed = core::Json::parse(body);
            if (parsed.is_object() && parsed.has("line")) line = parsed["line"].as_string();
            else line = body;
        } catch (...) {
            line = body;
        }
        if (line.empty()) return http_response(400, ok_json(error_json("missing line")));

        std::vector<std::string> output;
        if (handler_) output = handler_(line);
        core::Json root = core::Json::object();
        root["ok"] = true;
        root["line"] = line;
        core::Json lines = core::Json::array();
        for (const auto& item : output) lines.push(core::Json(item));
        root["output"] = lines;
        return http_response(200, ok_json(root));
    }

    return http_response(404, ok_json(error_json("not found")));
}

}  // namespace imcp::net
