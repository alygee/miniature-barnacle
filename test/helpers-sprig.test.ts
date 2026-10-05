import Handlebars from "handlebars";
import { describe, expect, it } from "vitest";
import { goFormatTime } from "../src/helpers/golang.js";
import { registerSprigHelpers } from "../src/helpers/sprig.js";

const NOW = new Date(1700000100 * 1000); // 2023-11-14T22:15:00Z
const hb = Handlebars.create();
registerSprigHelpers(hb, { now: () => NOW, env: { HOME: "/root", USER: "ci" } });
// Triple-stash disables HTML escaping so assertions see raw helper output.
const render = (template: string, context: object = {}) => hb.compile(template)(context);

describe("math", () => {
  it("renders the build duration from the reference .drone.yml", () => {
    const tpl =
      "{{ div (sub build.finished build.started) 60 }} минут {{ mod (sub build.finished build.started) 60 }} секунд";
    expect(render(tpl, { build: { finished: 1215, started: 1000 } })).toBe("3 минут 35 секунд");
  });
  it.each([
    ["{{div -7 2}}", "-3"],
    ["{{mod -7 2}}", "-1"],
    ['{{div 7 "2"}}', "3"],
    ["{{div 7.9 2}}", "3"],
    ["{{add 1 2 3}}", "6"],
    ["{{add1 41}}", "42"],
    ["{{mul 2 3 4}}", "24"],
    ["{{max 1 5 3}}", "5"],
    ["{{min 4 2 8}}", "2"],
    ["{{floor 1.7}}", "1"],
    ["{{ceil 1.2}}", "2"],
    ["{{round 3.14159 2}}", "3.14"],
    ["{{round 2.5 0}}", "3"],
  ])("%s = %s", (tpl, expected) => {
    expect(render(tpl)).toBe(expected);
  });
  it("throws on integer division by zero", () => {
    expect(() => render("{{div 1 0}}")).toThrow("div: integer divide by zero");
    expect(() => render("{{mod 1 0}}")).toThrow("mod: integer divide by zero");
  });
});

describe("strings", () => {
  it.each([
    ["{{trim s}}", { s: "  a b  " }, "a b"],
    ['{{trimAll "$" "$5.00$"}}', {}, "5.00"],
    ['{{trimPrefix "v" "v1.2"}}', {}, "1.2"],
    ['{{trimSuffix ".git" "repo.git"}}', {}, "repo"],
    ['{{upper "ab"}}|{{lower "AB"}}|{{title "hello world"}}', {}, "AB|ab|Hello World"],
    ['{{replace " " "-" "a b c"}}', {}, "a-b-c"],
    ['{{contains "cat" "catch"}}|{{hasPrefix "ca" "cat"}}|{{hasSuffix "x" "cat"}}', {}, "true|true|false"],
    ['{{trunc 5 "hello world"}}|{{trunc -5 "hello world"}}|{{trunc 3 "Привет"}}', {}, "hello|world|При"],
    ['{{abbrev 5 "hello world"}}|{{abbrev 3 "hello"}}', {}, "he...|hello"],
    ['{{substr 0 5 "hello world"}}|{{substr 6 99 "hello world"}}', {}, "hello|world"],
    ['{{repeat 3 "ab"}}', {}, "ababab"],
    ['{{{quote "a" "b"}}}|{{{squote "a" "b"}}}', {}, "\"a\" \"b\"|'a' 'b'"],
    ["{{nospace s}}", { s: "a b\tc" }, "abc"],
    ["{{indent 2 s}}|{{nindent 2 s}}", { s: "a\nb" }, "  a\n  b|\n  a\n  b"],
    ['{{plural "file" "files" 1}}|{{plural "file" "files" 2}}', {}, "file|files"],
    ['{{cat "a" 1 true}}|{{toString 5}}|{{atoi "42"}}|{{int "7"}}|{{int64 "x"}}', {}, "a 1 true|5|42|7|0"],
  ])("%s", (tpl, context, expected) => {
    expect(render(tpl, context)).toBe(expected);
  });
});

describe("defaults", () => {
  it.each([
    ['{{default "none" tag}}', { tag: "" }, "none"],
    ['{{default "none" tag}}', { tag: "v1" }, "v1"],
    ["{{empty tag}}|{{empty n}}", { tag: "", n: 3 }, "true|false"],
    ['{{coalesce a b "x"}}', { a: "", b: 0 }, "x"],
    ['{{ternary "yes" "no" flag}}', { flag: true }, "yes"],
    ['{{ternary "yes" "no" flag}}', { flag: false }, "no"],
  ])("%s with %j", (tpl, context, expected) => {
    expect(render(tpl, context)).toBe(expected);
  });
});

describe("dates", () => {
  it("date formats unix seconds in the local zone", () => {
    expect(render('{{date "2006-01-02 15:04" 1700000000}}')).toBe(goFormatTime(new Date(1700000000 * 1000), "2006-01-02 15:04"));
  });
  it("dateInZone uses the zone and falls back to UTC", () => {
    expect(render('{{dateInZone "2006-01-02 15:04" 1700000000 "Europe/Moscow"}}')).toBe("2023-11-15 01:13");
    expect(render('{{dateInZone "2006-01-02 15:04" 1700000000 "Mars/Base"}}')).toBe("2023-11-14 22:13");
  });
  it("now, unixEpoch and ago", () => {
    expect(render('{{dateInZone "15:04" (now) "UTC"}}|{{unixEpoch (now)}}|{{ago 1700000000}}')).toBe("22:15|1700000100|1m40s");
  });
});

describe("regex and other", () => {
  it.each([
    ['{{regexMatch "^v[0-9]+" "v12"}}', "true"],
    ['{{regexFind "[0-9]+" "build 42 ok"}}', "42"],
    ['{{regexReplaceAll "[0-9]+" "a1b22" "#"}}', "a#b#"],
    ['{{b64enc "hi"}}|{{b64dec "aGk="}}', "aGk&#x3D;|hi"],
    ['{{env "USER"}}|{{env "NOPE"}}', "ci|"],
    ['{{expandenv "$USER at ${HOME}"}}', "ci at /root"],
  ])("%s", (tpl, expected) => {
    expect(render(tpl)).toBe(expected);
  });
  it("leaves unsupported sprig helpers undefined", () => {
    expect(() => render("{{semver 1}}")).toThrow('Missing helper: "semver"');
  });
});
