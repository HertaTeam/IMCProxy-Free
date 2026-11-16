#include "core/Logger.hpp"
#include "core/ConsoleInput.hpp"

#include <windows.h>

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <ctime>
#include <filesystem>
#include <fstream>

namespace imcp::core {

namespace {
constexpr const char* kReset = "\x1b[0m";
constexpr const char* kGray = "\x1b[90m";
constexpr const char* kCyan = "\x1b[36m";
constexpr const char* kGreen = "\x1b[32m";
constexpr const char* kYellow = "\x1b[33m";
constexpr const char* kBrightRed = "\x1b[91m";
constexpr const char* kWhite = "\x1b[37m";
constexpr const char* kBgRed = "\x1b[41m";

const char* level_tag(Level level) {
    switch (level) {
        case Level::Debug: return "DEBUG";
        case Level::Info: return "INFO";
        case Level::Warn: return "WARN";
        case Level::Error: return "ERROR";
        case Level::Fatal: return "FATAL";
    }
    return "INFO";
}

const char* level_color(Level level) {
    switch (level) {
        case Level::Debug: return kGray;
        case Level::Info: return kGreen;
        case Level::Warn: return kYellow;
        case Level::Error: return kBrightRed;
        case Level::Fatal: return kBgRed;
    }
    return kGreen;
}

std::string hhmmss() {
    std::time_t now = std::time(nullptr);
    std::tm local{};
    localtime_s(&local, &now);
    char buffer[16];
    std::strftime(buffer, sizeof(buffer), "%H:%M:%S", &local);
    return buffer;
}

std::string iso_time() {
    auto now = std::chrono::system_clock::now();
    const auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(now.time_since_epoch()) % 1000;
    std::time_t seconds = std::chrono::system_clock::to_time_t(now);
    std::tm utc{};
    gmtime_s(&utc, &seconds);
    char buffer[40];
    std::strftime(buffer, sizeof(buffer), "%Y-%m-%dT%H:%M:%S", &utc);
    char full[48];
    std::snprintf(full, sizeof(full), "%s.%03dZ", buffer, static_cast<int>(ms.count()));
    return full;
}

std::string stamp() {
    std::time_t now = std::time(nullptr);
    std::tm local{};
    localtime_s(&local, &now);
    char buffer[24];
    std::strftime(buffer, sizeof(buffer), "%Y%m%d-%H%M%S", &local);
    return buffer;
}

std::string pad(std::string_view text, size_t width) {
    std::string out(text);
    if (out.size() >= width) return out.substr(0, width);
    out.append(width - out.size(), ' ');
    return out;
}

std::string pad_end(std::string_view text, size_t width) {
    std::string out(text);
    if (out.size() < width) out.append(width - out.size(), ' ');
    return out;
}

int console_width() {
    CONSOLE_SCREEN_BUFFER_INFO info{};
    if (GetConsoleScreenBufferInfo(GetStdHandle(STD_OUTPUT_HANDLE), &info)) {
        return info.srWindow.Right - info.srWindow.Left + 1;
    }
    return 72;
}

bool enable_vt() {
    HANDLE out = GetStdHandle(STD_OUTPUT_HANDLE);
    if (out == INVALID_HANDLE_VALUE || out == nullptr) return false;
    if (GetFileType(out) != FILE_TYPE_CHAR) return false;
    DWORD mode = 0;
    if (!GetConsoleMode(out, &mode)) return false;
    if (!SetConsoleMode(out, mode | ENABLE_VIRTUAL_TERMINAL_PROCESSING)) {
        return (mode & ENABLE_VIRTUAL_TERMINAL_PROCESSING) != 0;
    }
    return true;
}

bool& colors_flag() {
    static bool value = false;
    return value;
}

bool console_attached() {
    HANDLE out = GetStdHandle(STD_OUTPUT_HANDLE);
    if (out == INVALID_HANDLE_VALUE || out == nullptr) return false;
    return GetFileType(out) == FILE_TYPE_CHAR;
}

void prune_logs(const std::filesystem::path& dir, int keep) {
    std::vector<std::filesystem::directory_entry> files;
    std::error_code error;
    for (const auto& entry : std::filesystem::directory_iterator(dir, error)) {
        if (!entry.is_regular_file()) continue;
        const std::string name = entry.path().filename().string();
        if (name.rfind("logs-", 0) == 0 && entry.path().extension() == ".txt") files.push_back(entry);
    }
    std::sort(files.begin(), files.end(), [](const auto& left, const auto& right) {
        return std::filesystem::last_write_time(left) > std::filesystem::last_write_time(right);
    });
    for (size_t i = static_cast<size_t>(std::max(0, keep)); i < files.size(); ++i) {
        std::filesystem::remove(files[i].path(), error);
    }
}
}  // namespace

std::mutex& Logger::mutex() {
    static std::mutex value;
    return value;
}

bool& Logger::verbose_flag() {
    static bool value = false;
    return value;
}

std::function<void(std::string_view)>& Logger::capture_sink() {
    static std::function<void(std::string_view)> value;
    return value;
}

std::vector<std::string>& Logger::ring() {
    static std::vector<std::string> value;
    return value;
}

std::string& Logger::log_path() {
    static std::string value;
    return value;
}

int& Logger::log_fd_placeholder() {
    static int value = 0;
    return value;
}

Logger::Logger(std::string name) : name_(std::move(name)) {}

void Logger::set_verbose(bool enabled) { verbose_flag() = enabled; }
bool Logger::verbose() { return verbose_flag(); }

std::string Logger::log_file_path() { return log_path(); }

void Logger::set_capture(std::function<void(std::string_view)> sink) {
    std::lock_guard lock(mutex());
    capture_sink() = std::move(sink);
}

void Logger::clear_capture() {
    std::lock_guard lock(mutex());
    capture_sink() = nullptr;
}

const std::vector<std::string>& Logger::recent() { return ring(); }

void Logger::start_run_log(const std::string& directory, int keep) {
    colors_flag() = enable_vt();
    std::error_code error;
    const std::filesystem::path dir(directory);
    std::filesystem::create_directories(dir, error);
    const std::filesystem::path file = dir / ("logs-" + stamp() + ".txt");
    log_path() = file.string();
    prune_logs(dir, keep);
    std::ofstream stream(file, std::ios::app | std::ios::binary);
    if (stream) stream << "=== log started at " << iso_time() << " ===\n";
}

void Logger::close_run_log() {
    if (log_path().empty()) return;
    std::ofstream stream(log_path(), std::ios::app | std::ios::binary);
    if (stream) stream << "=== log stopped at " << iso_time() << " ===\n";
    log_path().clear();
}

bool Logger::colors_enabled() { return colors_flag(); }

std::string Logger::console_line(Level level, std::string_view message) const {
    if (!colors_flag()) {
        return hhmmss() + " " + pad(level_tag(level), 5) + " " + pad(name_, 12) + " " + std::string(message);
    }
    std::string out;
    out += kGray;
    out += hhmmss();
    out += kReset;
    out += ' ';
    out += level_color(level);
    if (level == Level::Fatal) out += kWhite;
    out += pad(level_tag(level), 5);
    out += kReset;
    out += ' ';
    out += kCyan;
    out += pad(name_, 12);
    out += kReset;
    out += ' ';
    out += std::string(message);
    out += kReset;
    return out;
}

std::string Logger::file_line(Level level, std::string_view message) const {
    return iso_time() + " " + pad(level_tag(level), 5) + " " + pad(name_, 12) + " " + std::string(message);
}

void Logger::emit(Level level, std::string_view message, bool to_stderr) const {
    std::lock_guard lock(mutex());
    if (message.empty()) {
        std::fputc('\n', stdout);
        if (!log_path().empty()) {
            std::ofstream stream(log_path(), std::ios::app | std::ios::binary);
            if (stream) stream << "\n";
        }
        return;
    }

    const std::string console = console_line(level, message);
    if (ConsoleInput::interactive()) ConsoleInput::before_output();
    FILE* target = to_stderr ? stderr : stdout;
    std::fwrite(console.c_str(), 1, console.size(), target);
    std::fputc('\n', target);
    std::fflush(target);

    const std::string file = file_line(level, message);
    if (!log_path().empty()) {
        std::ofstream stream(log_path(), std::ios::app | std::ios::binary);
        if (stream) stream << file << "\n";
    }

    ring().push_back(file);
    if (ring().size() > 300) ring().erase(ring().begin());
    if (capture_sink()) capture_sink()(file);
}

void Logger::info(std::string_view message) const { emit(Level::Info, message, false); }
void Logger::warn(std::string_view message) const { emit(Level::Warn, message, true); }
void Logger::error(std::string_view message) const { emit(Level::Error, message, true); }
void Logger::fatal(std::string_view message) const { emit(Level::Fatal, message, true); }

void Logger::debug(std::string_view message) const {
    if (!verbose_flag()) return;
    emit(Level::Debug, message, true);
}

void Logger::section(std::string_view title) const {
    const int width = std::max(40, std::min(console_width() - 1, 78));
    int title_chars = 0;
    for (size_t i = 0; i < title.size();) {
        const unsigned char c = static_cast<unsigned char>(title[i]);
        i += (c < 0x80) ? 1 : (c < 0xE0) ? 2 : (c < 0xF0) ? 3 : 4;
        ++title_chars;
    }
    const int head_chars = 3 + title_chars + 1;
    const int fill = std::max(0, width - head_chars);

    std::string rule = "\xe2\x94\x80\xe2\x94\x80 " + std::string(title) + " ";
    for (int i = 0; i < fill; ++i) rule += "\xe2\x94\x80";

    std::lock_guard lock(mutex());
    const bool use_ansi = colors_flag();
    if (!use_ansi && ConsoleInput::interactive()) ConsoleInput::before_output();
    const std::string line = use_ansi ? std::string(kGray) + rule + kReset : rule;
    HANDLE output = GetStdHandle(STD_OUTPUT_HANDLE);
    if (!use_ansi && console_attached()) SetConsoleTextAttribute(output, 8);
    std::fwrite(line.c_str(), 1, line.size(), stdout);
    std::fputc('\n', stdout);
    std::fflush(stdout);
    if (!use_ansi && console_attached()) SetConsoleTextAttribute(output, 7);
    if (!use_ansi && ConsoleInput::interactive()) ConsoleInput::after_output();
    if (!log_path().empty()) {
        std::ofstream stream(log_path(), std::ios::app | std::ios::binary);
        if (stream) stream << "--- " << title << " " << std::string(static_cast<size_t>(fill), '-') << "\n";
    }
}

int Logger::console_columns() {
    const int width = console_width();
    return width > 0 ? width : 64;
}

void Logger::kv(std::string_view label, std::string_view value) const {
    std::string text = colors_flag()
                           ? "  " + std::string(kGray) + pad_end(label, 18) + std::string(kReset) + " " + std::string(value)
                           : "  " + pad_end(label, 18) + " " + std::string(value);
    std::lock_guard lock(mutex());
    std::string line = console_line(Level::Info, text);
    std::fwrite(line.c_str(), 1, line.size(), stdout);
    std::fputc('\n', stdout);
    std::fflush(stdout);
    const std::string file = file_line(Level::Info, text);
    if (!log_path().empty()) {
        std::ofstream stream(log_path(), std::ios::app | std::ios::binary);
        if (stream) stream << file << "\n";
    }
    ring().push_back(file);
    if (ring().size() > 300) ring().erase(ring().begin());
    if (capture_sink()) capture_sink()(file);
}

}  // namespace imcp::core
