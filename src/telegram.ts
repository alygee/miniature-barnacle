import { lookup } from "node:dns/promises";
import { connect as netConnect } from "node:net";
import { Logger, sessions, TelegramClient } from "teleproto";
import { LogLevel } from "teleproto/extensions/Logger.js";
import type { Config } from "./config.js";
import type { FormattedMessage } from "./format.js";

export interface Deadline {
  readonly timeoutSec: number;
  remainingMs(): number;
}

export function createDeadline(timeoutSec: number, now: () => number = Date.now): Deadline {
  const end = now() + timeoutSec * 1000;
  return { timeoutSec, remainingMs: () => Math.max(0, end - now()) };
}

export interface SendOptions {
  linkPreview: boolean;
  silent: boolean;
  threadId?: number;
}

export interface TelegramGateway {
  /** Returns the id of the sent message. */
  sendText(peer: string, message: FormattedMessage, options: SendOptions): Promise<number>;
  exportSession(): string;
  close(): Promise<void>;
}

const RETRY_INTERVAL_MS = 1000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function canConnect(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = netConnect({ host, port });
    const finish = (ok: boolean) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

/** Pipeline services start in parallel with steps: poll host:port once a second until the deadline. */
export async function waitForPort(host: string, port: number, deadline: Deadline): Promise<void> {
  for (;;) {
    const attemptMs = Math.min(RETRY_INTERVAL_MS, deadline.remainingMs());
    if (attemptMs > 0 && (await canConnect(host, port, attemptMs))) return;
    if (deadline.remainingMs() <= 0) {
      throw new Error(`proxy ${host}:${port} is not reachable after ${deadline.timeoutSec}s`);
    }
    await sleep(Math.min(RETRY_INTERVAL_MS, deadline.remainingMs()));
  }
}

/** Numeric ids become numbers so teleproto resolves marked ids (-100…) with access_hash 0 for bots. */
export function toPeer(id: string): string | number {
  if (id.startsWith("@")) return id;
  const value = Number(id);
  if (!Number.isSafeInteger(value)) throw new Error(`recipient id ${id} is out of range`);
  return value;
}

export async function connectBot(config: Config, deadline: Deadline): Promise<TelegramGateway> {
  const proxy = config.proxy
    ? {
        ip: (await lookup(config.proxy.host)).address,
        port: config.proxy.port,
        secret: config.proxy.secret,
        MTProxy: true as const,
      }
    : undefined;
  const client = new TelegramClient(new sessions.StringSession(config.session ?? ""), config.apiId, config.apiHash, {
    proxy,
    connectionRetries: 3,
    autoReconnect: false,
    floodSleepThreshold: Math.min(60, Math.floor(deadline.remainingMs() / 1000)),
    baseLogger: new Logger(config.debug ? LogLevel.DEBUG : LogLevel.ERROR),
  });
  try {
    await client.start({ botAuthToken: config.token });
  } catch (error) {
    await client.destroy().catch(() => {});
    throw error;
  }
  return {
    async sendText(peer, message, options) {
      const sent = await client.sendMessage(toPeer(peer), {
        message: message.text,
        formattingEntities: message.entities,
        parseMode: false,
        linkPreview: options.linkPreview,
        silent: options.silent,
        replyTo: options.threadId,
      });
      return sent.id;
    },
    exportSession: () => String((client.session as sessions.StringSession).save()),
    close: () => client.destroy(),
  };
}
