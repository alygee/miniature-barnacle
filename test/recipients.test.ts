import { describe, expect, it, vi } from "vitest";
import { parseTo } from "../src/recipients.js";

// Cases from drone-telegram plugin_test.go TestParseTo
const input = ["0", "1:1@gmail.com", "2:2@gmail.com", "3:3@gmail.com", "4", "5"];

describe("parseTo", () => {
  it("appends email-matched ids after plain ids", () => {
    expect(parseTo(input, "1@gmail.com", false)).toEqual(["0", "4", "5", "1"]);
  });
  it("sends only to matched ids when only_match_email is set", () => {
    expect(parseTo(input, "1@gmail.com", true)).toEqual(["1"]);
  });
  it("falls back to plain ids when no email matches", () => {
    expect(parseTo(input, "a@gmail.com", false)).toEqual(["0", "4", "5"]);
    expect(parseTo(input, "a@gmail.com", true)).toEqual(["0", "4", "5"]);
  });
  it("returns [] for blank input", () => {
    expect(parseTo(["", " ", "   "], "a@gmail.com", true)).toEqual([]);
  });
  it("accepts @username, also with an email filter", () => {
    expect(parseTo(["@ci_bot_chat", "@ci_team:1@gmail.com"], "1@gmail.com", false)).toEqual(["@ci_bot_chat", "@ci_team"]);
    expect(parseTo(["@ci_bot_chat", "@ci_team:1@gmail.com"], "1@gmail.com", true)).toEqual(["@ci_team"]);
  });
  it("normalizes numeric ids and keeps negative chat ids", () => {
    expect(parseTo(["+5", "-1001234567890", "-42"], "", false)).toEqual(["5", "-1001234567890", "-42"]);
  });
  it("skips invalid recipients with a warning", () => {
    const warn = vi.fn();
    expect(parseTo(["中文ID", "abc", "@ab", ":", "12"], "", false, warn)).toEqual(["12"]);
    expect(warn).toHaveBeenCalledTimes(4);
    expect(warn).toHaveBeenCalledWith('skipping recipient "中文ID": not a numeric id or @username');
  });
});
