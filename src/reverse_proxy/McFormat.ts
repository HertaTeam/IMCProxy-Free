import { color } from "../logger.js";

/**
 * Minecraft 聊天格式码（§x）→ 终端颜色。
 *
 * 用途：把服务端发来的彩色聊天原样"映射"到 IMCP 控制台，
 * 而不是把颜色码剥掉变成一行白字。
 */

type Style = (s: string) => string;

const COLORS: Record<string, Style> = {
  "0": color.black,
  "1": color.blue,
  "2": color.green,
  "3": color.cyan,
  "4": color.red,
  "5": color.magenta,
  "6": color.yellow,
  "7": color.gray,
  "8": color.gray,
  "9": color.blue,
  a: color.green,
  b: color.cyan,
  c: color.red,
  d: color.magenta,
  e: color.yellow,
  f: color.white,
};

const FORMATS: Record<string, Style> = {
  l: color.bold,
  m: color.strikethrough,
  n: color.underline,
  o: color.italic,
  k: (s) => s, // 乱码效果不做
};

/** 把 § 颜色/格式码转成 ANSI 上色（颜色码会清掉之前的格式，与游戏内一致） */
export function mcToAnsi(text: string): string {
  let styles: Style[] = [];
  let out = "";

  for (const part of text.split(/(§.)/)) {
    if (part.length === 2 && part[0] === "§") {
      const code = part[1].toLowerCase();
      if (code === "r") {
        styles = [];
      } else if (COLORS[code]) {
        styles = [COLORS[code]];
      } else if (FORMATS[code]) {
        styles.push(FORMATS[code]);
      }
      continue;
    }

    let segment = part;
    for (const style of styles) segment = style(segment);
    out += segment;
  }

  return out;
}

/** 去掉所有 § 格式码，得到纯文本（用于正则匹配） */
export function stripMcFormat(text: string): string {
  return text.replace(/§./g, "");
}

/**
 * 归一化：去格式码、去空白、去装饰竖线。
 * 用于「服务端提示」这类模糊匹配 —— 服务端随时可能调整空格与排版。
 */
export function normalizeForMatch(text: string): string {
  return stripMcFormat(text).replace(/[\s|｜]+/g, "").toLowerCase();
}
