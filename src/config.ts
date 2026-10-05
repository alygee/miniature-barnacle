import {
  ConfigError,
  type Env,
  firstSet,
  paramKeys,
  parseBool,
  parseInteger,
  parseList,
  type RawValue,
} from "./env.js";

export type Format = "markdown" | "html";
export type Mode = "send" | "session";

export interface ProxyConfig {
  host: string;
  port: number;
  secret: string;
}

export interface Config {
  token: string;
  to: string[];
  message?: string;
  messageFile?: string;
  templateVars?: string;
  templateVarsFile?: string;
  format: Format;
  messageThreadId?: number;
  disableWebPagePreview: boolean;
  disableNotification: boolean;
  onlyMatchEmail: boolean;
  debug: boolean;
  apiId: number;
  apiHash: string;
  proxy?: ProxyConfig;
  session?: string;
  timeoutSec: number;
}

const UNSUPPORTED = ["photo", "document", "sticker", "audio", "voice", "video", "location", "venue", "socks5"];
const DEFAULT_PROXY_PORT = 1443;
const DEFAULT_TIMEOUT_SEC = 60;

export function loadConfig(env: Env, mode: Mode = "send"): Config {
  const get = (name: string) => firstSet(env, paramKeys(name));
  const trimmed = (name: string) => get(name)?.value.trim();

  for (const name of UNSUPPORTED) {
    const raw = get(name);
    if (raw) throw new ConfigError(`${raw.key} is not supported: drone-telegram-mtproto v1 sends text messages only`);
  }

  const token = trimmed("token");
  const to = parseList(get("to"));
  const apiIdRaw = get("api_id");
  const apiHash = trimmed("api_hash");
  if (!token || !apiIdRaw || !apiHash || (mode === "send" && to.length === 0)) {
    const missing = [
      !token && "token",
      mode === "send" && to.length === 0 && "to",
      !apiIdRaw && "api_id",
      !apiHash && "api_hash",
    ].filter(Boolean);
    throw new ConfigError(`missing required settings: ${missing.join(", ")}`);
  }

  return {
    token,
    to,
    message: get("message")?.value,
    messageFile: trimmed("message_file"),
    templateVars: get("template_vars")?.value,
    templateVarsFile: trimmed("template_vars_file"),
    format: parseFormat(get("format")),
    messageThreadId: parseInteger(get("message_thread_id")),
    disableWebPagePreview: parseBool(get("disable_web_page_preview")),
    disableNotification: parseBool(get("disable_notification")),
    onlyMatchEmail: parseBool(firstSet(env, paramKeys("only_match_email", ["PLUGIN_", "INPUT_"]))),
    debug: parseBool(get("debug")),
    apiId: positive(apiIdRaw),
    apiHash,
    proxy: parseProxy(get),
    session: trimmed("session"),
    timeoutSec: get("timeout") ? positive(get("timeout")!) : DEFAULT_TIMEOUT_SEC,
  };
}

function positive(raw: RawValue): number {
  const value = parseInteger(raw)!;
  if (value <= 0) throw new ConfigError(`${raw.key}: must be a positive integer`);
  return value;
}

function parseFormat(raw: RawValue | undefined): Format {
  if (!raw) return "markdown";
  const value = raw.value.trim().toLowerCase();
  if (value === "markdown" || value === "html") return value;
  if (value === "markdownv2") {
    throw new ConfigError(`${raw.key}: format "MarkdownV2" is not supported, use markdown or html`);
  }
  throw new ConfigError(`${raw.key}: invalid format "${raw.value}", expected markdown or html`);
}

function parseProxy(get: (name: string) => RawValue | undefined): ProxyConfig | undefined {
  const host = get("proxy_host")?.value.trim();
  if (!host) return undefined;
  const secretRaw = get("proxy_secret");
  if (!secretRaw) throw new ConfigError("proxy_secret is required when proxy_host is set");
  const secret = secretRaw.value.trim();
  validateProxySecret(secret, secretRaw.key);
  const portRaw = get("proxy_port");
  const port = parseInteger(portRaw) ?? DEFAULT_PROXY_PORT;
  if (port < 1 || port > 65535) throw new ConfigError(`${portRaw?.key ?? "proxy_port"}: port must be 1..65535`);
  return { host, port, secret };
}

/** Mirrors teleproto's parseProxySecret: 16 bytes, 0xdd + 16 bytes, or 0xee + 16 bytes + domain; hex or base64. */
export function validateProxySecret(secret: string, key = "proxy_secret"): void {
  const isHex = /^[0-9a-f]+$/i.test(secret);
  const bytes = isHex ? Buffer.from(secret, "hex") : Buffer.from(secret, "base64");
  const valid =
    (!isHex || secret.length % 2 === 0) &&
    (bytes.length === 16 || (bytes.length === 17 && bytes[0] === 0xdd) || (bytes.length > 17 && bytes[0] === 0xee));
  if (!valid) {
    throw new ConfigError(`${key}: must be 32 hex chars, "dd" + 32 hex, or "ee" + 32 hex + hex-encoded domain`);
  }
}
