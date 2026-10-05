import type { Api } from "teleproto";
import { describe, expect, it } from "vitest";
import { formatMessage } from "../src/format.js";

const shape = (entities: Api.TypeMessageEntity[]) => entities.map((e) => [e.className, e.offset, e.length]);

describe("formatMessage", () => {
  it("converts legacy markdown into Api entities", () => {
    const message = formatMessage("*b* _i_ `c` ```go\nx``` [l](http://a.io)", "markdown");
    expect(message.text).toBe("b i c x l");
    expect(shape(message.entities)).toEqual([
      ["MessageEntityBold", 0, 1],
      ["MessageEntityItalic", 2, 1],
      ["MessageEntityCode", 4, 1],
      ["MessageEntityPre", 6, 1],
      ["MessageEntityTextUrl", 8, 1],
    ]);
    expect((message.entities[3] as Api.MessageEntityPre).language).toBe("go");
    expect((message.entities[4] as Api.MessageEntityTextUrl).url).toBe("http://a.io/");
  });

  it("uses teleproto's HTML parser for html", () => {
    const message = formatMessage("<b>hi</b> &amp; <a href='http://a'>x</a>", "html");
    expect(message.text).toBe("hi & x");
    expect(shape(message.entities)).toEqual([
      ["MessageEntityBold", 0, 2],
      ["MessageEntityTextUrl", 5, 1],
    ]);
  });

  it("rejects messages over 4096 UTF-16 units", () => {
    expect(formatMessage("a".repeat(4096), "markdown").text).toHaveLength(4096);
    expect(() => formatMessage("a".repeat(4097), "markdown")).toThrow("message too long (4097 > 4096)");
  });
});
