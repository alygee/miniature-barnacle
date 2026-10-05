import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { decodeHTML } from "entities";
import Handlebars from "handlebars";
import type { CiContext } from "./ci-context.js";
import type { Config, Format } from "./config.js";
import { ConfigError, type Env } from "./env.js";
import { registerDroneHelpers } from "./helpers/drone.js";
import { registerSprigHelpers } from "./helpers/sprig.js";

export interface RenderDeps {
  env: Env;
  now: () => Date;
  readText: (path: string) => Promise<string>;
  fetchText: (url: string) => Promise<string>;
}

// SECURITY BOUNDARY: templates are editable by anyone with push access, while the CI server injects the
// secrets, so the helpers `env`/`expandenv` must never see the plugin's own secret-bearing settings.
const SECRET_SETTING = /^(PLUGIN_|TELEGRAM_|INPUT_)(TOKEN|API_HASH|PROXY_SECRET|SESSION)$/i;

function withoutSecrets(env: Env): Env {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !SECRET_SETTING.test(key)));
}

export function defaultRenderDeps(env: Env): RenderDeps {
  return {
    env: withoutSecrets(env),
    now: () => new Date(),
    readText: (path) => readFile(path, "utf8"),
    fetchText: async (url) => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.text();
    },
  };
}

export type TemplateSettings = Pick<Config, "message" | "messageFile" | "templateVars" | "templateVarsFile" | "format">;

export interface RenderedMessage {
  /** Rendered and HTML-unescaped text, still containing markdown/html markup. Empty means "nothing to send". */
  text: string;
  format: Format;
}

const ICONS: Record<string, string> = { failure: "❌", cancelled: "❕", success: "✅" };

/** drone-telegram Plugin.Message(), character for character. */
export function defaultMessage(ci: CiContext): string {
  const { repo, commit, build, gitHub } = ci;
  if (ci.isActions) {
    return `${repo.FullName}/${gitHub.Workflow} triggered by ${repo.Namespace} (${gitHub.EventName})`;
  }
  const icon = ICONS[build.Status.toLowerCase()] ?? "";
  return (
    `${icon} Build #${build.Number} of \`${repo.FullName}\` ${build.Status}.\n\n` +
    `📝 Commit by ${commit.Author} on \`${commit.Branch}\`:\n` +
    `\`\`\` ${commit.Message} \`\`\`\n\n` +
    `🌐 ${build.Link}`
  );
}

/** drone-telegram escapeMarkdownOne. */
export function escapeMarkdownOne(value: string): string {
  return value.replaceAll("\\_", "_").replaceAll("_", "\\_");
}

/** Escapes `_` only outside {{…}} so helper arguments and variable names stay intact (spec §6.3 step 3). */
export function escapeOutsideMustaches(template: string): string {
  return template
    .split(/(\{\{[\s\S]*?\}\})/)
    .map((part, index) => (index % 2 === 1 ? part : escapeMarkdownOne(part)))
    .join("");
}

function escapeCiFields(ci: CiContext): CiContext {
  const e = escapeMarkdownOne;
  return {
    ...ci,
    repo: { ...ci.repo, Namespace: e(ci.repo.Namespace), Name: e(ci.repo.Name) },
    commit: {
      ...ci.commit,
      Message: e(ci.commit.Message),
      Branch: e(ci.commit.Branch),
      Link: e(ci.commit.Link),
      Author: e(ci.commit.Author),
      Email: e(ci.commit.Email),
    },
    build: { ...ci.build, Tag: e(ci.build.Tag), Link: e(ci.build.Link), PR: e(ci.build.PR) },
  };
}

/** raymond finds struct fields by exact name or strings.Title(name): expose both `FullName` and `fullName`. */
function withGoKeys(fields: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = value;
    out[key.charAt(0).toLowerCase() + key.slice(1)] = value;
  }
  return out;
}

export function buildTemplateContext(ci: CiContext, tpl: Record<string, string>): Record<string, unknown> {
  const gitHub = withGoKeys(ci.gitHub);
  return {
    ...withGoKeys({
      Repo: withGoKeys(ci.repo),
      Commit: withGoKeys(ci.commit),
      Build: withGoKeys(ci.build),
      GitHub: gitHub,
      Tpl: tpl,
    }),
    github: gitHub, // alias; raymond would look for "Github" and render nothing
  };
}

function parseVars(json: string, what: string): Record<string, string> {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch (error) {
    throw new ConfigError(`unable to parse ${what}: ${(error as Error).message}`);
  }
  if (
    typeof data !== "object" ||
    data === null ||
    Array.isArray(data) ||
    Object.values(data).some((value) => typeof value !== "string")
  ) {
    throw new ConfigError(`${what} must be a JSON object with string values`);
  }
  return data as Record<string, string>;
}

async function loadTemplateVars(settings: TemplateSettings, deps: RenderDeps): Promise<Record<string, string>> {
  const vars: Record<string, string> = {};
  if (settings.templateVars) Object.assign(vars, parseVars(settings.templateVars, "template_vars"));
  if (settings.templateVarsFile) {
    const file = settings.templateVarsFile;
    const content = await deps.readText(file).catch((error: Error) => {
      throw new ConfigError(`unable to read file with template vars '${file}': ${error.message}`);
    });
    Object.assign(vars, parseVars(content, `template vars file '${file}'`)); // file wins, as in drone-telegram
  }
  return vars;
}

/** drone-template-lib Render: a template that is exactly one http(s):// or file:// URL is loaded from there. */
async function loadRemoteTemplate(source: string, deps: RenderDeps): Promise<string> {
  const candidate = source.trim();
  if (/\s/.test(candidate)) return source;
  try {
    if (/^https?:\/\//i.test(candidate)) return await deps.fetchText(candidate);
    if (/^file:\/\//i.test(candidate)) return await deps.readText(fileURLToPath(candidate));
  } catch (error) {
    throw new ConfigError(`failed to load template ${candidate}: ${(error as Error).message}`);
  }
  return source;
}

function renderTemplate(source: string, context: object, deps: RenderDeps): string {
  const hb = Handlebars.create();
  registerDroneHelpers(hb, deps.now);
  registerSprigHelpers(hb, { now: deps.now, env: deps.env });
  try {
    return hb.compile(source)(context);
  } catch (error) {
    const message = (error as Error).message;
    const missing = /Missing helper: "([^"]+)"/.exec(message);
    if (missing) throw new ConfigError(`helper "${missing[1]}" is not supported (sprig subset, see README)`);
    throw new ConfigError(`template error: ${message}`);
  }
}

/** Render pipeline of spec §6.3 (steps 1–5); markup parsing (step 6) is formatMessage(). */
export async function renderMessage(settings: TemplateSettings, ci: CiContext, deps: RenderDeps): Promise<RenderedMessage> {
  let format = settings.format;
  let source: string;
  if (settings.messageFile) {
    const file = settings.messageFile;
    source = await deps.readText(file).catch((error: Error) => {
      throw new ConfigError(`error loading message file '${file}': ${error.message}`);
    });
  } else if (settings.message !== undefined) {
    source = settings.message;
  } else {
    source = defaultMessage(ci);
    format = "markdown";
  }
  source = (await loadRemoteTemplate(source, deps)).trim();
  if (source === "") return { text: "", format };

  const markdown = format === "markdown";
  const context = buildTemplateContext(markdown ? escapeCiFields(ci) : ci, await loadTemplateVars(settings, deps));
  const rendered = renderTemplate(markdown ? escapeOutsideMustaches(source) : source, context, deps);
  return { text: decodeHTML(rendered.replace(/^[ \n]+|[ \n]+$/g, "")), format };
}
