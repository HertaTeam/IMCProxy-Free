cmake_minimum_required(VERSION 3.20)
project(imcproxy LANGUAGES CXX)

file(READ "${CMAKE_CURRENT_SOURCE_DIR}/VERSION" IMCP_VERSION)
string(STRIP "${IMCP_VERSION}" IMCP_VERSION)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if (MSVC)
    add_compile_options(/utf-8 /W3 /EHsc /permissive-)
    add_compile_definitions(_CRT_SECURE_NO_WARNINGS NOMINMAX WIN32_LEAN_AND_MEAN)
endif()

file(GLOB_RECURSE IMCPROXY_SOURCES CONFIGURE_DEPENDS
    "${CMAKE_CURRENT_SOURCE_DIR}/src/*.cpp"
)

add_executable(imcproxy ${IMCPROXY_SOURCES})

target_include_directories(imcproxy PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/src")
target_compile_definitions(imcproxy PRIVATE IMCP_VERSION="${IMCP_VERSION}" IMCP_FREE_EDITION)

target_link_libraries(imcproxy PRIVATE ws2_32 winhttp)

if (MSVC)
    set_property(TARGET imcproxy PROPERTY VS_DEBUGGER_WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}")
endif()

if (EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/config.json")
    add_custom_command(TARGET imcproxy POST_BUILD
        COMMAND ${CMAKE_COMMAND} -E copy_if_different
            "${CMAKE_CURRENT_SOURCE_DIR}/config.json"
            "$<TARGET_FILE_DIR:imcproxy>/config.json"
    )
endif()

install(TARGETS imcproxy RUNTIME DESTINATION .)

install(FILES "${CMAKE_CURRENT_SOURCE_DIR}/README.md" DESTINATION . OPTIONAL)

if (EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/config.json")
    install(FILES "${CMAKE_CURRENT_SOURCE_DIR}/config.json" DESTINATION .)
endif()