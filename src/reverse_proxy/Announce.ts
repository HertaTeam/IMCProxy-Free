/**
 * 项目公告：本体（控制台 + 游戏内聊天栏）循环刷屏。
 *
 * README 里也写了同样一条，两边文案保持一致。
 */
import { Logger, color } from "../logger.js";
import type { ReverseProxy } from "./ReverseProxy.js";

const logger = new Logger("Announce");

/** 刷屏间隔：3 秒一次 */
export const ANNOUNCE_INTERVAL_MS = 3000;

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
 * 开始刷屏：每 3 秒往控制台和所有在线玩家的聊天栏各推一遍公告。
 * @returns 定时器句柄（进程退出前可 clearInterval）
 */
export function startAnnounce(proxy: ReverseProxy, intervalMs: number = ANNOUNCE_INTERVAL_MS): NodeJS.Timeout {
  const spam = (): void => {
    for (const line of CONSOLE_NOTICE) logger.warn(color.yellow(line));
    try {
      proxy.broadcastChat(GAME_NOTICE);
    } catch {
      /* 没在线玩家或客户端已断开，忽略 */
    }
  };

  // 启动立刻来一次，不用等第一个 3 秒
  spam();
  return setInterval(spam, intervalMs);
}
