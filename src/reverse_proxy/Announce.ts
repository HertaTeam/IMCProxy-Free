import { Logger, color } from "../logger.js";
import type { ReverseProxy } from "./ReverseProxy.js";
import type { AnnounceConfig } from "./config.js";

const logger = new Logger("Announce");

export const ANNOUNCE_INTERVAL_MS = 10000;

export const GROUP_NUMBER = "1131093494";

export const CONSOLE_NOTICE = [
  "本项目已暂停制作新内容，仅维护现有功能可以正常工作。",
  `交流群：${GROUP_NUMBER}`,
];

export const GAME_NOTICE = `§e[公告] §f本项目已暂停制作新内容，仅维护现有功能可以正常工作。 §b交流群 §l${GROUP_NUMBER}`;

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

      }
    }
  };

  spam();
  logger.info(
    `Announce spam every ${config.intervalMs}ms (console=${config.console}, chat=${config.inGameChat}).`
  );
  return setInterval(spam, config.intervalMs);
}
