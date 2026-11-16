#pragma once

#include <functional>
#include <mutex>
#include <string>
#include <string_view>
#include <vector>

namespace imcp::core {

enum class Level { Debug, Info, Warn, Error, Fatal };

class Logger {
public:
    explicit Logger(std::string name);

    void info(std::string_view message) const;
    void warn(std::string_view message) const;
    void error(std::string_view message) const;
    void fatal(std::string_view message) const;
    void debug(std::string_view message) const;

    void section(std::string_view title) const;
    void kv(std::string_view label, std::string_view value) const;

    static void start_run_log(const std::string& directory = "logs", int keep = 50);
    static void close_run_log();
    static std::string log_file_path();
    static int console_columns();
    static bool colors_enabled();
    static void set_verbose(bool enabled);
    static bool verbose();
    static void set_capture(std::function<void(std::string_view)> sink);
    static void clear_capture();
    static const std::vector<std::string>& recent();

private:
    void emit(Level level, std::string_view message, bool to_stderr) const;
    std::string console_line(Level level, std::string_view message) const;
    std::string file_line(Level level, std::string_view message) const;
    std::string name_;

    static std::mutex& mutex();
    static bool& verbose_flag();
    static std::function<void(std::string_view)>& capture_sink();
    static std::vector<std::string>& ring();
    static std::string& log_path();
    static int& log_fd_placeholder();
};

}  // namespace imcp::core
