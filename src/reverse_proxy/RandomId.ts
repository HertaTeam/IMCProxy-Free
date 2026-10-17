import { randomBytes } from "crypto";

export type RandomIdMode = "off" | "startup" | "perConnection";

export const RANDOM_ID_MIN_LENGTH = 3;
export const RANDOM_ID_MAX_LENGTH = 16;
export const RANDOM_ID_DEFAULT_LENGTH = 8;

const ID_FIRST_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const ID_CHARS = ID_FIRST_CHARS + "0123456789_";

export function normalizeRandomIdLength(length?: number): number {
  const n = Math.trunc(Number(length));
  if (!Number.isFinite(n)) return RANDOM_ID_DEFAULT_LENGTH;
  return Math.min(Math.max(n, RANDOM_ID_MIN_LENGTH), RANDOM_ID_MAX_LENGTH);
}

export function parseRandomIdMode(value?: string | null): RandomIdMode | undefined {
  if (value == null) return undefined;

  switch (value.trim().toLowerCase().replace(/[\s_-]/g, "")) {
    case "off":
    case "false":
    case "0":
    case "no":
    case "none":
      return "off";
    case "startup":
    case "once":
    case "session":
    case "true":
    case "1":
    case "yes":
      return "startup";
    case "perconnection":
    case "perplayer":
    case "each":
      return "perConnection";
    default:
      return undefined;
  }
}

export function generateRandomId(length?: number): string {
  const len = normalizeRandomIdLength(length);
  const bytes = randomBytes(len);

  let id = ID_FIRST_CHARS[bytes[0] % ID_FIRST_CHARS.length];
  for (let i = 1; i < len; i++) {
    id += ID_CHARS[bytes[i] % ID_CHARS.length];
  }
  return id;
}

export function generateUniqueRandomId(taken: Set<string>, length?: number, maxAttempts = 64): string {
  const len = normalizeRandomIdLength(length);
  const isTaken = (id: string) => taken.has(id) || taken.has(id.toLowerCase());

  for (let i = 0; i < maxAttempts; i++) {
    const id = generateRandomId(len);
    if (!isTaken(id)) return id;
  }

  const prefix = generateRandomId(len).slice(0, Math.max(len - 2, 1));
  for (let i = 0; i < 1296; i++) {
    const suffix = i.toString(36).padStart(2, "0");
    const candidate = (prefix + suffix).slice(0, len);
    if (!isTaken(candidate)) return candidate;
  }

  throw new Error("Unable to generate a unique random ID, please increase randomIdLength");
}
