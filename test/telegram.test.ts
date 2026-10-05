import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createDeadline, toPeer, waitForPort } from "../src/telegram.js";

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as { port: number };
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

describe("toPeer", () => {
  it("keeps usernames and converts numeric ids", () => {
    expect(toPeer("@ci_team")).toBe("@ci_team");
    expect(toPeer("-1001234567890")).toBe(-1001234567890);
    expect(toPeer("42")).toBe(42);
  });
  it("rejects ids beyond Number.MAX_SAFE_INTEGER", () => {
    expect(() => toPeer("99999999999999999999")).toThrow("recipient id 99999999999999999999 is out of range");
  });
});

describe("createDeadline", () => {
  it("counts down from the timeout and stops at 0", () => {
    let now = 1000;
    const deadline = createDeadline(5, () => now);
    expect(deadline.remainingMs()).toBe(5000);
    now = 4000;
    expect(deadline.remainingMs()).toBe(2000);
    now = 9000;
    expect(deadline.remainingMs()).toBe(0);
  });
});

describe("waitForPort", () => {
  let server: Server | undefined;
  afterEach(() => {
    server?.close();
    server = undefined;
  });

  it("resolves when the port accepts connections", async () => {
    server = createServer((socket) => socket.destroy());
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    await expect(waitForPort("127.0.0.1", port, createDeadline(5))).resolves.toBeUndefined();
  });

  it("retries until the port opens", async () => {
    const port = await freePort();
    setTimeout(() => {
      server = createServer((socket) => socket.destroy());
      server.listen(port, "127.0.0.1");
    }, 1500);
    await expect(waitForPort("127.0.0.1", port, createDeadline(5))).resolves.toBeUndefined();
  });

  it("fails with a clear message after the deadline", async () => {
    const port = await freePort();
    await expect(waitForPort("127.0.0.1", port, createDeadline(1))).rejects.toThrow(
      `proxy 127.0.0.1:${port} is not reachable after 1s`,
    );
  });
});
