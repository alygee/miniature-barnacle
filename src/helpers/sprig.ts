import type Handlebars from "handlebars";
import type { Env } from "../env.js";

/** Own properties only, so `env "constructor"` is empty rather than Object's constructor. */
function lookupEnv(env: Env, name: string): string {
  return Object.hasOwn(env, name) ? (env[name] ?? "") : "";
}
import { plainHelper } from "./drone.js";
import {
  goDuration,
  goFormatTime,
  goQuote,
  goRegExp,
  goRegexReplaceAll,
  goString,
  goTitle,
  isGoZero,
  isValidTimeZone,
  toFloat64,
  toInt64,
} from "./golang.js";

type HandlebarsInstance = typeof Handlebars;

export interface SprigDeps {
  now: () => Date;
  env: Env;
}

/** sprig's date argument: time.Time, or unix seconds as a number; anything else means "now". */
function toDate(value: unknown, now: () => Date): Date {
  if (value instanceof Date) return value;
  if (typeof value === "number") return new Date(Math.trunc(value) * 1000);
  return now();
}

function trimCutset(value: string, cutset: string): string {
  const set = new Set(Array.from(cutset));
  const runes = Array.from(value);
  let start = 0;
  let end = runes.length;
  while (start < end && set.has(runes[start]!)) start++;
  while (end > start && set.has(runes[end - 1]!)) end--;
  return runes.slice(start, end).join("");
}

function indent(spaces: unknown, value: unknown): string {
  const pad = " ".repeat(Math.max(0, toInt64(spaces)));
  return pad + goString(value).replace(/\n/g, `\n${pad}`);
}

function nonNil(values: unknown[]): unknown[] {
  return values.filter((value) => value !== undefined && value !== null);
}

function divisor(value: unknown, name: string): number {
  const d = toInt64(value);
  if (d === 0) throw new Error(`${name}: integer divide by zero`);
  return d;
}

/**
 * Subset of Masterminds/sprig GenericFuncMap (spec §6.2). Argument order and int64 semantics follow sprig;
 * string slicing helpers work on runes instead of bytes so Cyrillic is never cut in half.
 */
