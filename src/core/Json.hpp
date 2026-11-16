#pragma once

#include <cstdint>
#include <map>
#include <memory>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace imcp::core {

class Json {
public:
    enum class Type { Null, Boolean, Number, String, Array, Object };

    Json() = default;
    Json(bool value) : type_(Type::Boolean), boolean_(value) {}
    Json(int value) : type_(Type::Number), number_(value) {}
    Json(int64_t value) : type_(Type::Number), number_(static_cast<double>(value)) {}
    Json(double value) : type_(Type::Number), number_(value) {}
    Json(const char* value) : type_(Type::String), string_(value) {}
    Json(std::string value) : type_(Type::String), string_(std::move(value)) {}

    static Json array();
    static Json object();
    static Json parse(std::string_view text);

    Type type() const { return type_; }
    bool is_null() const { return type_ == Type::Null; }
    bool is_boolean() const { return type_ == Type::Boolean; }
    bool is_number() const { return type_ == Type::Number; }
    bool is_string() const { return type_ == Type::String; }
    bool is_array() const { return type_ == Type::Array; }
    bool is_object() const { return type_ == Type::Object; }

    bool as_bool() const { return boolean_; }
    double as_number() const { return number_; }
    int64_t as_int() const { return static_cast<int64_t>(number_); }
    const std::string& as_string() const { return string_; }

    const std::vector<Json>& items() const { return array_; }
    std::vector<Json>& items() { return array_; }
    const std::vector<std::pair<std::string, Json>>& members() const { return object_; }

    bool has(std::string_view key) const;
    const Json& operator[](std::string_view key) const;
    Json& operator[](std::string_view key);
    Json& push(Json value);

    const Json& path(std::string_view dotted) const;
    std::string dump(int indent = 2) const;

    std::string get_string(std::string_view key, std::string fallback) const;
    int64_t get_int(std::string_view key, int64_t fallback) const;
    bool get_bool(std::string_view key, bool fallback) const;

private:
    Type type_ = Type::Null;
    bool boolean_ = false;
    double number_ = 0.0;
    std::string string_;
    std::vector<Json> array_;
    std::vector<std::pair<std::string, Json>> object_;

    void dump_to(std::string& out, int indent, int depth) const;
};

}
