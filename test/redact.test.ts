import { describe, expect, it } from "vitest";
import { makeRedactor } from "../src/redact.js";

describe("makeRedactor", () => {
  it("replaces every occurrence of every secret", () => {
    const redact = makeRedactor(["123:SECRET", "hash0123", undefined]);
    expect(redact("bot 123:SECRET failed, hash0123 / 123:SECRET")).toBe("bot <redacted> failed, <redacted> / <redacted>");
  });
  it("replaces longer secrets first", () => {
    const redact = makeRedactor(["abcd", "abcd1234"]);
    expect(redact("x abcd1234 y abcd")).toBe("x <redacted> y <redacted>");
  });
  it("ignores empty and too-short values", () => {
    const redact = makeRedactor(["", "ab", "  "]);
    expect(redact("ab cd")).toBe("ab cd");
  });
});
