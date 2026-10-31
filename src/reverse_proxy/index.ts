import { ReverseProxy } from "./ReverseProxy.js";
import { ConsoleCommands } from "./ConsoleCommands.js";
import { GameAutomation } from "./GameAutomation.js";
import { consoleUi } from "./ConsoleUi.js";
import { ensureBackupDir } from "./Backup.js";
import { printBanner } from "./Banner.js";
import { startAnnounce } from "./Announce.js";
import { bumpDailyCount, checkForUpdates, formatNotice } from "./UpdateCheck.js";
import {
  getConfig,
  getConsoleConfig,
  getAnnounceConfig,
  getUpdateCheckConfig,
  getAutomationConfig,
  getConfigFilePath,
  onConfigChange,
} from "./config.js";
import { Logger, verboseLogging, color, startRunLog, closeRunLog, getLogFilePath, writeLogLine } from "../logger.js";

const logger = new Logger("Launcher");

async function main() {
  // 先打启动横幅（ASCII art），刻意不走 logger：不然每行都会带时间戳前缀
  printBanner();

  // 一开始就打开本次运行的日志文件：logs/logs-<时间戳>.txt
  // 放在读配置之前，这样连「配置加载失败」这类早期日志也能留下来
  const logFile = startRunLog();

  const config = getConfig();
  const consoleConfig = getConsoleConfig();
  const automationConfig = getAutomationConfig();
  verboseLogging(config.debug);

  logger.section("IMCProxy-Free");
  logger.kv("Config file", getConfigFilePath());
  logger.kv("Log file", logFile ?? "(disabled - cannot create logs folder)");
  logger.kv("Backup folder", ensureBackupDir());
  logger.kv("Listen", `${config.tcpHost}:${config.tcpPort}`);
  logger.kv("Upstream server", config.eaglerServer);
  logger.kv("Max players", config.maxPlayers);
  logger.kv("Random ID mode", config.randomIdMode ?? "off");
  logger.kv("Debug mode", config.debug);
  logger.kv("Console", `autoHelp=${consoleConfig.autoHelp} autoStatus=${consoleConfig.autoStatus} echo=${consoleConfig.echo}`);

  // 版本：当日启动次数 +1（跨天清零），并把 editDate 打出来
  const updateConfig = getUpdateCheckConfig();
  const versionState = bumpDailyCount();
  logger.kv("Version", `${versionState.editDate} (${versionState.count} launch(es) today)`);

  logger.section("Features");
  logger.kv("In-game automation", automationConfig.enabled ? "enabled" : "disabled");
  logger.kv("Game account file", automationConfig.gameAccountFile);
  logger.kv(
    "nameprotect",
    config.nameProtect?.enabled ? `enabled (display as "${config.nameProtect.name}")` : "disabled"
  );

  logger.info("");

  const automation = automationConfig.enabled ? new GameAutomation(automationConfig) : null;
  const proxy = new ReverseProxy(config, automation);

  // 配置热更新：/set 改完立刻生效（不用重启）
  let announceTimer: NodeJS.Timeout | null = null;
  const restartAnnounce = (): void => {
    if (announceTimer) clearInterval(announceTimer);
    announceTimer = startAnnounce(proxy, getAnnounceConfig());
  };
  onConfigChange((keyPath) => {
    if (keyPath.startsWith("nameProtect") || keyPath.startsWith("serverNameSpoof")) {
      proxy.applyRuntimeConfig();
    } else if (keyPath.startsWith("announce")) {
      restartAnnounce();
    }
  });
  const consoleCommands = new ConsoleCommands(proxy, { echo: consoleConfig.echo });


  // 配置读完后启用底部输入框（在此之前都是普通逐行输出）
  consoleUi.enable(consoleConfig.echo);

  // 先把控制台挂起来：即使后面代理端口被占用启动失败，/help 等命令依然可用。
  consoleCommands.start();
  if (consoleConfig.autoHelp) consoleCommands.printHelp();

  // 公告刷屏：控制台 + 游戏内聊天栏（间隔与开关见 config.json -> announce）
  announceTimer = startAnnounce(proxy, getAnnounceConfig());

  // 更新提示：和 GitHub 上的 version.json 比 editDate（取不到就静默跳过）
  void checkForUpdates(updateConfig, (result) => {
    if (!updateConfig.notifyInGame) return;
    try {
      proxy.broadcastChat(formatNotice(result));
    } catch {
      /* 没有在线玩家，忽略 */
    }
  }).then((result) => {
    if (result.status === "up-to-date") logger.info(result.message);
    else if (result.status === "unknown") logger.debug(result.message);
  });



  proxy.on("started", () => {
    logger.info("✓ Reverse proxy is now running!");
    logger.info("Connect with your Minecraft 1.8.9 client to start playing.");
  });

  proxy.on("playerConnect", (player) => {
    logger.info(`→ Player connected: ${player.username} (${player.uuid})`);
    if (player.upstreamUsername && player.upstreamUsername !== player.username) {
      logger.info(`  Upstream ID seen by the server (random ID mode): ${player.upstreamUsername}`);
    }
  });

  proxy.on("playerDisconnect", (player) => {
    logger.info(`← Player disconnected: ${player.username}`);
  });

  proxy.on("stopped", () => {
    logger.info("Reverse proxy has stopped.");
  });

  process.on("SIGINT", async () => {
    logger.info("Received SIGINT, shutting down...");
    consoleCommands.stop();
    await proxy.stop();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    logger.info("Received SIGTERM, shutting down...");
    consoleCommands.stop();
    await proxy.stop();
    process.exit(0);
  });

  process.on("uncaughtException", (err) => {
    logger.error(`Uncaught exception: ${err.stack || err.message}`);
  });

  process.on("unhandledRejection", (reason) => {
    logger.error(`Unhandled rejection: ${reason}`);
  });

  // 退出时把日志文件关掉（closeRunLog 会写一行收尾标记）
  const closeLog = () => {
    try {
      closeRunLog();
    } catch {
      /* ignore */
    }
  };
  process.once("exit", closeLog);
  process.once("SIGINT", () => {
    closeLog();
    process.exit(0);
  });
  process.once("SIGTERM", () => {
    closeLog();
    process.exit(0);
  });
  process.once("SIGBREAK", () => {
    closeLog();
    process.exit(0);
  });

  try {
    await proxy.start();
  } catch (err) {
    logger.error("=".repeat(60));
    logger.error(`Failed to start the proxy: ${(err as Error).message}`);
    const msg = (err as Error).message || "";
    if (msg.includes("EADDRINUSE")) {
      logger.error(`Port ${config.tcpHost}:${config.tcpPort} is already in use - another proxy instance`);
      logger.error("may be running, or your Minecraft server uses that port.");
      logger.error("Fix: close the program using the port, or set REVERSE_PROXY_PORT and restart.");
    }
    logger.error("Console commands still work (/help, /config, /backup, ...).");
    logger.error("After fixing the problem, restart this program so the proxy actually listens.");
    logger.error("=".repeat(60));
    // 不再 process.exit：否则控制台会立刻消失，用户连报错都来不及看。
    return;
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  try {
    writeLogLine(`Fatal error: ${err?.stack ?? err}`);
    closeRunLog();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
