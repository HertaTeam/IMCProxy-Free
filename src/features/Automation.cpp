#include "features/Automation.hpp"

#include <chrono>
#include <fstream>
#include <sstream>

#include "core/Logger.hpp"
#include "core/Protocol.hpp"
#include "core/Util.hpp"

namespace imcp::features {

namespace {
core::Logger logger("Auto");

long long now_ms() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now().time_since_epoch())
        .count();
}

bool contains(const std::string& text, const std::string& needle) { return text.find(needle) != std::string::npos; }
}  // namespace

Automation::Automation(core::Config& config) : config_(config) {}

Automation::~Automation() = default;

void Automation::set_game_credentials(std::string account, std::string password) {
    account_ = std::move(account);
    password_ = std::move(password);
}

bool Automation::enabled() const { return config_.get_bool("automation.enabled", true); }

bool Automation::has_pending(const std::string& kind) const {
    const auto found = pending_.find(kind);
    if (found == pending_.end()) return false;
    return now_ms() - found->second < 20000;
}

void Automation::mark_pending(const std::string& kind) { pending_[kind] = now_ms(); }

std::string Automation::current_password() const {
    if (!password_.empty()) return password_;
    return config_.get_string("automation.defaultGamePassword", "");
}

void Automation::send(const std::string& message, const std::string& reason) {
    if (!sender_) return;
    logger.info(reason);
    if (!sender_(message)) logger.warn("failed to send: " + message);
}

void Automation::to_player(const std::string& message) {
    if (!config_.get_bool("automation.inGameReplies", true)) return;
    if (!client_sender_) return;
    core::Writer writer;
    writer.u8(chat_id_);
    writer.string("{\"text\":\"\\u00a77[auto] \\u00a7f" + message + "\"}");
    writer.i8(0);
    client_sender_(writer.take());
}

void Automation::note_chat(const std::string& plain) {
    if (!enabled() || plain.empty()) return;
    const std::string flat = core::to_lower(plain);

    if (contains(flat, "请使用/reg") || contains(flat, "请使用 /reg") || contains(flat, "请注册") ||
        contains(flat, "注册账号") || contains(flat, "请输入注册")) {
        if (!config_.get_bool("automation.autoRegisterOnJoin", true) || has_pending("register")) return;
        const std::string password = current_password();
        if (password.empty()) {
            logger.info("server asks to register but no password is known");
            return;
        }
        mark_pending("register");
        send("/reg " + password + " " + password, "server asks to register, sending /reg");
        to_player("server asks to register, sending /reg");
        return;
    }

    if (contains(flat, "请使用/login") || contains(flat, "请使用 /login") ||
        (contains(flat, "登录") && (contains(flat, "密码") || contains(flat, "password"))) ||
        contains(flat, "请输入密码")) {
        if (!config_.get_bool("automation.autoLoginOnJoin", true) || has_pending("login")) return;
        const std::string password = current_password();
        if (password.empty()) {
            logger.info("server asks to log in but no game password is known");
            return;
        }
        mark_pending("login");
        send("/login " + password, "server asks to log in, sending /login");
        to_player("server asks to log in, sending /login");
        return;
    }

    if (contains(flat, "成功注册") || contains(flat, "注册成功")) {
        logger.info("registration acknowledged by the server");
        pending_.erase("register");
        return;
    }

    if (contains(flat, "登录成功")) {
        logger.info("login acknowledged by the server");
        pending_.erase("login");
    }
}

}  // namespace imcp::features
