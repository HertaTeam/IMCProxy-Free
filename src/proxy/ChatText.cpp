#include "proxy/ChatText.hpp"

#include <algorithm>

namespace imcp::proxy {

namespace {
void collect_plain(const core::Json& node, std::string& out) {
    if (node.is_string()) {
        out += node.as_string();
        return;
    }
    if (node.is_array()) {
        for (const auto& item : node.items()) collect_plain(item, out);
        return;
    }
    if (!node.is_object()) return;

    if (node.has("text")) collect_plain(node["text"], out);
    if (out.empty() && node.has("translate")) collect_plain(node["translate"], out);
    if (node.has("with")) collect_plain(node["with"], out);
    if (node.has("extra")) collect_plain(node["extra"], out);
}

bool map_text_node(core::Json& node, const std::function<std::string(const std::string&)>& transform) {
    bool changed = false;
    if (node.is_string()) {
        const std::string text = node.as_string();
        const std::string result = transform(text);
        if (result != text) {
            node = core::Json(result);
            return true;
        }
        return false;
    }
    if (node.is_array()) {
        for (auto& item : node.items()) changed = map_text_node(item, transform) || changed;
        return changed;
    }
    if (!node.is_object()) return false;

    for (const char* key : {"text", "displayName", "prefix", "suffix"}) {
        if (!node.has(key)) continue;
        core::Json& value = node[key];
        if (!value.is_string()) continue;
        const std::string text = value.as_string();
        const std::string result = transform(text);
        if (result != text) {
            value = core::Json(result);
            changed = true;
        }
    }
    for (const char* key : {"extra", "with"}) {
        if (node.has(key)) changed = map_text_node(node[key], transform) || changed;
    }
    return changed;
}

bool replace_text_node(core::Json& node, const std::vector<std::string>& names, const std::string& display) {
    bool changed = false;
    if (node.is_string()) {
        std::string text = node.as_string();
        std::string result = text;
        for (const auto& name : names) {
            if (name.empty()) continue;
            std::string replaced;
            replaced.reserve(result.size());
            size_t position = 0;
            while (position < result.size()) {
                size_t hit = result.find(name, position);
                if (hit == std::string::npos) {
                    replaced.append(result, position, std::string::npos);
                    break;
                }
                replaced.append(result, position, hit - position);
                replaced += display;
                position = hit + name.size();
            }
            result = replaced;
        }
        if (result != text) {
            node = core::Json(result);
            changed = true;
        }
        return changed;
    }
    if (node.is_array()) {
        for (auto& item : node.items()) changed = replace_text_node(item, names, display) || changed;
        return changed;
    }
    if (!node.is_object()) return false;

    for (const char* key : {"text", "displayName", "prefix", "suffix"}) {
        if (node.has(key)) {
            core::Json& value = node[key];
            if (value.is_string()) {
                std::string text = value.as_string();
                std::string result = text;
                for (const auto& name : names) {
                    if (name.empty()) continue;
                    std::string replaced;
                    size_t position = 0;
                    while (position < result.size()) {
                        size_t hit = result.find(name, position);
                        if (hit == std::string::npos) {
                            replaced.append(result, position, std::string::npos);
                            break;
                        }
                        replaced.append(result, position, hit - position);
                        replaced += display;
                        position = hit + name.size();
                    }
                    result = replaced;
                }
                if (result != text) {
                    value = core::Json(result);
                    changed = true;
                }
            }
        }
    }
    for (const char* key : {"extra", "with"}) {
        if (node.has(key)) changed = replace_text_node(node[key], names, display) || changed;
    }
    return changed;
}
}  // namespace

std::string component_plain(const std::string& json_text) {
    core::Json parsed = core::Json::parse(json_text);
    std::string out;
    collect_plain(parsed, out);
    out.erase(std::remove(out.begin(), out.end(), '\r'), out.end());
    return out;
}

bool replace_in_component(core::Json& node, const std::vector<std::string>& names, const std::string& display) {
    return replace_text_node(node, names, display);
}

bool rewrite_component_text(const std::string& json_text, const std::vector<std::string>& names,
                            const std::string& display, int max_chars, std::string& out) {
    if (json_text.empty() || display.empty()) return false;
    core::Json parsed;
    try {
        parsed = core::Json::parse(json_text);
    } catch (...) {
        return false;
    }
    if (!replace_in_component(parsed, names, display)) return false;
    std::string dumped = parsed.dump(0);
    if (max_chars > 0 && static_cast<int>(dumped.size()) > max_chars) return false;
    out = dumped;
    return true;
}

std::string replace_plain_text(const std::string& text, const std::vector<std::string>& names,
                               const std::string& display) {
    std::string result = text;
    for (const auto& name : names) {
        if (name.empty()) continue;
        std::string replaced;
        size_t position = 0;
        while (position < result.size()) {
            size_t hit = result.find(name, position);
            if (hit == std::string::npos) {
                replaced.append(result, position, std::string::npos);
                break;
            }
            replaced.append(result, position, hit - position);
            replaced += display;
            position = hit + name.size();
        }
        result = replaced;
    }
    return result;
}

bool map_component_text(core::Json& node, const std::function<std::string(const std::string&)>& transform) {
    if (!transform) return false;
    return map_text_node(node, transform);
}
}  // namespace imcp::proxy
