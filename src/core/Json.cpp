#include "core/Json.hpp"

#include <cctype>
#include <cmath>
#include <cstdio>
#include <sstream>

namespace imcp::core {

namespace {
struct Parser {
    std::string_view text;
    size_t pos = 0;

    void skip_ws() {
        while (pos < text.size() && (text[pos] == ' ' || text[pos] == '\t' || text[pos] == '\n' || text[pos] == '\r')) ++pos;
    }

    char peek() {
        skip_ws();
        if (pos >= text.size()) throw std::runtime_error("unexpected end of JSON");
        return text[pos];
    }

    bool consume(std::string_view literal) {
        skip_ws();
        if (text.substr(pos, literal.size()) == literal) {
            pos += literal.size();
            return true;
        }
        return false;
    }

    Json parse_value() {
        skip_ws();
        if (pos >= text.size()) throw std::runtime_error("unexpected end of JSON");
        char c = text[pos];
        if (c == '{') return parse_object();
        if (c == '[') return parse_array();
        if (c == '"') return Json(parse_string());
        if (c == 't') { if (!consume("true")) throw std::runtime_error("bad literal"); return Json(true); }
        if (c == 'f') { if (!consume("false")) throw std::runtime_error("bad literal"); return Json(false); }
        if (c == 'n') { if (!consume("null")) throw std::runtime_error("bad literal"); return Json(); }
        return Json(parse_number());
    }

    static void append_utf8(std::string& out, unsigned codepoint) {
        if (codepoint <= 0x7F) {
            out.push_back(static_cast<char>(codepoint));
        } else if (codepoint <= 0x7FF) {
            out.push_back(static_cast<char>(0xC0 | (codepoint >> 6)));
            out.push_back(static_cast<char>(0x80 | (codepoint & 0x3F)));
        } else if (codepoint <= 0xFFFF) {
            out.push_back(static_cast<char>(0xE0 | (codepoint >> 12)));
            out.push_back(static_cast<char>(0x80 | ((codepoint >> 6) & 0x3F)));
            out.push_back(static_cast<char>(0x80 | (codepoint & 0x3F)));
        } else {
            out.push_back(static_cast<char>(0xF0 | (codepoint >> 18)));
            out.push_back(static_cast<char>(0x80 | ((codepoint >> 12) & 0x3F)));
            out.push_back(static_cast<char>(0x80 | ((codepoint >> 6) & 0x3F)));
            out.push_back(static_cast<char>(0x80 | (codepoint & 0x3F)));
        }
    }

    std::string parse_string() {
        if (peek() != '"') throw std::runtime_error("expected string");
        ++pos;
        std::string out;
        while (pos < text.size()) {
            char c = text[pos++];
            if (c == '"') return out;
            if (c != '\\') {
                out.push_back(c);
                continue;
            }
            if (pos >= text.size()) throw std::runtime_error("bad escape");
            char escape = text[pos++];
            switch (escape) {
                case '"': out.push_back('"'); break;
                case '\\': out.push_back('\\'); break;
                case '/': out.push_back('/'); break;
                case 'b': out.push_back('\b'); break;
                case 'f': out.push_back('\f'); break;
                case 'n': out.push_back('\n'); break;
                case 'r': out.push_back('\r'); break;
                case 't': out.push_back('\t'); break;
                case 'u': {
                    if (pos + 4 > text.size()) throw std::runtime_error("bad unicode escape");
                    unsigned codepoint = 0;
                    for (int i = 0; i < 4; ++i) {
                        char digit = text[pos++];
                        codepoint <<= 4;
                        if (digit >= '0' && digit <= '9') codepoint |= static_cast<unsigned>(digit - '0');
                        else if (digit >= 'a' && digit <= 'f') codepoint |= static_cast<unsigned>(digit - 'a' + 10);
                        else if (digit >= 'A' && digit <= 'F') codepoint |= static_cast<unsigned>(digit - 'A' + 10);
                        else throw std::runtime_error("bad unicode escape");
                    }
                    append_utf8(out, codepoint);
                    break;
                }
                default: throw std::runtime_error("unsupported escape");
            }
        }
        throw std::runtime_error("unterminated string");
    }

    double parse_number() {
        size_t start = pos;
        if (pos < text.size() && text[pos] == '-') ++pos;
        while (pos < text.size() && (std::isdigit(static_cast<unsigned char>(text[pos])) || text[pos] == '.' ||
                                     text[pos] == 'e' || text[pos] == 'E' || text[pos] == '+' || text[pos] == '-')) {
            ++pos;
        }
        if (pos == start) throw std::runtime_error("bad number");
        return std::stod(std::string(text.substr(start, pos - start)));
    }

    Json parse_array() {
        Json result = Json::array();
        ++pos;
        skip_ws();
        if (pos < text.size() && text[pos] == ']') { ++pos; return result; }
        while (true) {
            result.push(parse_value());
            skip_ws();
            if (pos < text.size() && text[pos] == ',') { ++pos; continue; }
            if (pos < text.size() && text[pos] == ']') { ++pos; return result; }
            throw std::runtime_error("expected , or ] in array");
        }
    }

