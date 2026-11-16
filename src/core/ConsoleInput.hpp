#pragma once

#include <functional>
#include <string>

namespace imcp::core {

class ConsoleInput {
public:
    using Handler = std::function<void(const std::string&)>;

    static bool interactive();
    static void install(Handler handler);
    static void uninstall();

    static void before_output();
    static void after_output();
    static void redraw();

private:
    static void reader_loop();
};

}  // namespace imcp::core
