#pragma once

#include <atomic>

#include <cstdint>
#include <string>

namespace imcp::proxy {

bool recv_exact(uintptr_t socket_handle, char* buffer, size_t size);
bool send_all(uintptr_t socket_handle, const std::string& data);

bool receive_packet(uintptr_t socket_handle, std::string& payload, std::string& error);

enum class PacketRead { Ok, Closed, Stopped };

PacketRead receive_packet_interruptible(uintptr_t socket_handle, std::string& payload,
                                        const std::atomic<bool>& stop, std::string& error);
bool send_packet(uintptr_t socket_handle, const std::string& payload, std::string& error);

std::string frame_packet(const std::string& payload);

void set_socket_timeout(uintptr_t socket_handle, int seconds);

}
