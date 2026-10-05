import { describe, expect, it } from "vitest";
import { ConfigError, firstSet, paramKeys, parseBool, parseInteger, parseList } from "../src/env.js";

describe("paramKeys", () => {
  it("builds PLUGIN_/TELEGRAM_/INPUT_ keys in priority order", () => {
    expect(paramKeys("message_thread_id")).toEqual([
      "PLUGIN_MESSAGE_THREAD_ID",
      "TELEGRAM_MESSAGE_THREAD_ID",
      "INPUT_MESSAGE_THREAD_ID",
    ]);
  });
  it("accepts custom prefixes", () => {
    expect(paramKeys("only_match_email", ["PLUGIN_", "INPUT_"])).toEqual([
      "PLUGIN_ONLY_MATCH_EMAIL",
      "INPUT_ONLY_MATCH_EMAIL",
    ]);
  });
});

describe("firstSet", () => {
  it("returns the first non-blank value with its key", () => {
    const env = { PLUGIN_TO: "   ", TELEGRAM_TO: "1", INPUT_TO: "2" };
    expect(firstSet(env, paramKeys("to"))).toEqual({ key: "TELEGRAM_TO", value: "1" });
  });
  it("returns undefined when nothing is set", () => {
    expect(firstSet({ A: "" }, ["A", "B"])).toBeUndefined();
  });
});

describe("parseBool", () => {
  it.each(["1", "t", "T", "TRUE", "true", "True"])("parses %s as true", (v) => {
    expect(parseBool({ key: "K", value: v })).toBe(true);
  });
  it.each(["0", "f", "F", "FALSE", "false", "False"])("parses %s as false", (v) => {
    expect(parseBool({ key: "K", value: v }, true)).toBe(false);
  });
  it("uses the fallback when unset", () => {
    expect(parseBool(undefined)).toBe(false);
    expect(parseBool(undefined, true)).toBe(true);
  });
  it("rejects anything else with the key in the message", () => {
    expect(() => parseBool({ key: "PLUGIN_DEBUG", value: "yes" })).toThrow(ConfigError);
    expect(() => parseBool({ key: "PLUGIN_DEBUG", value: "yes" })).toThrow('PLUGIN_DEBUG: invalid boolean "yes"');
  });
});

describe("parseInteger", () => {
  it("parses integers with surrounding spaces", () => {
    expect(parseInteger({ key: "K", value: " -7 " })).toBe(-7);
    expect(parseInteger({ key: "K", value: "42" })).toBe(42);
  });
  it("returns undefined when unset", () => {
    expect(parseInteger(undefined)).toBeUndefined();
  });
  it("rejects non-integers", () => {
    expect(() => parseInteger({ key: "PLUGIN_TIMEOUT", value: "4.2" })).toThrow('PLUGIN_TIMEOUT: invalid integer "4.2"');
  });
});

describe("parseList", () => {
  it("splits on commas, trims and drops blanks", () => {
    expect(parseList({ key: "K", value: "1, 2,, 3 ,  " })).toEqual(["1", "2", "3"]);
  });
  it("returns [] when unset", () => {
    expect(parseList(undefined)).toEqual([]);
  });
});
