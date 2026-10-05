import { errors } from "teleproto";
import { describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.js";
import type { FormattedMessage } from "../src/format.js";
import { describeError, type MainDeps, run } from "../src/main.js";
import type { SendOptions, TelegramGateway } from "../src/telegram.js";

const HEX = "0123456789abcdef0123456789abcdef";
const baseEnv = {
  PLUGIN_TOKEN: "123:SECRET",
  PLUGIN_TO: "1,@teamx",
  PLUGIN_API_ID: "1",
  PLUGIN_API_HASH: "hash0123",
  PLUGIN_MESSAGE: "*hi* {{build.number}}",
  DRONE_BUILD_NUMBER: "42",
};

function fakeGateway(sendText?: TelegramGateway["sendText"]) {
  const sent: Array<{ peer: string; text: string; options: SendOptions }> = [];
  const gateway = {
    sendText: vi.fn(
      sendText ??
        (async (peer: string, message: FormattedMessage, options: SendOptions) => {
          sent.push({ peer, text: message.text, options });
          return sent.length;
        }),
    ),
    exportSession: () => "1SESSION",
    close: vi.fn(async () => {}),
  };
  return { gateway, sent };
}

function setup(env: Record<string, string>, gateway: TelegramGateway | Promise<never>) {
  const out: string[] = [];
  const err: string[] = [];
  const deps: MainDeps = {
    env,
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    connect: vi.fn(async (_config: Config) => gateway),
    waitForPort: vi.fn(async () => {}),
    renderDeps: {
      env,
      now: () => new Date(0),
      readText: async () => {
        throw new Error("no files in tests");
      },
      fetchText: async () => {
        throw new Error("no network in tests");
      },
    },
  };
  return { deps, out, err };
}

describe("run (send)", () => {
  it("renders, formats and sends to every recipient", async () => {
    const { gateway, sent } = fakeGateway();
    const { deps, out, err } = setup(baseEnv, gateway);
    expect(await run([], deps)).toBe(0);
    expect(sent).toEqual([
      { peer: "1", text: "hi 42", options: { linkPreview: true, silent: false, threadId: undefined } },
      { peer: "@teamx", text: "hi 42", options: { linkPreview: true, silent: false, threadId: undefined } },
    ]);
    expect(out).toEqual(["sent to 1 (message id 1)", "sent to @teamx (message id 2)"]);
    expect(err).toEqual([]);
    expect(deps.waitForPort).not.toHaveBeenCalled();
    expect(gateway.close).toHaveBeenCalledOnce();
  });

  it("waits for the proxy service when configured", async () => {
    const { gateway } = fakeGateway();
    const { deps } = setup({ ...baseEnv, PLUGIN_PROXY_HOST: "tg-ws-proxy", PLUGIN_PROXY_SECRET: HEX }, gateway);
    expect(await run([], deps)).toBe(0);
    expect(deps.waitForPort).toHaveBeenCalledWith("tg-ws-proxy", 1443, expect.objectContaining({ timeoutSec: 60 }));
  });

  it("passes thread, preview and notification options", async () => {
    const { gateway, sent } = fakeGateway();
    const { deps } = setup(
      {
        ...baseEnv,
        PLUGIN_TO: "1",
        PLUGIN_MESSAGE_THREAD_ID: "17",
        PLUGIN_DISABLE_WEB_PAGE_PREVIEW: "true",
        PLUGIN_DISABLE_NOTIFICATION: "true",
      },
      gateway,
    );
    expect(await run([], deps)).toBe(0);
    expect(sent[0]?.options).toEqual({ linkPreview: false, silent: true, threadId: 17 });
  });

  it("keeps sending after a failed recipient, exits 1 and redacts secrets", async () => {
    const { gateway } = fakeGateway(async (peer) => {
      if (peer === "1") throw new Error("bot 123:SECRET rejected");
      return 7;
    });
    const { deps, out, err } = setup(baseEnv, gateway);
    expect(await run([], deps)).toBe(1);
    expect(err).toEqual(["failed to send to 1: bot <redacted> rejected"]);
    expect(out).toEqual(["sent to @teamx (message id 7)"]);
    expect(gateway.close).toHaveBeenCalledOnce();
  });

  it("fails on config errors before connecting", async () => {
    const { gateway } = fakeGateway();
    const { deps, err } = setup({ ...baseEnv, PLUGIN_TOKEN: " " }, gateway);
    expect(await run([], deps)).toBe(1);
    expect(err).toEqual(["error: missing required settings: token"]);
    expect(deps.connect).not.toHaveBeenCalled();
  });

  it("skips sending when the message renders empty", async () => {
    const { gateway } = fakeGateway();
    const { deps, out } = setup({ ...baseEnv, PLUGIN_MESSAGE: "{{tpl.none}}" }, gateway);
    expect(await run([], deps)).toBe(0);
    expect(out).toEqual(["warning: message is empty, nothing to send"]);
    expect(deps.connect).not.toHaveBeenCalled();
  });

  it("skips sending when no recipient is left", async () => {
    const { gateway } = fakeGateway();
    const { deps, out } = setup({ ...baseEnv, PLUGIN_TO: "1:someone@example.com" }, gateway);
    expect(await run([], deps)).toBe(0);
    expect(out).toEqual(["warning: no recipients left after filtering, nothing to send"]);
    expect(deps.connect).not.toHaveBeenCalled();
  });

  it("times out with the current stage", async () => {
    const { deps, err } = setup({ ...baseEnv, PLUGIN_TIMEOUT: "1" }, new Promise<never>(() => {}));
    deps.connect = vi.fn(() => new Promise<never>(() => {}));
    expect(await run([], deps)).toBe(1);
    expect(err).toEqual(["error: timed out after 1s during login"]);
  });

  it("closes a gateway that connects after the deadline", async () => {
    const { gateway } = fakeGateway();
    const { deps, err } = setup({ ...baseEnv, PLUGIN_TIMEOUT: "1" }, gateway);
    let release!: () => void;
    deps.connect = vi.fn(() => new Promise<TelegramGateway>((resolve) => (release = () => resolve(gateway))));
    expect(await run([], deps)).toBe(1);
    expect(err).toEqual(["error: timed out after 1s during login"]);
    release();
    await new Promise((r) => setTimeout(r, 0));
    expect(gateway.close).toHaveBeenCalled();
  });
});

describe("run (session)", () => {
  it("prints the session string without requiring recipients", async () => {
    const { gateway } = fakeGateway();
    const { PLUGIN_TO: _omit, ...env } = baseEnv;
    const { deps, out } = setup(env, gateway);
    expect(await run(["session"], deps)).toBe(0);
    expect(out).toEqual(["1SESSION"]);
  });

  it("rejects unknown commands", async () => {
    const { gateway } = fakeGateway();
    const { deps, err } = setup(baseEnv, gateway);
    expect(await run(["foo"], deps)).toBe(1);
    expect(err).toEqual(['error: unknown command "foo", expected "session" or no command']);
  });
});

describe("describeError", () => {
  it("explains FLOOD_WAIT", () => {
    const flood = Object.assign(Object.create(errors.FloodWaitError.prototype), { seconds: 120 });
    expect(describeError(flood)).toContain("FLOOD_WAIT of 120s");
    const roomy = { timeoutSec: 600, remainingMs: () => 600_000 };
    expect(describeError(flood, roomy)).toBe("Telegram FLOOD_WAIT of 120s");
    const tight = { timeoutSec: 10, remainingMs: () => 10_000 };
    expect(describeError(flood, tight)).toContain('"session"');
  });
  it("uses the message of other errors", () => {
    expect(describeError(new Error("boom"))).toBe("boom");
    expect(describeError("text")).toBe("text");
  });
});
