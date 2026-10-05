export type Env = Record<string, string | undefined>;

export class ConfigError extends Error {
  override name = "ConfigError";
}

export const PREFIXES = ["PLUGIN_", "TELEGRAM_", "INPUT_"] as const;

export interface RawValue {
  key: string;
  value: string;
}

export function paramKeys(name: string, prefixes: readonly string[] = PREFIXES): string[] {
  const upper = name.toUpperCase();
  return prefixes.map((prefix) => prefix + upper);
}

/** First key whose value is not blank — blank values count as unset, like drone-telegram's unsetEmptyEnv. */
export function firstSet(env: Env, keys: readonly string[]): RawValue | undefined {
  for (const key of keys) {
    const value = env[key];
    if (value !== undefined && value.trim() !== "") return { key, value };
  }
  return undefined;
}

// Go strconv.ParseBool
const TRUE_VALUES = new Set(["1", "t", "T", "TRUE", "true", "True"]);
const FALSE_VALUES = new Set(["0", "f", "F", "FALSE", "false", "False"]);

export function parseBool(raw: RawValue | undefined, fallback = false): boolean {
  if (!raw) return fallback;
  const value = raw.value.trim();
  if (TRUE_VALUES.has(value)) return true;
  if (FALSE_VALUES.has(value)) return false;
  throw new ConfigError(`${raw.key}: invalid boolean "${raw.value}"`);
}

export function parseInteger(raw: RawValue | undefined): number | undefined {
  if (!raw) return undefined;
  const value = raw.value.trim();
  if (!/^-?\d+$/.test(value)) throw new ConfigError(`${raw.key}: invalid integer "${raw.value}"`);
  return Number(value);
}

export function parseList(raw: RawValue | undefined): string[] {
  if (!raw) return [];
  return raw.value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}
