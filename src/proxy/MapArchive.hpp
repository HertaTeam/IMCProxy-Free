#pragma once

#include <array>
#include <atomic>
#include <cstdint>
#include <list>
#include <mutex>
#include <optional>
#include <string>
#include <string_view>

namespace imcp::proxy {

class MapArchive {
public:
    using Session = uint64_t;
    Session new_session() { return ++sessions_; }
    void note(Session session, int protocol, std::string_view payload);
    bool save(std::optional<int32_t> id, std::string& path, std::string& error) const;

private:
    struct Map {
        Session session;
        int protocol;
        int32_t id;
        std::array<uint8_t, 128 * 128> pixels{};
    };

    std::atomic<Session> sessions_{0};
    mutable std::mutex mutex_;
    std::list<Map> maps_;
};

}
