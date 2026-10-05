import type Handlebars from "handlebars";
import {
  goDuration,
  goFormatTime,
  goQueryEscape,
  goRegexReplaceAll,
  goString,
  isGoZero,
  isValidTimeZone,
  toInt64,
} from "./golang.js";

type HandlebarsInstance = typeof Handlebars;
type HelperOptions = Handlebars.HelperOptions;

/** Handlebars passes an options object as the last argument; plain helpers never need it. */
export function plainHelper(fn: (...args: any[]) => unknown): (...raw: unknown[]) => unknown {
  return (...raw) => fn(...raw.slice(0, -1));
}

function statusBlock(matches: readonly string[]) {
  return function (this: unknown, conditional: unknown, options: HelperOptions): string {
    if (isGoZero(conditional)) return options.inverse(this);
    return matches.includes(goString(conditional)) ? options.fn(this) : options.inverse(this);
  };
}

/** Helpers of appleboy/drone-template-lib (template/helpers.go) plus raymond's built-in `equal`. */
export function registerDroneHelpers(hb: HandlebarsInstance, now: () => Date): void {
  hb.registerHelper({
    duration: plainHelper((started, finished) => goDuration(toInt64(finished) - toInt64(started))),
    datetime: plainHelper((timestamp, layout, zone) => {
      const tz = goString(zone);
      return goFormatTime(
        new Date(toInt64(timestamp) * 1000),
        goString(layout),
        tz !== "" && isValidTimeZone(tz) ? tz : undefined,
      );
    }),
    success: statusBlock(["success"]),
    failure: statusBlock(["failure", "error", "killed"]),
    truncate: plainHelper((value, length) => {
      const runes = Array.from(goString(value));
      const n = toInt64(length);
      if (runes.length <= Math.abs(n)) return runes.join("");
      return n < 0 ? runes.slice(-n).join("") : runes.slice(0, n).join("");
    }),
    urlencode: function (this: unknown, options: HelperOptions) {
      return goQueryEscape(options.fn(this));
    },
    since: plainHelper((start) => goDuration(Math.floor(now().getTime() / 1000) - toInt64(start))),
    uppercasefirst: plainHelper((value) => {
      const runes = Array.from(goString(value));
      if (runes.length === 0) return "";
      runes[0] = runes[0]!.toUpperCase();
      return runes.join("");
    }),
    uppercase: plainHelper((value) => goString(value).toUpperCase()),
    lowercase: plainHelper((value) => goString(value).toLowerCase()),
    regexReplace: plainHelper((pattern, input, replacement) =>
      goRegexReplaceAll(goString(pattern), goString(input), goString(replacement)),
    ),
    equal: function (this: unknown, a: unknown, b: unknown, options: HelperOptions) {
      return goString(a) === goString(b) ? options.fn(this) : options.inverse(this);
    },
  });
}
