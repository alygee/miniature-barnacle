import { describe, expect, it } from "vitest";
import {
  goDuration,
  goFormatTime,
  goQueryEscape,
  goQuote,
  goRegExp,
  goRegexReplaceAll,
  goString,
  goTitle,
  isGoZero,
  isValidTimeZone,
  toFloat64,
  toInt64,
} from "../src/helpers/golang.js";

// 2023-11-14T22:13:20Z, a Tuesday; Europe/Moscow is UTC+3 all year (Wednesday 01:13:20).
const T = new Date(1700000000 * 1000);

describe("toInt64 / toFloat64", () => {
  it.each([
    [3.9, 3],
    [-3.9, -3],
    ["12", 12],
    [" 7 ", 7],
    ["1.5", 0],
    ["x", 0],
    [true, 1],
    [undefined, 0],
    [Number.NaN, 0],
  ])("toInt64(%s) = %s", (input, expected) => {
    expect(toInt64(input)).toBe(expected);
  });
  it.each([
    ["1.5", 1.5],
    ["x", 0],
    [2, 2],
    [false, 0],
  ])("toFloat64(%s) = %s", (input, expected) => {
    expect(toFloat64(input)).toBe(expected);
  });
});

describe("goDuration", () => {
  it.each([
    [0, "0s"],
    [45, "45s"],
    [125, "2m5s"],
    [3600, "1h0m0s"],
    [3725, "1h2m5s"],
    [-61, "-1m1s"],
    [12.9, "12s"],
  ])("goDuration(%s) = %s", (input, expected) => {
    expect(goDuration(input)).toBe(expected);
  });
});

describe("goQueryEscape", () => {
  it("matches url.QueryEscape", () => {
    expect(goQueryEscape("a b&c=d/é!*'()~_-.")).toBe("a+b%26c%3Dd%2F%C3%A9%21%2A%27%28%29~_-.");
  });
});

describe("regexp helpers", () => {
  it("turns a leading (?i) into a flag", () => {
    expect(goRegExp("(?i)abc").test("xABCx")).toBe(true);
  });
  it("converts Go replacement syntax", () => {
    expect(goRegexReplaceAll("(\\w+)@(\\w+)", "ivan@example", "$2:${1}")).toBe("example:ivan");
    expect(goRegexReplaceAll("a", "banana", "$$")).toBe("b$n$n$");
    expect(goRegexReplaceAll("a", "a a", "x y")).toBe("x y x y");
    expect(goRegexReplaceAll("(?P<user>\\w+)@", "ivan@x", "${user}!")).toBe("ivan!x");
    expect(goRegexReplaceAll("[0-9]+", "build 42", "#${0}")).toBe("build #42");
  });
});

describe("isGoZero / goString", () => {
  it.each([undefined, null, false, "", 0, Number.NaN, [], {}])("%s is a zero value", (value) => {
    expect(isGoZero(value)).toBe(true);
  });
  it.each([true, "x", 1, -1, [0], { a: 1 }, new Date(0)])("%s is not a zero value", (value) => {
    expect(isGoZero(value)).toBe(false);
  });
  it("renders nil as empty string", () => {
    expect([goString(undefined), goString(null), goString(42), goString(true)]).toEqual(["", "", "42", "true"]);
  });
});

describe("goTitle / goQuote", () => {
  it("title-cases words like strings.Title", () => {
    expect(goTitle("hello big_world o'neil")).toBe("Hello Big_world O'Neil");
  });
  it("quotes like strconv.Quote", () => {
    expect(goQuote('a "b"\n')).toBe('"a \\"b\\"\\n"');
  });
});

describe("goFormatTime", () => {
  it.each([
    ["2006-01-02 15:04:05", "UTC", "2023-11-14 22:13:20"],
    ["Jan _2 2006 3:04PM MST", "UTC", "Nov 14 2023 10:13PM UTC"],
    ["Monday, January 2", "Europe/Moscow", "Wednesday, November 15"],
    ["15:04 -07:00 Z07:00", "Europe/Moscow", "01:13 +03:00 +03:00"],
    ["Z07:00 -0700 -07", "UTC", "Z +0000 +00"],
    ["06 1 2 3 4 5 pm Mon", "UTC", "23 11 14 10 13 20 pm Tue"],
    ["Build 1.0", "UTC", "Build 11.0"],
  ])("formats %s in %s", (layout, zone, expected) => {
    expect(goFormatTime(T, layout, zone)).toBe(expected);
  });
  it("formats fractional seconds", () => {
    expect(goFormatTime(new Date(1700000000123), "05.000 05.999", "UTC")).toBe("20.123 20.123");
    expect(goFormatTime(new Date(1700000000000), "05.000 05.999", "UTC")).toBe("20.000 20");
  });
  it("pads _2 with a space", () => {
    expect(goFormatTime(new Date(Date.UTC(2023, 0, 5)), "_2", "UTC")).toBe(" 5");
  });
});

describe("isValidTimeZone", () => {
  it("accepts IANA names and rejects garbage", () => {
    expect(isValidTimeZone("Europe/Moscow")).toBe(true);
    expect(isValidTimeZone("Mars/Base")).toBe(false);
  });
});
