import { describe, expect, it } from "vitest";
import { checkLink, type MdEntity, parseLegacyMarkdown } from "../src/markdown.js";

const cases: Array<[string, string, MdEntity[]]> = [
  // tdlib behaviour
  ["plain text", "plain text", []],
  ["", "", []],
  ["*bold*", "bold", [{ type: "bold", offset: 0, length: 4 }]],
  ["a _it_ b", "a it b", [{ type: "italic", offset: 2, length: 2 }]],
  ["`x`", "x", [{ type: "code", offset: 0, length: 1 }]],
  ["\\_\\*\\`\\[", "_*`[", []],
  ["\\a \\\\", "\\a \\\\", []],
  ["```js\nconst a\n```", "const a\n", [{ type: "pre", offset: 0, length: 8, language: "js" }]],
  ["```\nabc```", "abc", [{ type: "pre", offset: 0, length: 3, language: "" }]],
  ["``` update travis ```", " update travis ", [{ type: "pre", offset: 0, length: 15, language: "" }]],
  ["[text](http://example.com)", "text", [{ type: "text_url", offset: 0, length: 4, url: "http://example.com/" }]],
  ["[telegram.org]", "telegram.org", [{ type: "text_url", offset: 0, length: 12, url: "http://telegram.org/" }]],
  ["[telegram.org]a", "telegram.orga", [{ type: "text_url", offset: 0, length: 12, url: "http://telegram.org/" }]],
  ["[ ](telegram.org)", " ", [{ type: "text_url", offset: 0, length: 1, url: "http://telegram.org/" }]],
  ["[ ](as)", " ", []],
  ["[](telegram.org)", "", []],
  ["[x](https://telegram.dog?)", "x", [{ type: "text_url", offset: 0, length: 1, url: "https://telegram.dog/?" }]],
  ["**", "", []],
  ["*a\\*b*", "a\\b*", [{ type: "bold", offset: 0, length: 2 }]],
  ["[a](http://x.org", "a", [{ type: "text_url", offset: 0, length: 1, url: "http://x.org/" }]],
  ["_a_ *b* `c`", "a b c", [
    { type: "italic", offset: 0, length: 1 },
    { type: "bold", offset: 2, length: 1 },
    { type: "code", offset: 4, length: 1 },
  ]],
  // UTF-16 offsets
  ["🏟 *🏟*", "🏟 🏟", [{ type: "bold", offset: 3, length: 2 }]],
  ["Сборка *ok*", "Сборка ok", [{ type: "bold", offset: 7, length: 2 }]],
  // deviation 1: \_ is "_" inside entities and URLs
  ["[fix\\_login](https://x.org/a\\_b)", "fix_login", [{ type: "text_url", offset: 0, length: 9, url: "https://x.org/a_b" }]],
  ["``` fix\\_login ```", " fix_login ", [{ type: "pre", offset: 0, length: 11, language: "" }]],
  ["*snake\\_case*", "snake_case", [{ type: "bold", offset: 0, length: 10 }]],
  ["`a\\_b`", "a_b", [{ type: "code", offset: 0, length: 3 }]],
  // deviation 2: unclosed entities stay as text
  ["2*3", "2*3", []],
  ["```abc", "```abc", []],
  ["```js\ncode", "```js\ncode", []],
  ["[abc", "[abc", []],
  ["a_b *c*", "a_b c", [{ type: "bold", offset: 4, length: 1 }]],
];

describe("parseLegacyMarkdown", () => {
  it.each(cases)("%j", (source, text, entities) => {
    expect(parseLegacyMarkdown(source)).toEqual({ text, entities });
  });
});

describe("checkLink", () => {
  it.each([
    ["telegram.org", "http://telegram.org/"],
    ["localhost:8080", "http://localhost:8080/"],
    ["mailto:a@b.io", "mailto:a@b.io"],
    ["tg://resolve?domain=x", "tg://resolve?domain=x"],
    ["javascript:alert(1)", undefined],
    ["as", undefined],
    ["", undefined],
  ])("%s → %s", (input, expected) => {
    expect(checkLink(input)).toBe(expected);
  });
});
