import { pathToFileURL } from "node:url";
import { errors } from "teleproto";
import { loadCiContext } from "./ci-context.js";
import { type Config, loadConfig, type Mode } from "./config.js";
import { ConfigError, type Env } from "./env.js";
import { type FormattedMessage, formatMessage } from "./format.js";
import { parseTo } from "./recipients.js";
import { makeRedactor, type Redactor } from "./redact.js";
import { connectBot, createDeadline, type Deadline, type TelegramGateway, waitForPort } from "./telegram.js";
import { defaultRenderDeps, type RenderDeps, renderMessage } from "./template.js";

export interface MainDeps {
  env: Env;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  connect: (config: Config, deadline: Deadline) => Promise<TelegramGateway>;
  waitForPort: (host: string, port: number, deadline: Deadline) => Promise<void>;
  renderDeps: RenderDeps;
}

type Stage = "render" | "proxy" | "login" | "send";

interface RunState {
  stage: Stage;
  gateway?: TelegramGateway;
}

export function describeError(error: unknown): string {
  if (error instanceof errors.FloodWaitError) {
    return `Telegram FLOOD_WAIT of ${error.seconds}s exceeds the remaining time; set the "session" setting to avoid logging the bot in on every run`;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

function parseMode(argv: readonly string[]): Mode {
  const command = argv[0];
  if (command === undefined || command === "send") return "send";
  if (command === "session") return "session";
  throw new ConfigError(`unknown command "${command}", expected "session" or no command`);
}

// Stage-specific errors (e.g. "proxy … is not reachable after 60s") are raised right at the deadline;
// the generic timeout fires slightly later so that they win the race.
const DEADLINE_GRACE_MS = 1000;

async function withDeadline<T>(deadline: Deadline, state: RunState, work: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`timed out after ${deadline.timeoutSec}s during ${state.stage}`)),
      deadline.remainingMs() + DEADLINE_GRACE_MS,
    );
  });
  try {
    return await Promise.race([work(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function send(config: Config, deps: MainDeps, deadline: Deadline, state: RunState, redact: Redactor): Promise<number> {
  state.stage = "render";
  const ci = loadCiContext(deps.env);
  const rendered = await renderMessage(config, ci, deps.renderDeps);
  if (rendered.text === "") {
    deps.stdout("warning: message is empty, nothing to send");
    return 0;
  }
  const message: FormattedMessage = formatMessage(rendered.text, rendered.format);
  const recipients = parseTo(config.to, ci.commit.Email, config.onlyMatchEmail, (warning) => deps.stdout(`warning: ${warning}`));
  if (recipients.length === 0) {
    deps.stdout("warning: no recipients left after filtering, nothing to send");
    return 0;
  }

  const gateway = await login(config, deps, deadline, state);
  state.stage = "send";
  let failed = 0;
  for (const peer of recipients) {
    try {
      const id = await gateway.sendText(peer, message, {
        linkPreview: !config.disableWebPagePreview,
        silent: config.disableNotification,
        threadId: config.messageThreadId,
      });
      deps.stdout(`sent to ${peer} (message id ${id})`);
    } catch (error) {
      failed++;
      deps.stderr(redact(`failed to send to ${peer}: ${describeError(error)}`));
    }
  }
  return failed > 0 ? 1 : 0;
}

async function login(config: Config, deps: MainDeps, deadline: Deadline, state: RunState): Promise<TelegramGateway> {
  if (config.proxy) {
    state.stage = "proxy";
    await deps.waitForPort(config.proxy.host, config.proxy.port, deadline);
  }
  state.stage = "login";
  state.gateway = await deps.connect(config, deadline);
  return state.gateway;
}

/** Returns the process exit code: 0 on success, 1 on any failure (spec §9). */
export async function run(argv: readonly string[], deps: MainDeps): Promise<number> {
  const state: RunState = { stage: "render" };
  let redact: Redactor = (text) => text;
  try {
    const mode = parseMode(argv);
    const config = loadConfig(deps.env, mode);
    redact = makeRedactor([config.token, config.apiHash, config.proxy?.secret, config.session]);
    const deadline = createDeadline(config.timeoutSec);
    return await withDeadline(deadline, state, async () => {
      if (mode === "session") {
        const gateway = await login(config, deps, deadline, state);
        deps.stdout(gateway.exportSession());
        return 0;
      }
      return send(config, deps, deadline, state, redact);
    });
  } catch (error) {
    deps.stderr(redact(`error: ${describeError(error)}`));
    return 1;
  } finally {
    await state.gateway?.close().catch(() => {});
  }
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  const env = process.env;
  const code = await run(process.argv.slice(2), {
    env,
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
    connect: connectBot,
    waitForPort,
    renderDeps: defaultRenderDeps(env),
  });
  // teleproto keeps timers alive after destroy(); exit explicitly.
  process.exit(code);
}
