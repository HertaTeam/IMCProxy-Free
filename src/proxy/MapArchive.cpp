#include "proxy/MapArchive.hpp"

#include <windows.h>

#include <algorithm>
#include <chrono>
#include <filesystem>
#include <stdexcept>

#include "core/Protocol.hpp"

namespace imcp::proxy {

namespace {
constexpr int side = 128;
constexpr size_t max_cached_maps = 64;
constexpr uint32_t colors[] = {
    0, 0x7fb238, 0xf7e9a3, 0xc7c7c7, 0xff0000, 0xa0a0ff, 0xa7a7a7, 0x007c00,
    0xffffff, 0xa4a8b8, 0x976d4d, 0x707070, 0x4040ff, 0x8f7748, 0xfffcf5, 0xd87f33,
    0xb24cd8, 0x6699d8, 0xe5e533, 0x7fcc19, 0xf27fa5, 0x4c4c4c, 0x999999, 0x4c7f99,
    0x7f3fb2, 0x334cb2, 0x664c33, 0x667f33, 0x993333, 0x191919, 0xfaee4d, 0x5cdbd5,
    0x4a80ff, 0x00d93a, 0x815631, 0x700200, 0xd1b1a1, 0x9f5224, 0x95576c, 0x706c8a,
    0xba8524, 0x677535, 0xa04d4e, 0x392923, 0x876b62, 0x575c5c, 0x7a4958, 0x4c3e5c,
    0x4c3223, 0x4c522a, 0x8e3c2e, 0x251610,
};
constexpr int shades[] = {180, 220, 255, 135};

void put32(std::string& out, uint32_t value) {
    for (int shift = 24; shift >= 0; shift -= 8) out.push_back(static_cast<char>(value >> shift));
}

void chunk(std::string& out, std::string_view type, std::string_view data) {
    put32(out, static_cast<uint32_t>(data.size()));
    const size_t start = out.size();
    out += type;
    out += data;
    uint32_t crc = 0xffffffff;
    for (size_t i = start; i < out.size(); ++i) {
        crc ^= static_cast<uint8_t>(out[i]);
        for (int bit = 0; bit < 8; ++bit) crc = (crc >> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    put32(out, ~crc);
}

std::string zlib_stored(std::string_view data) {
    std::string out("\x78\x01", 2);
    for (size_t pos = 0; pos < data.size();) {
        const auto count = static_cast<uint16_t>(std::min<size_t>(65535, data.size() - pos));
        const uint16_t inverse = static_cast<uint16_t>(~count);
        out.push_back(pos + count == data.size() ? '\x01' : '\x00');
        for (uint16_t value : {count, inverse}) {
            out.push_back(static_cast<char>(value));
            out.push_back(static_cast<char>(value >> 8));
        }
        out += data.substr(pos, count);
        pos += count;
    }
    uint32_t a = 1;
    uint32_t b = 0;
    for (unsigned char value : data) {
        a = (a + value) % 65521;
        b = (b + a) % 65521;
    }
    put32(out, (b << 16) | a);
    return out;
}

std::string make_png(const std::array<uint8_t, side * side>& pixels, int protocol) {
    std::string rows;
    rows.reserve(side * (1 + 4 * side));
    for (int y = 0; y < side; ++y) {
        rows.push_back('\0');
        for (int x = 0; x < side; ++x) {
            const auto index = pixels[y * side + x];
            const int color = index >> 2;
            if (color == 0 || color >= (protocol == 47 ? 36 : static_cast<int>(std::size(colors)))) {
                rows.append(4, '\0');
                continue;
            }
            for (int shift : {16, 8, 0}) {
                rows.push_back(static_cast<char>(((colors[color] >> shift) & 255) * shades[index & 3] / 255));
            }
            rows.push_back(static_cast<char>(255));
        }
    }
    std::string png("\x89PNG\r\n\x1a\n", 8);
    std::string header;
    put32(header, side);
    put32(header, side);
    header.append("\x08\x06\0\0\0", 5);
    chunk(png, "IHDR", header);
    chunk(png, "IDAT", zlib_stored(rows));
    chunk(png, "IEND", {});
    return png;
}
}

void MapArchive::note(Session session, int protocol, std::string_view payload) {
    try {
        core::Reader reader(payload);
        const int expected = protocol == 47 ? 0x34 : protocol == 340 ? 0x24 : -1;
        if (expected < 0 || reader.varint() != expected) return;
        const int32_t id = reader.varint();
        if (id < 0) return;
        reader.u8();
        if (protocol == 340) reader.boolean();
        const int32_t icons = reader.varint();
        if (icons < 0 || static_cast<size_t>(icons) > reader.remaining() / 3) return;
        for (int32_t i = 0; i < icons; ++i) {
            reader.u8();
            reader.u8();
            reader.u8();
        }
        const int width = reader.u8();
        if (width == 0) return;
        const int height = reader.u8();
        const int x = reader.u8();
        const int y = reader.u8();
        if (height == 0 || x + width > side || y + height > side) return;
        const int32_t size = reader.varint();
        if (size != width * height || static_cast<size_t>(size) != reader.remaining()) return;
        const auto patch = reader.rest();

        std::lock_guard lock(mutex_);
        auto item = std::find_if(maps_.begin(), maps_.end(), [&](const Map& map) {
            return map.session == session && map.id == id;
        });
        if (item == maps_.end()) {
            maps_.push_front(Map{session, protocol, id});
            if (maps_.size() > max_cached_maps) maps_.pop_back();
        } else {
            maps_.splice(maps_.begin(), maps_, item);
        }
        auto& pixels = maps_.front().pixels;
        for (int row = 0; row < height; ++row) {
            std::copy_n(patch.begin() + row * width, width, pixels.begin() + (y + row) * side + x);
        }
    } catch (const std::runtime_error&) {
    }
}

bool MapArchive::save(std::optional<int32_t> id, std::string& path, std::string& error) const {
    std::optional<Map> map;
    {
        std::lock_guard lock(mutex_);
        const auto item = std::find_if(maps_.begin(), maps_.end(), [&](const Map& entry) {
            return !id || entry.id == *id;
        });
        if (item != maps_.end()) map = *item;
    }
    if (!map) {
        error = id ? "No map pixels received for ID " + std::to_string(*id) : "No map pixels received yet";
        return false;
    }

    const std::string png = make_png(map->pixels, map->protocol);
    std::error_code ec;
    std::filesystem::create_directories("maps", ec);
    if (ec) {
        error = "Cannot create maps directory: " + ec.message();
        return false;
    }
    static std::atomic<uint64_t> sequence{0};
    const auto timestamp = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count();
    path = "maps/map-" + std::to_string(map->id) + "-" + std::to_string(timestamp) + "-" +
           std::to_string(GetCurrentProcessId()) + "-" + std::to_string(++sequence) + ".png";
    const auto file = std::filesystem::path(path);
    const HANDLE handle = CreateFileW(file.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (handle == INVALID_HANDLE_VALUE) {
        error = "Cannot create " + path + " (Windows error " + std::to_string(GetLastError()) + ")";
        return false;
    }
    DWORD written = 0;
    const bool ok = WriteFile(handle, png.data(), static_cast<DWORD>(png.size()), &written, nullptr) != 0 &&
                    written == png.size();
    CloseHandle(handle);
    if (!ok) {
        std::filesystem::remove(file, ec);
        error = "Cannot write " + path;
        return false;
    }
    return true;
}

}
