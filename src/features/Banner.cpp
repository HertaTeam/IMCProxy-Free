#include "features/Banner.hpp"

#include <cstdio>
#include <cstring>

namespace imcp::features {

namespace {
const char* kBanner = R"BANNER( ______                      ____
/\__  _\                    /\  _`\
\/_/\ \/     ___ ___     ___\ \ \L\ \_ __   ___   __  _  __  __
   \ \ \   /' __` __`\  /'___\ \ ,__/\`'__\/ __`\/\ \/'\/\ \/\ \
    \_\ \__/\ \/\ \/\ \/\ \__/\ \ \/\ \ \//\ \L\ \/>  </\ \ \_\ \
    /\_____\ \_\ \_\ \_\ \____\\ \_\ \ \_\\ \____//\_/\_\\/`____ \
    \/_____/\/_/\/_/\/_/\/____/ \/_/  \/_/ \/___/ \//\/_/ `/___/> \
                                                             /\___/
                                                             \/__/
)BANNER";
}

void print_banner() {
    std::fwrite(kBanner, 1, std::strlen(kBanner), stdout);
    std::fflush(stdout);
}

}  // namespace imcp::features