    Json parse_object() {
        Json result = Json::object();
        ++pos;
        skip_ws();
        if (pos < text.size() && text[pos] == '}') { ++pos; return result; }
        while (true) {
            std::string key = parse_string();
            skip_ws();
            if (pos >= text.size() || text[pos] != ':') throw std::runtime_error("expected : in object");
            ++pos;
            result[key] = parse_value();
            skip_ws();
            if (pos < text.size() && text[pos] == ',') { ++pos; continue; }
            if (pos < text.size() && text[pos] == '}') { ++pos; return result; }
            throw std::runtime_error("expected , or } in object");
        }
    }
};

std::string escape(std::string_view value) {
    std::string out;
    out.reserve(value.size() + 8);
    for (unsigned char c : value) {
        switch (c) {
            case '"': out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            case '\b': out += "\\b"; break;
            case '\f': out += "\\f"; break;
            default:
                if (c < 0x20) {
                    char buffer[8];
                    std::snprintf(buffer, sizeof(buffer), "\\u%04x", c);
                    out += buffer;
                } else {
                    out.push_back(static_cast<char>(c));
                }
        }
    }
    return out;
}
}

Json Json::array() {
    Json value;
    value.type_ = Type::Array;
    return value;
}

Json Json::object() {
    Json value;
    value.type_ = Type::Object;
    return value;
}

Json Json::parse(std::string_view text) {
    Parser parser{text};
    Json result = parser.parse_value();
    parser.skip_ws();
    return result;
}

bool Json::has(std::string_view key) const {
    for (const auto& [name, _] : object_) {
        if (name == key) return true;
    }
    return false;
}

const Json& Json::operator[](std::string_view key) const {
    for (const auto& [name, value] : object_) {
        if (name == key) return value;
    }
    static const Json null_value;
    return null_value;
}

Json& Json::operator[](std::string_view key) {
    for (auto& [name, value] : object_) {
        if (name == key) return value;
    }
    object_.emplace_back(std::string(key), Json());
    return object_.back().second;
}

Json& Json::push(Json value) {
    array_.push_back(std::move(value));
    return array_.back();
}

const Json& Json::path(std::string_view dotted) const {
    const Json* current = this;
    size_t start = 0;
    while (start <= dotted.size()) {
        size_t dot = dotted.find('.', start);
        std::string_view part = dotted.substr(start, dot == std::string_view::npos ? dotted.size() - start : dot - start);
        if (current->is_object() && current->has(part)) {
            current = &(*current)[part];
        } else {
            static const Json null_value;
            return null_value;
        }
        if (dot == std::string_view::npos) break;
        start = dot + 1;
    }
    return *current;
}

void Json::dump_to(std::string& out, int indent, int depth) const {
    auto newline = [&](int level) {
        if (indent <= 0) return;
        out.push_back('\n');
        out.append(static_cast<size_t>(indent * level), ' ');
    };
    switch (type_) {
        case Type::Null: out += "null"; break;
        case Type::Boolean: out += boolean_ ? "true" : "false"; break;
        case Type::Number: {
            if (std::floor(number_) == number_ && std::abs(number_) < 1e15) {
                out += std::to_string(static_cast<int64_t>(number_));
            } else {
                char buffer[64];
                std::snprintf(buffer, sizeof(buffer), "%.17g", number_);
                out += buffer;
            }
            break;
        }
        case Type::String: out += '"'; out += escape(string_); out += '"'; break;
        case Type::Array: {
            out.push_back('[');
            if (array_.empty()) { out.push_back(']'); break; }
            for (size_t i = 0; i < array_.size(); ++i) {
                if (i) out += ',';
                newline(depth + 1);
                array_[i].dump_to(out, indent, depth + 1);
            }
            newline(depth);
            out.push_back(']');
            break;
        }
        case Type::Object: {
            out.push_back('{');
            if (object_.empty()) { out.push_back('}'); break; }
            for (size_t i = 0; i < object_.size(); ++i) {
                if (i) out += ',';
                newline(depth + 1);
                out += '"';
                out += escape(object_[i].first);
                out += '"';
                out += indent > 0 ? ": " : ":";
                object_[i].second.dump_to(out, indent, depth + 1);
            }
            newline(depth);
            out.push_back('}');
            break;
        }
    }
}

std::string Json::dump(int indent) const {
    std::string out;
    dump_to(out, indent, 0);
    return out;
}

std::string Json::get_string(std::string_view key, std::string fallback) const {
    const Json& value = (*this)[key];
    return value.is_string() ? value.as_string() : fallback;
}

int64_t Json::get_int(std::string_view key, int64_t fallback) const {
    const Json& value = (*this)[key];
    return value.is_number() ? value.as_int() : fallback;
}

bool Json::get_bool(std::string_view key, bool fallback) const {
    const Json& value = (*this)[key];
    return value.is_boolean() ? value.as_bool() : fallback;
}

}
