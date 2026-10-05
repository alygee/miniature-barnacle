// Go-compatible primitives used by the template helpers (drone-template-lib and sprig are Go libraries).

/** spf13/cast ToInt64 as used by sprig: integers and integer strings; anything else is 0. */
export function toInt64(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? Math.trunc(value) : 0;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return /^[+-]?\d+$/.test(trimmed) ? Number(trimmed) : 0;
  }
  return 0;
}

/** spf13/cast ToFloat64 as used by sprig. */
export function toFloat64(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(trimmed) ? Number(trimmed) : 0;
  }
  return 0;
}

/** time.Duration.String() for whole seconds: 0s, 45s, 2m5s, 1h0m0s. */
export function goDuration(totalSeconds: number): string {
  let seconds = Math.trunc(totalSeconds);
  if (seconds === 0) return "0s";
  const sign = seconds < 0 ? "-" : "";
  seconds = Math.abs(seconds);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  if (hours > 0) return `${sign}${hours}h${minutes}m${rest}s`;
  if (minutes > 0) return `${sign}${minutes}m${rest}s`;
  return `${sign}${rest}s`;
}

/** url.QueryEscape: keeps A-Z a-z 0-9 - _ . ~, space becomes +, everything else is %XX of UTF-8 bytes. */
export function goQueryEscape(value: string): string {
  return encodeURIComponent(value)
    .replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%20/g, "+");
}

