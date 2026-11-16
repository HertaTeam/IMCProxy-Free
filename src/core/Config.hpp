#pragma once

#include <string>
#include <string_view>

#include "core/Json.hpp"

namespace imcp::core {

class Config {
public:
    static Json defaults();

    bool load(const std::string& path);
    bool save() const;
    bool save_as(const std::string& path) const;

    Json& root() { return root_; }
    const Json& root() const { return root_; }
    const std::string& path() const { return path_; }

    std::string get_string(std::string_view dotted, std::string fallback) const;
    int64_t get_int(std::string_view dotted, int64_t fallback) const;
    bool get_bool(std::string_view dotted, bool fallback) const;

    bool set_string(std::string_view dotted, std::string value);
    bool set_int(std::string_view dotted, int64_t value);
    bool set_bool(std::string_view dotted, bool value);

    static void merge_missing(Json& target, const Json& fallback);

private:
    Json root_ = Json::object();
    std::string path_ = "config.json";
};

}
