#include "core/ConsoleInput.hpp"

#include <windows.h>

#include "core/Logger.hpp"
#include <conio.h>

#include <atomic>
#include <cstdio>
#include <mutex>
#include <string>
#include <thread>

namespace imcp::core {

namespace {
std::mutex g_mutex;
std::string g_buffer;
std::atomic<bool> g_running{false};
std::thread g_thread;
ConsoleInput::Handler g_handler;
bool g_installed = false;

std::string to_utf8(wchar_t value) {
    char buffer[8] = {0};
    const int size = WideCharToMultiByte(CP_UTF8, 0, &value, 1, buffer, sizeof(buffer), nullptr, nullptr);
    if (size <= 0) return "";
    return std::string(buffer, static_cast<size_t>(size));
}

void write_raw(const std::string& text) {
    std::fwrite(text.c_str(), 1, text.size(), stdout);
    std::fflush(stdout);
}

void draw_prompt_locked() {
    if (Logger::colors_enabled()) {
        write_raw("\x1b[2K\r\x1b[32m> \x1b[0m" + g_buffer);
        return;
    }
    HANDLE output = GetStdHandle(STD_OUTPUT_HANDLE);
    const bool console = output != INVALID_HANDLE_VALUE && output != nullptr &&
                         GetFileType(output) == FILE_TYPE_CHAR;
    if (console) SetConsoleTextAttribute(output, 10);
    write_raw("\x1b[2K\r> " + g_buffer);
    if (console) SetConsoleTextAttribute(output, 7);
}

bool handle_is_console(DWORD std_handle) {
    HANDLE handle = GetStdHandle(std_handle);
    if (handle == INVALID_HANDLE_VALUE || handle == nullptr) return false;
    DWORD mode = 0;
    return GetConsoleMode(handle, &mode) != 0;
}

bool stdin_is_console() {
    return handle_is_console(STD_INPUT_HANDLE) && handle_is_console(STD_OUTPUT_HANDLE);
}
}  // namespace

bool ConsoleInput::interactive() { return stdin_is_console(); }

void ConsoleInput::install(Handler handler) {
    if (g_installed || !stdin_is_console()) return;
    g_installed = true;
    g_handler = std::move(handler);
    g_running = true;
    g_thread = std::thread(reader_loop);
}

void ConsoleInput::uninstall() {
    if (!g_installed) return;
    g_running = false;
    if (g_thread.joinable()) g_thread.join();
    g_installed = false;
}

void ConsoleInput::redraw() {
    std::lock_guard lock(g_mutex);
    write_raw("\x1b[2K\r");
    draw_prompt_locked();
}

void ConsoleInput::before_output() {
    std::lock_guard lock(g_mutex);
    write_raw("\x1b[2K\r");
}

void ConsoleInput::after_output() {
    std::lock_guard lock(g_mutex);
    draw_prompt_locked();
}

void ConsoleInput::reader_loop() {
    {
        std::lock_guard lock(g_mutex);
        draw_prompt_locked();
    }

    while (g_running) {
        wchar_t wide = 0;
        DWORD read = 0;
        HANDLE input_handle = GetStdHandle(STD_INPUT_HANDLE);
        if (!ReadConsoleW(input_handle, &wide, 1, &read, nullptr) || read == 0) {
            std::this_thread::sleep_for(std::chrono::milliseconds(50));
            continue;
        }
        const int key = static_cast<int>(wide);
        if (key == '\r') {
            std::string line;
            {
                std::lock_guard lock(g_mutex);
                line = g_buffer;
                g_buffer.clear();
                write_raw("\x1b[2K\r");
            }
            if (!line.empty() && g_handler) g_handler(line);
            std::lock_guard lock(g_mutex);
            draw_prompt_locked();
            continue;
        }
        if (key == '\b') {
            std::lock_guard lock(g_mutex);
            if (!g_buffer.empty()) {
                const unsigned char last = static_cast<unsigned char>(g_buffer.back());
                size_t width = 1;
                if ((last & 0xC0) == 0x80) {
                    while (width < g_buffer.size() &&
                           (static_cast<unsigned char>(g_buffer[g_buffer.size() - width - 1]) & 0xC0) == 0x80) {
                        ++width;
                    }
                    ++width;
                }
                g_buffer.resize(g_buffer.size() >= width ? g_buffer.size() - width : 0);
                write_raw("\x1b[2K\r");
                draw_prompt_locked();
            }
            continue;
        }
        if (key == 3) {
            write_raw("\n");
            std::fflush(stdout);
            std::exit(0);
        }
        if (key < 32) continue;

        const std::string utf8 = to_utf8(static_cast<wchar_t>(key));
        if (utf8.empty()) continue;
        std::lock_guard lock(g_mutex);
        g_buffer += utf8;
        write_raw(utf8);
    }
}

}  // namespace imcp::core
