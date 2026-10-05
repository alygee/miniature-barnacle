import Handlebars from "handlebars";
import { describe, expect, it } from "vitest";
import { registerDroneHelpers } from "../src/helpers/drone.js";
import { goFormatTime } from "../src/helpers/golang.js";

const NOW = new Date(1700000100 * 1000);
const hb = Handlebars.create();
registerDroneHelpers(hb, () => NOW);
const render = (template: string, context: object = {}) => hb.compile(template)(context);

describe("success / failure", () => {
  const tpl = "{{#success build.status}}ok{{else}}bad{{/success}}|{{#failure build.status}}yes{{else}}no{{/failure}}";
  it.each([
    ["success", "ok|no"],
    ["failure", "bad|yes"],
    ["error", "bad|yes"],
    ["killed", "bad|yes"],
    ["", "bad|no"],
  ])("status %s", (status, expected) => {
    expect(render(tpl, { build: { status } })).toBe(expected);
  });
});

describe("truncate", () => {
  it.each([
    [3, "При"],
    [-2, "ивет"],
    [10, "Привет"],
  ])("truncate %s", (n, expected) => {
    expect(render("{{truncate s n}}", { s: "Привет", n })).toBe(expected);
  });
});

describe("time helpers", () => {
  it("duration formats like time.Duration", () => {
    expect(render("{{duration 1000 1215}}")).toBe("3m35s");
  });
  it("since counts from now", () => {
    expect(render("{{since 1700000000}}")).toBe("1m40s");
  });
  it("datetime uses the given IANA zone", () => {
    expect(render('{{datetime 1700000000 "2006-01-02 15:04" "Europe/Moscow"}}')).toBe("2023-11-15 01:13");
  });
  it("datetime falls back to the local zone for unknown or missing zones", () => {
    const local = goFormatTime(new Date(1700000000 * 1000), "2006-01-02 15:04");
    expect(render('{{datetime 1700000000 "2006-01-02 15:04" "Mars/Base"}}')).toBe(local);
    expect(render('{{datetime 1700000000 "2006-01-02 15:04"}}')).toBe(local);
  });
});

describe("string helpers", () => {
  it("urlencode is a block helper using QueryEscape", () => {
    expect(render("{{#urlencode}}a b&c{{/urlencode}}")).toBe("a+b%26c");
  });
  it("case helpers", () => {
    expect(render("{{uppercasefirst a}}|{{uppercasefirst b}}|{{uppercase a}}|{{lowercase c}}", { a: "ivan", b: "", c: "ABC" })).toBe(
      "Ivan||IVAN|abc",
    );
  });
  it("regexReplace takes (pattern, input, replacement)", () => {
    expect(render('{{regexReplace "[0-9]+" "build 42" "#${0}"}}')).toBe("build #42");
  });
});

describe("equal", () => {
  it("compares string forms", () => {
    const tpl = '{{#equal build.number "42"}}y{{else}}n{{/equal}}';
    expect(render(tpl, { build: { number: 42 } })).toBe("y");
    expect(render(tpl, { build: { number: 7 } })).toBe("n");
  });
});
