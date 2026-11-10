import { color } from "../logger.js";

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
  k: (s) => s,
};

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

export function stripMcFormat(text: string): string {
  return text.replace(/§./g, "");
}

export function normalizeForMatch(text: string): string {
  return stripMcFormat(text).replace(/[\s|｜]+/g, "").toLowerCase();
}
