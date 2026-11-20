#include "proxy/McStream.hpp"

#include <winsock2.h>

#include <stdexcept>

#include "core/Protocol.hpp"

namespace imcp::proxy {

bool recv_exact(uintptr_t socket_handle, char* buffer, size_t size) {
    size_t received = 0;
    while (received < size) {
        int result = recv(static_cast<SOCKET>(socket_handle), buffer + received,
                          static_cast<int>(size - received), 0);
        if (result <= 0) return false;
        received += static_cast<size_t>(result);
    }
    return true;
}

bool send_all(uintptr_t socket_handle, const std::string& data) {
    size_t sent = 0;
    while (sent < data.size()) {
        int result = send(static_cast<SOCKET>(socket_handle), data.data() + sent,
                          static_cast<int>(data.size() - sent), 0);
        if (result <= 0) return false;
        sent += static_cast<size_t>(result);
    }
    return true;
}

bool receive_packet(uintptr_t socket_handle, std::string& payload, std::string& error) {
    payload.clear();
    int32_t length = 0;
    int shift = 0;
    while (true) {
        char byte = 0;
        if (!recv_exact(socket_handle, &byte, 1)) {
            error = "connection closed while reading length";
            return false;
        }
        length |= static_cast<int32_t>(static_cast<unsigned char>(byte) & 0x7F) << shift;
        if ((static_cast<unsigned char>(byte) & 0x80) == 0) break;
        shift += 7;
        if (shift > 35) {
            error = "packet length varint too long";
            return false;
        }
    }
    if (length <= 0 || length > 4 * 1024 * 1024) {
        error = "invalid packet length " + std::to_string(length);
        return false;
    }
    payload.resize(static_cast<size_t>(length));
    if (!recv_exact(socket_handle, payload.data(), payload.size())) {
        error = "connection closed while reading payload";
        return false;
    }
    return true;
}

namespace {
enum class Chunk { Ok, Closed, Stopped };

Chunk recv_chunk(uintptr_t socket_handle, char* data, size_t count, const std::atomic<bool>& stop,
                 std::string& error) {
    size_t got = 0;
    while (got < count) {
        if (stop.load()) return Chunk::Stopped;
        fd_set read_set;
        FD_ZERO(&read_set);
        FD_SET(static_cast<SOCKET>(socket_handle), &read_set);
        timeval timeout{0, 200000};
        const int ready = select(0, &read_set, nullptr, nullptr, &timeout);
        if (ready == SOCKET_ERROR) {
            error = "select failed: " + std::to_string(WSAGetLastError());
            return Chunk::Closed;
        }
        if (ready == 0) continue;
        const int read = recv(static_cast<SOCKET>(socket_handle), data + got, static_cast<int>(count - got), 0);
        if (read <= 0) {
            error = "connection closed";
            return Chunk::Closed;
        }
        got += static_cast<size_t>(read);
    }
    return Chunk::Ok;
}
}

PacketRead receive_packet_interruptible(uintptr_t socket_handle, std::string& payload,
                                        const std::atomic<bool>& stop, std::string& error) {
    payload.clear();
    int32_t length = 0;
    int shift = 0;
    while (true) {
        char byte = 0;
        const Chunk chunk = recv_chunk(socket_handle, &byte, 1, stop, error);
        if (chunk == Chunk::Stopped) return PacketRead::Stopped;
        if (chunk == Chunk::Closed) {
            error = "connection closed while reading length";
            return PacketRead::Closed;
        }
        length |= static_cast<int32_t>(static_cast<unsigned char>(byte) & 0x7F) << shift;
        if ((static_cast<unsigned char>(byte) & 0x80) == 0) break;
        shift += 7;
        if (shift > 35) {
            error = "packet length varint too long";
            return PacketRead::Closed;
        }
    }
    if (length <= 0 || length > 4 * 1024 * 1024) {
        error = "invalid packet length " + std::to_string(length);
        return PacketRead::Closed;
    }
    payload.resize(static_cast<size_t>(length));
    const Chunk body = recv_chunk(socket_handle, payload.data(), payload.size(), stop, error);
    if (body == Chunk::Stopped) return PacketRead::Stopped;
    if (body == Chunk::Closed) {
        error = "connection closed while reading payload";
        return PacketRead::Closed;
    }
    return PacketRead::Ok;
}
bool send_packet(uintptr_t socket_handle, const std::string& payload, std::string& error) {
    core::Writer writer;
    writer.varint(static_cast<int32_t>(payload.size()));
    writer.raw(payload);
    if (!send_all(socket_handle, writer.data())) {
        error = "send failed";
        return false;
    }
    return true;
}

std::string frame_packet(const std::string& payload) {
    core::Writer writer;
    writer.varint(static_cast<int32_t>(payload.size()));
    writer.raw(payload);
    return writer.data();
}

void set_socket_timeout(uintptr_t socket_handle, int seconds) {
    DWORD timeout = static_cast<DWORD>(seconds * 1000);
    setsockopt(static_cast<SOCKET>(socket_handle), SOL_SOCKET, SO_RCVTIMEO,
               reinterpret_cast<const char*>(&timeout), sizeof(timeout));
    setsockopt(static_cast<SOCKET>(socket_handle), SOL_SOCKET, SO_SNDTIMEO,
               reinterpret_cast<const char*>(&timeout), sizeof(timeout));
}

}