/** RE2 pattern → RegExp; a leading (?flags) group with i/m/s becomes JS flags. */
export function goRegExp(pattern: string, global = false): RegExp {
  let source = pattern;
  let flags = global ? "g" : "";
  const inline = /^\(\?([ims]+)\)/.exec(pattern);
  if (inline) {
    source = pattern.slice(inline[0].length);
    for (const flag of inline[1]!) if (!flags.includes(flag)) flags += flag;
  }
  // RE2 named groups (?P<name>...) → JS (?<name>...)
  source = source.replace(/\(\?P</g, "(?<");
  return new RegExp(source, flags);
}

/** regexp.ReplaceAllString with Go's $1 / ${1} / ${name} / $0 / $$ replacement syntax. */
export function goRegexReplaceAll(pattern: string, input: string, replacement: string): string {
  // "$$" means a literal "$" in both Go and JS replacement strings, so convert the pieces between them.
  const jsReplacement = replacement
    .split("$$")
    .map((piece) =>
      piece.replace(/\$\{(\w+)\}|\$(\w+)/g, (_match, braced: string | undefined, bare: string | undefined) => {
        const name = braced ?? bare ?? "";
        if (name === "0") return "$&";
        return /^\d+$/.test(name) ? `$${name}` : `$<${name}>`;
      }),
    )
    .join("$$");
  return input.replace(goRegExp(pattern, true), jsReplacement);
}

/** strings.Title: upper-cases the first letter of every word. */
export function goTitle(value: string): string {
  return value.replace(/(^|[^\p{L}\p{N}_])(\p{L})/gu, (_match, separator: string, letter: string) => separator + letter.toUpperCase());
}

/** strconv.Quote (close enough: JSON string escaping). */
export function goQuote(value: string): string {
  return JSON.stringify(value);
}

/** Go zero value (raymond's !IsTrue): nil, "", 0, false, empty array or object. */
export function isGoZero(value: unknown): boolean {
  if (value === undefined || value === null || value === false || value === "") return true;
  if (typeof value === "number") return value === 0 || Number.isNaN(value);
  if (Array.isArray(value)) return value.length === 0;
  if (value instanceof Date) return false;
  if (typeof value === "object") return Object.keys(value).length === 0;
  return false;
}

/** How raymond renders a value: nil → "", everything else via its string form. */
export function goString(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

interface TimeFields {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  ms: number;
  weekday: string;
  offsetMinutes: number;
  zoneName: string;
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function timeFields(date: Date, timeZone?: string): TimeFields {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      weekday: "long",
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  const second = Number(parts.second);
  const ms = date.getUTCMilliseconds();
  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute, second, ms);
  const zoneName =
    new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" })
      .formatToParts(date)
      .find((part) => part.type === "timeZoneName")?.value ?? "UTC";
  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    ms,
    weekday: String(parts.weekday),
    offsetMinutes: Math.round((wallAsUtc - date.getTime()) / 60000),
    zoneName,
  };
}

type Chunk = (fields: TimeFields) => string;

const pad = (value: number, width: number) => String(value).padStart(width, "0");
const hour12 = (fields: TimeFields) => fields.hour % 12 || 12;

function zone(options: { z: boolean; colon: boolean; minutes: boolean; seconds: boolean }): Chunk {
  return (fields) => {
    if (options.z && fields.offsetMinutes === 0) return "Z";
    const sign = fields.offsetMinutes < 0 ? "-" : "+";
    const abs = Math.abs(fields.offsetMinutes);
    const separator = options.colon ? ":" : "";
    let out = sign + pad(Math.floor(abs / 60), 2);
    if (options.minutes) out += separator + pad(abs % 60, 2);
    if (options.seconds) out += separator + "00";
    return out;
  };
}

// Order matters: at each position the first matching token wins (longer tokens first), as in Go's nextStdChunk.
const STD_CHUNKS: Array<[string, Chunk]> = [
  ["January", (f) => MONTHS[f.month - 1]!],
  ["Jan", (f) => MONTHS[f.month - 1]!.slice(0, 3)],
  ["Monday", (f) => f.weekday],
  ["Mon", (f) => f.weekday.slice(0, 3)],
  ["MST", (f) => f.zoneName],
  ["2006", (f) => pad(f.year, 4)],
  ["_2006", (f) => "_" + pad(f.year, 4)],
  ["_2", (f) => String(f.day).padStart(2, " ")],
  ["01", (f) => pad(f.month, 2)],
  ["02", (f) => pad(f.day, 2)],
  ["03", (f) => pad(hour12(f), 2)],
  ["04", (f) => pad(f.minute, 2)],
  ["05", (f) => pad(f.second, 2)],
  ["06", (f) => pad(f.year % 100, 2)],
  ["15", (f) => pad(f.hour, 2)],
  ["1", (f) => String(f.month)],
  ["2", (f) => String(f.day)],
  ["3", (f) => String(hour12(f))],
  ["4", (f) => String(f.minute)],
  ["5", (f) => String(f.second)],
  ["PM", (f) => (f.hour >= 12 ? "PM" : "AM")],
  ["pm", (f) => (f.hour >= 12 ? "pm" : "am")],
  ["-07:00:00", zone({ z: false, colon: true, minutes: true, seconds: true })],
  ["-070000", zone({ z: false, colon: false, minutes: true, seconds: true })],
  ["-07:00", zone({ z: false, colon: true, minutes: true, seconds: false })],
  ["-0700", zone({ z: false, colon: false, minutes: true, seconds: false })],
  ["-07", zone({ z: false, colon: false, minutes: false, seconds: false })],
  ["Z07:00:00", zone({ z: true, colon: true, minutes: true, seconds: true })],
  ["Z070000", zone({ z: true, colon: false, minutes: true, seconds: true })],
  ["Z07:00", zone({ z: true, colon: true, minutes: true, seconds: false })],
  ["Z0700", zone({ z: true, colon: false, minutes: true, seconds: false })],
  ["Z07", zone({ z: true, colon: false, minutes: false, seconds: false })],
];

const FRACTION = /^([.,])(0+|9+)(?![0-9])/;

/** time.Time.Format with a Go reference layout; timeZone is an IANA name, undefined = process local zone. */
export function goFormatTime(date: Date, layout: string, timeZone?: string): string {
  const fields = timeFields(date, timeZone);
  let out = "";
  let i = 0;
  scan: while (i < layout.length) {
    const rest = layout.slice(i);
    const fraction = FRACTION.exec(rest);
    if (fraction) {
      const [whole, separator, run] = fraction as unknown as [string, string, string];
      const digits = String(fields.ms).padStart(3, "0").padEnd(run.length, "0").slice(0, run.length);
      if (run[0] === "0") out += separator + digits;
      else if (digits.replace(/0+$/, "") !== "") out += separator + digits.replace(/0+$/, "");
      i += whole.length;
      continue;
    }
    for (const [token, chunk] of STD_CHUNKS) {
      if (rest.startsWith(token)) {
        out += chunk(fields);
        i += token.length;
        continue scan;
      }
    }
    out += layout[i];
    i++;
  }
  return out;
}
