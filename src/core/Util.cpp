#include "core/Util.hpp"

#include <algorithm>
#include <cctype>
#include <random>

namespace imcp::core {

std::string uuid_from_bytes(const std::string& raw16) {
    static const char* hex = "0123456789abcdef";
    std::string out;
    for (unsigned char c : raw16) {
        out.push_back(hex[c >> 4]);
        out.push_back(hex[c & 0x0F]);
    }
    if (out.size() != 32) return "";
    return out.substr(0, 8) + "-" + out.substr(8, 4) + "-" + out.substr(12, 4) + "-" + out.substr(16, 4) + "-" +
           out.substr(20);
}

std::string random_name(int length) {
    static const char* alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    std::random_device device;
    std::mt19937 generator(device());
    std::uniform_int_distribution<int> distribution(0, 61);
    std::string out;
    out.reserve(static_cast<size_t>(length));
    for (int i = 0; i < length; ++i) out.push_back(alphabet[distribution(generator)]);
    return out;
}

std::string to_lower(std::string value) {
    std::transform(value.begin(), value.end(), value.begin(),
                   [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    return value;
}

std::string trim(std::string value) {
    auto not_space = [](unsigned char c) { return !std::isspace(c); };
    value.erase(value.begin(), std::find_if(value.begin(), value.end(), not_space));
    value.erase(std::find_if(value.rbegin(), value.rend(), not_space).base(), value.end());
    return value;
}

bool starts_with(std::string_view text, std::string_view prefix) {
    return text.size() >= prefix.size() && text.substr(0, prefix.size()) == prefix;
}

int utf16_length(const std::string& text) {
    int units = 0;
    for (size_t i = 0; i < text.size();) {
        const unsigned char c = static_cast<unsigned char>(text[i]);
        size_t width = 1;
        int produced = 1;
        if ((c & 0x80) == 0) {
            width = 1;
            produced = 1;
        } else if ((c & 0xE0) == 0xC0) {
            width = 2;
            produced = 1;
        } else if ((c & 0xF0) == 0xE0) {
            width = 3;
            produced = 1;
        } else if ((c & 0xF8) == 0xF0) {
            width = 4;
            produced = 2;
        } else {
            width = 1;
            produced = 1;
        }
        if (i + width > text.size()) break;
        units += produced;
        i += width;
    }
    return units;
}

std::string clamp_utf16(const std::string& text, int max_units) {
    if (max_units <= 0) return text;
    int units = 0;
    size_t index = 0;
    while (index < text.size()) {
        const unsigned char c = static_cast<unsigned char>(text[index]);
        size_t width = 1;
        int produced = 1;
        if ((c & 0x80) == 0) {
            width = 1;
        } else if ((c & 0xE0) == 0xC0) {
            width = 2;
        } else if ((c & 0xF0) == 0xE0) {
            width = 3;
        } else if ((c & 0xF8) == 0xF0) {
            width = 4;
            produced = 2;
        }
        if (index + width > text.size()) break;
        if (units + produced > max_units) break;
        units += produced;
        index += width;
    }
    return text.substr(0, index);
}

}