export function registerSprigHelpers(hb: HandlebarsInstance, deps: SprigDeps): void {
  const helpers: Record<string, (...args: any[]) => unknown> = {
    // math: int64 results, division truncates toward zero
    add: (...values) => values.reduce((sum: number, value) => sum + toInt64(value), 0),
    add1: (value) => toInt64(value) + 1,
    sub: (a, b) => toInt64(a) - toInt64(b),
    mul: (a, ...values) => values.reduce((product: number, value) => product * toInt64(value), toInt64(a)),
    div: (a, b) => Math.trunc(toInt64(a) / divisor(b, "div")),
    mod: (a, b) => toInt64(a) % divisor(b, "mod"),
    max: (a, ...values) => values.reduce((m: number, value) => Math.max(m, toInt64(value)), toInt64(a)),
    min: (a, ...values) => values.reduce((m: number, value) => Math.min(m, toInt64(value)), toInt64(a)),
    floor: (value) => Math.floor(toFloat64(value)),
    ceil: (value) => Math.ceil(toFloat64(value)),
    round: (value, places, roundOn) => {
      const pow = 10 ** toInt64(places);
      const digit = pow * toFloat64(value);
      const fraction = digit - Math.trunc(digit);
      const threshold = roundOn === undefined ? 0.5 : toFloat64(roundOn);
      return (fraction >= threshold ? Math.ceil(digit) : Math.floor(digit)) / pow;
    },

    // strings
    trim: (s) => goString(s).trim(),
    trimAll: (cutset, s) => trimCutset(goString(s), goString(cutset)),
    trimPrefix: (prefix, s) => {
      const value = goString(s);
      const p = goString(prefix);
      return p !== "" && value.startsWith(p) ? value.slice(p.length) : value;
    },
    trimSuffix: (suffix, s) => {
      const value = goString(s);
      const x = goString(suffix);
      return x !== "" && value.endsWith(x) ? value.slice(0, -x.length) : value;
    },
    upper: (s) => goString(s).toUpperCase(),
    lower: (s) => goString(s).toLowerCase(),
    title: (s) => goTitle(goString(s)),
    replace: (from, to, s) => goString(s).split(goString(from)).join(goString(to)),
    contains: (substr, s) => goString(s).includes(goString(substr)),
    hasPrefix: (prefix, s) => goString(s).startsWith(goString(prefix)),
    hasSuffix: (suffix, s) => goString(s).endsWith(goString(suffix)),
    trunc: (count, s) => {
      const runes = Array.from(goString(s));
      const n = toInt64(count);
      if (n < 0 && runes.length + n > 0) return runes.slice(runes.length + n).join("");
      if (n >= 0 && runes.length > n) return runes.slice(0, n).join("");
      return runes.join("");
    },
    abbrev: (width, s) => {
      const runes = Array.from(goString(s));
      const w = toInt64(width);
      if (w < 4 || runes.length <= w) return runes.join("");
      return runes.slice(0, w - 3).join("") + "...";
    },
    substr: (start, end, s) => {
      const runes = Array.from(goString(s));
      const a = toInt64(start);
      const b = toInt64(end);
      if (a < 0) return runes.slice(0, b).join("");
      if (b < 0 || b > runes.length) return runes.slice(a).join("");
      return runes.slice(a, b).join("");
    },
    repeat: (count, s) => goString(s).repeat(Math.max(0, toInt64(count))),
    quote: (...values) => nonNil(values).map((value) => goQuote(goString(value))).join(" "),
    squote: (...values) => nonNil(values).map((value) => `'${goString(value)}'`).join(" "),
    nospace: (s) => goString(s).replace(/\s+/gu, ""),
    indent: (spaces, s) => indent(spaces, s),
    nindent: (spaces, s) => `\n${indent(spaces, s)}`,
    plural: (one, many, count) => (toInt64(count) === 1 ? goString(one) : goString(many)),
    cat: (...values) => nonNil(values).map(goString).join(" "),
    // explicit type: `toString` collides with Object.prototype and gets no contextual type
    toString: (value: unknown) => goString(value),
    atoi: (s) => toInt64(goString(s)),
    int: (value) => toInt64(value),
    int64: (value) => toInt64(value),

    // defaults
    default: (fallback, ...given) => (given.length === 0 || isGoZero(given[0]) ? fallback : given[0]),
    empty: (value) => isGoZero(value),
    coalesce: (...values) => values.find((value) => !isGoZero(value)),
    ternary: (whenTrue, whenFalse, condition) => (isGoZero(condition) ? whenFalse : whenTrue),

    // dates
    now: () => deps.now(),
    date: (layout, date) => goFormatTime(toDate(date, deps.now), goString(layout)),
    dateInZone: (layout, date, zone) => {
      const tz = goString(zone);
      return goFormatTime(toDate(date, deps.now), goString(layout), isValidTimeZone(tz) && tz !== "" ? tz : "UTC");
    },
    unixEpoch: (date) => String(Math.floor(toDate(date, deps.now).getTime() / 1000)),
    ago: (date) => goDuration(Math.round((deps.now().getTime() - toDate(date, deps.now).getTime()) / 1000)),

    // regex
    regexMatch: (pattern, s) => goRegExp(goString(pattern)).test(goString(s)),
    regexFind: (pattern, s) => goRegExp(goString(pattern)).exec(goString(s))?.[0] ?? "",
    regexReplaceAll: (pattern, s, replacement) => goRegexReplaceAll(goString(pattern), goString(s), goString(replacement)),

    // other
    b64enc: (s) => Buffer.from(goString(s), "utf8").toString("base64"),
    b64dec: (s) => Buffer.from(goString(s), "base64").toString("utf8"),
    env: (name) => lookupEnv(deps.env, goString(name)),
    expandenv: (s) =>
      goString(s).replace(/\$\{([^}]*)\}|\$([A-Za-z0-9_]+)/g, (_match, braced: string | undefined, bare: string | undefined) =>
        lookupEnv(deps.env, braced ?? bare ?? ""),
      ),
  };

  for (const [name, fn] of Object.entries(helpers)) hb.registerHelper(name, plainHelper(fn));
}
