/**
 * 项目公告：本体（控制台 + 游戏内聊天栏）循环刷屏。
 *
 * README 里也写了同样一条，两边文案保持一致。
 * 间隔和开关都由 config.json 的 announce 段控制。
 */
import { Logger, color } from "../logger.js";
import type { ReverseProxy } from "./ReverseProxy.js";
import type { AnnounceConfig } from "./config.js";

const logger = new Logger("Announce");

/** 默认刷屏间隔：10 秒 */
export const ANNOUNCE_INTERVAL_MS = 10000;

/** 交流群号 */
export const GROUP_NUMBER = "1131093494";

/** 控制台里的两行文案 */
export const CONSOLE_NOTICE = [
  "本项目已暂停制作新内容，仅维护现有功能可以正常工作。",
  `交流群：${GROUP_NUMBER}`,
];

/** 游戏内聊天栏的文案（§ 是 Minecraft 的颜色代码） */
export const GAME_NOTICE = `§e[公告] §f本项目已暂停制作新内容，仅维护现有功能可以正常工作。 §b交流群 §l${GROUP_NUMBER}`;

/**
 * 开始刷屏。
 * @param config 来自 getAnnounceConfig()；enabled=false 时直接返回 null
 * @returns 定时器句柄（关闭时 clearInterval）；未启用时返回 null
 */
export function startAnnounce(proxy: ReverseProxy, config: AnnounceConfig): NodeJS.Timeout | null {
  if (!config.enabled) {
    logger.info("Announce spam is disabled (config.json -> announce.enabled = false).");
    return null;
  }

  const spam = (): void => {
    if (config.console) {
      for (const line of CONSOLE_NOTICE) logger.warn(color.yellow(line));
    }
    if (config.inGameChat) {
      try {
        proxy.broadcastChat(GAME_NOTICE);
      } catch {
        /* 没在线玩家或客户端已断开，忽略 */
      }
    }
  };

  // 启动立刻来一次，不用等第一个间隔
  spam();
  logger.info(
    `Announce spam every ${config.intervalMs}ms (console=${config.console}, chat=${config.inGameChat}).`
  );
  return setInterval(spam, config.intervalMs);
}
