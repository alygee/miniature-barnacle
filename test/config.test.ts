import { describe, expect, it } from "vitest";
import { loadConfig, validateProxySecret } from "../src/config.js";
import { ConfigError } from "../src/env.js";

const HEX = "0123456789abcdef0123456789abcdef";
const base = { PLUGIN_TOKEN: "123:abc", PLUGIN_TO: "1, 2", PLUGIN_API_ID: "12345", PLUGIN_API_HASH: "hash0123" };

describe("loadConfig", () => {
  it("applies defaults", () => {
    expect(loadConfig(base)).toEqual({
      token: "123:abc",
      to: ["1", "2"],
      message: undefined,
      messageFile: undefined,
      templateVars: undefined,
      templateVarsFile: undefined,
      format: "markdown",
      messageThreadId: undefined,
      disableWebPagePreview: false,
      disableNotification: false,
      onlyMatchEmail: false,
      debug: false,
      apiId: 12345,
      apiHash: "hash0123",
      proxy: undefined,
      session: undefined,
      timeoutSec: 60,
    });
  });

  it("lists every missing required setting at once", () => {
    expect(() => loadConfig({})).toThrow("missing required settings: token, to, api_id, api_hash");
  });

  it("does not require `to` in session mode", () => {
    const { PLUGIN_TO: _omit, ...rest } = base;
    expect(loadConfig(rest, "session").to).toEqual([]);
  });

  it("reads TELEGRAM_ and INPUT_ aliases", () => {
    const cfg = loadConfig({ TELEGRAM_TOKEN: "t:1", INPUT_TO: "5", INPUT_API_ID: "7", TELEGRAM_API_HASH: "hhhh" });
    expect([cfg.token, cfg.to, cfg.apiId, cfg.apiHash]).toEqual(["t:1", ["5"], 7, "hhhh"]);
  });

  it("reads message settings", () => {
    const cfg = loadConfig({
      ...base,
      PLUGIN_MESSAGE: "  hi  ",
      PLUGIN_MESSAGE_FILE: " msg.tpl ",
      PLUGIN_TEMPLATE_VARS: '{"a":"b"}',
      PLUGIN_TEMPLATE_VARS_FILE: "vars.json",
      PLUGIN_MESSAGE_THREAD_ID: "17",
      PLUGIN_DISABLE_WEB_PAGE_PREVIEW: "true",
      PLUGIN_DISABLE_NOTIFICATION: "1",
      PLUGIN_DEBUG: "T",
      PLUGIN_SESSION: " 1AbC ",
      PLUGIN_TIMEOUT: "30",
    });
    expect(cfg).toMatchObject({
      message: "  hi  ",
      messageFile: "msg.tpl",
      templateVars: '{"a":"b"}',
      templateVarsFile: "vars.json",
      messageThreadId: 17,
      disableWebPagePreview: true,
      disableNotification: true,
      debug: true,
      session: "1AbC",
      timeoutSec: 30,
    });
  });

  it.each([
    ["HTML", "html"],
    ["html", "html"],
    ["Markdown", "markdown"],
    ["MARKDOWN", "markdown"],
  ])("accepts format %s", (value, expected) => {
    expect(loadConfig({ ...base, PLUGIN_FORMAT: value }).format).toBe(expected);
  });

  it("rejects MarkdownV2 and unknown formats", () => {
    expect(() => loadConfig({ ...base, PLUGIN_FORMAT: "MarkdownV2" })).toThrow('format "MarkdownV2" is not supported');
    expect(() => loadConfig({ ...base, PLUGIN_FORMAT: "bbcode" })).toThrow('invalid format "bbcode"');
  });

  it.each(["PHOTO", "DOCUMENT", "STICKER", "AUDIO", "VOICE", "VIDEO", "LOCATION", "VENUE", "SOCKS5"])(
    "rejects unsupported PLUGIN_%s",
    (name) => {
      expect(() => loadConfig({ ...base, [`PLUGIN_${name}`]: "x" })).toThrow(`PLUGIN_${name} is not supported`);
    },
  );

  it("reads only_match_email only from PLUGIN_/INPUT_", () => {
    expect(loadConfig({ ...base, TELEGRAM_ONLY_MATCH_EMAIL: "true" }).onlyMatchEmail).toBe(false);
    expect(loadConfig({ ...base, INPUT_ONLY_MATCH_EMAIL: "true" }).onlyMatchEmail).toBe(true);
  });

  it("builds proxy settings", () => {
    expect(loadConfig({ ...base, PLUGIN_PROXY_HOST: " tg-ws-proxy ", PLUGIN_PROXY_SECRET: HEX }).proxy).toEqual({
      host: "tg-ws-proxy",
      port: 1443,
      secret: HEX,
    });
    expect(loadConfig({ ...base, PLUGIN_PROXY_HOST: "p", PLUGIN_PROXY_SECRET: HEX, PLUGIN_PROXY_PORT: "443" }).proxy?.port).toBe(443);
  });

  it("ignores proxy_secret without proxy_host", () => {
    expect(loadConfig({ ...base, PLUGIN_PROXY_SECRET: HEX }).proxy).toBeUndefined();
  });

  it("validates proxy settings", () => {
    expect(() => loadConfig({ ...base, PLUGIN_PROXY_HOST: "p" })).toThrow("proxy_secret is required when proxy_host is set");
    expect(() => loadConfig({ ...base, PLUGIN_PROXY_HOST: "p", PLUGIN_PROXY_SECRET: "abc" })).toThrow("PLUGIN_PROXY_SECRET: must be");
    expect(() => loadConfig({ ...base, PLUGIN_PROXY_HOST: "p", PLUGIN_PROXY_SECRET: HEX, PLUGIN_PROXY_PORT: "0" })).toThrow(
      "PLUGIN_PROXY_PORT: port must be 1..65535",
    );
  });

  it("validates numbers", () => {
    expect(() => loadConfig({ ...base, PLUGIN_API_ID: "abc" })).toThrow('PLUGIN_API_ID: invalid integer "abc"');
    expect(() => loadConfig({ ...base, PLUGIN_API_ID: "0" })).toThrow("PLUGIN_API_ID: must be a positive integer");
    expect(() => loadConfig({ ...base, PLUGIN_TIMEOUT: "0" })).toThrow("PLUGIN_TIMEOUT: must be a positive integer");
  });

  it("throws ConfigError", () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
  });
});

describe("validateProxySecret", () => {
  it.each([
    HEX,
    `dd${HEX}`,
    `ee${HEX}${Buffer.from("example.com").toString("hex")}`,
    Buffer.from(HEX, "hex").toString("base64"),
  ])("accepts %s", (secret) => {
    expect(() => validateProxySecret(secret)).not.toThrow();
  });

  it.each(["", "abc", `${HEX}0`, `ff${HEX}`, `dd${HEX}00`])("rejects %s", (secret) => {
    expect(() => validateProxySecret(secret)).toThrow(ConfigError);
  });
});
