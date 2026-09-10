# drone-telegram-mtproto Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Docker-плагин для Drone и Gitea/Forgejo Actions, повторяющий текстовые уведомления appleboy/drone-telegram, но отправляющий их через MTProto (teleproto) и MTProxy tg-ws-proxy.

**Architecture:** Чистые модули (env → config, CI-контекст, получатели, хелперы шаблонов, рендер, легаси-Markdown → entities) плюс тонкий слой Telegram (ожидание proxy, логин бота, отправка) и оркестратор `run()` с инжектируемыми зависимостями. Всё, кроме `telegram.ts`, тестируется без сети.

**Tech Stack:** Node 22, TypeScript 7.0.2 (ESM, NodeNext), teleproto 1.229.0, handlebars 4.7.9, entities 8.1.0, vitest 5.0.0, Docker (`node:22-alpine`).

**Spec:** `docs/superpowers/specs/2026-09-10-drone-telegram-mtproto-design.md` — читать вместе с планом; номера §N ниже ссылаются на него.

## Global Constraints

- Версии зависимостей точные: `teleproto` 1.229.0, `handlebars` 4.7.9, `entities` 8.1.0, `typescript` 7.0.2, `vitest` 5.0.0, `@types/node` ^22.20.2. Node ≥ 22.
- ESM: `"type": "module"`, `module`/`moduleResolution` = `NodeNext`, относительные импорты с суффиксом `.js`.
- Импорты teleproto (проверено в песочнице): `import { TelegramClient, Api, sessions, Logger, errors } from "teleproto";`, `import { HTMLParser } from "teleproto/extensions/html.js";`, `import { LogLevel } from "teleproto/extensions/Logger.js";`.
- Unit-тесты не ходят в сеть. Сеть — только в Task 0 (спайк) и Task 13 (e2e).
- Сообщения CLI и ошибок — на английском; README — на русском.
- Env-параметры читаются только с префиксами `PLUGIN_`, `TELEGRAM_`, `INPUT_` (§4).
- `.drone.yml` в корне — референс пользователя: не изменять и не коммитить. Никогда не использовать `git add -A` / `git add .` — только явные пути.
- Каждый коммит заканчивается трейлером:
  ```
  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01CPgaxA8dWNDrsqwbhYrxkW
  ```
  (в шагах ниже показан как `<TRAILER>` — подставлять эти две строки дословно).

## File Structure

```
package.json, package-lock.json, tsconfig.json, tsconfig.build.json, .gitignore, .dockerignore
src/
  env.ts            чтение env: ключи с префиксами, bool/int/list по правилам urfave/cli
  redact.ts         маскирование секретов
  config.ts         Config + валидация (§4)
  ci-context.ts     DRONE_*/GITHUB_* → CiContext (§5)
  recipients.ts     parseTo (§8)
  helpers/golang.ts Go-совместимые утилиты: toInt64/toFloat64, Duration, QueryEscape, time layout, regexp
  helpers/drone.ts  хелперы drone-template-lib + raymond `equal` (§6.2)
  helpers/sprig.ts  подмножество sprig (§6.2)
  markdown.ts       порт tdlib parse_markdown (§7.1)
  format.ts         текст+format → text + Api entities, лимит 4096 (§7)
  template.ts       контекст, пайплайн рендера, сообщения по умолчанию (§6)
  telegram.ts       waitForPort, toPeer, connectBot → TelegramGateway (§9)
  main.ts           run(argv, deps) + точка входа
test/               *.test.ts — по файлу на модуль
Dockerfile, examples/drone.yml, examples/gitea.yml, README.md
e2e/docker-compose.yml, e2e/run.sh
```

---

### Task 0: Спайк teleproto ↔ tg-ws-proxy (одноразовый, в репозиторий не идёт)

Проверяет риски §12 до написания основного кода. **Нужны от пользователя** (спросить, не выдумывать): токен бота, `api_id`/`api_hash` (my.telegram.org), id пользователя, который написал боту `/start`, id супергруппы `-100…` с ботом, id темы форума в ней (если есть форум).

**Files:** всё во временной директории `$SPIKE` (`mktemp -d`), не в репозитории. Меняется только спецификация (Step 4).

- [ ] **Step 1: Собрать и запустить tg-ws-proxy**

```bash
SPIKE=$(mktemp -d) && cd "$SPIKE"
git clone -q --depth 1 https://github.com/Flowseal/tg-ws-proxy && docker build -q -t tg-ws-proxy ./tg-ws-proxy
SECRET=$(openssl rand -hex 16); echo "SECRET=$SECRET"
docker run -d --name tgwsp-spike -p 127.0.0.1:1443:1443 -e TG_WS_PROXY_SECRET="$SECRET" tg-ws-proxy
sleep 3 && docker logs tgwsp-spike 2>&1 | grep -E 'tg://proxy|Secret'
```
Expected: в логах есть `tg://proxy?server=…&secret=dd<SECRET>`.

- [ ] **Step 2: Написать скрипт спайка**

```bash
cd "$SPIKE" && npm init -y >/dev/null && npm i -s teleproto@1.229.0
cat > spike.mjs <<'EOF'
import { TelegramClient, sessions, Logger } from "teleproto";
import { LogLevel } from "teleproto/extensions/Logger.js";

const e = process.env;
const client = new TelegramClient(new sessions.StringSession(""), Number(e.SPIKE_API_ID), e.SPIKE_API_HASH, {
  proxy: { ip: "127.0.0.1", port: 1443, secret: (e.SPIKE_SECRET_PREFIX ?? "") + e.SPIKE_SECRET, MTProxy: true },
  connectionRetries: 2,
  baseLogger: new Logger(LogLevel.INFO),
});
await client.start({ botAuthToken: e.SPIKE_TOKEN });
const me = await client.getMe();
console.log("bot:", me.username, "session dc:", client.session.dcId);
for (const to of e.SPIKE_TO.split(",")) {
  const peer = to.startsWith("@") ? to : Number(to);
  const m = await client.sendMessage(peer, { message: `spike ${new Date().toISOString()} to ${to}`, parseMode: false });
  console.log("sent:", to, "id:", m.id);
}
if (e.SPIKE_FORUM && e.SPIKE_THREAD_ID) {
  const m = await client.sendMessage(Number(e.SPIKE_FORUM), { message: "spike topic", parseMode: false, replyTo: Number(e.SPIKE_THREAD_ID) });
  console.log("sent to topic:", e.SPIKE_THREAD_ID, "id:", m.id);
}
await client.destroy();
process.exit(0);
EOF
```

- [ ] **Step 3: Запуск с plain secret, затем с `dd`**

```bash
cd "$SPIKE"
export SPIKE_TOKEN=… SPIKE_API_ID=… SPIKE_API_HASH=… SPIKE_SECRET=$SECRET \
       SPIKE_TO="<user_id>,-100<group_id>" SPIKE_FORUM="-100<forum_id>" SPIKE_THREAD_ID="<topic_id>"
node spike.mjs
SPIKE_SECRET_PREFIX=dd node spike.mjs
docker logs tgwsp-spike 2>&1 | grep -E 'DC[0-9]|fallback|handshake' | tail -30
```
Expected: оба запуска печатают `sent:` для каждого получателя и `sent to topic:`; сообщения видны в Telegram (сообщение в теме — внутри темы, а не в «General»).

- [ ] **Step 4: Зафиксировать результаты в спецификации**

Добавить в конец §12 спецификации подраздел `### Результаты спайка (дата)`: DC бота (`session dc`), какие DC шли через WS, а какие через fallback (из логов прокси), работают ли plain/`dd`, `-100…`, тема. Если что-то не работает — **остановиться** и вернуться к пользователю с находками: дальнейшие задачи зависят от этого.

```bash
cd /home/albert/projects/tg
git add docs/superpowers/specs/2026-09-10-drone-telegram-mtproto-design.md
git commit -m "docs(spec): record teleproto/tg-ws-proxy spike results" -m "<TRAILER>"
docker rm -f tgwsp-spike
```

---

### Task 1: Каркас проекта и `env.ts`

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsconfig.build.json`, `.gitignore`, `src/env.ts`
- Test: `test/env.test.ts`

**Interfaces:**
- Produces:
  - `type Env = Record<string, string | undefined>`
  - `class ConfigError extends Error`
  - `const PREFIXES: readonly ["PLUGIN_", "TELEGRAM_", "INPUT_"]`
  - `paramKeys(name: string, prefixes?: readonly string[]): string[]`
  - `interface RawValue { key: string; value: string }`
  - `firstSet(env: Env, keys: readonly string[]): RawValue | undefined`
  - `parseBool(raw: RawValue | undefined, fallback?: boolean): boolean`
  - `parseInteger(raw: RawValue | undefined): number | undefined`
  - `parseList(raw: RawValue | undefined): string[]`

- [ ] **Step 1: Создать каркас**

`package.json`:
```json
{
  "name": "drone-telegram-mtproto",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc -p tsconfig.json",
    "test": "vitest run",
    "e2e": "sh e2e/run.sh"
  }
}
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "types": ["node"],
    "noEmit": true
  },
  "include": ["src", "test"]
}
```

`tsconfig.build.json`:
```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "noEmit": false, "outDir": "dist", "rootDir": "src" },
  "include": ["src"]
}
```

`.gitignore`:
```
node_modules/
dist/
```

```bash
npm i -s --save-exact teleproto@1.229.0 handlebars@4.7.9 entities@8.1.0
npm i -s -D --save-exact typescript@7.0.2 vitest@5.0.0 && npm i -s -D @types/node@^22.20.2
```
Expected: `package.json` получил `dependencies`/`devDependencies`, создан `package-lock.json`.

- [ ] **Step 2: Написать падающий тест** — `test/env.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ConfigError, firstSet, paramKeys, parseBool, parseInteger, parseList } from "../src/env.js";

describe("paramKeys", () => {
  it("builds PLUGIN_/TELEGRAM_/INPUT_ keys in priority order", () => {
    expect(paramKeys("message_thread_id")).toEqual([
      "PLUGIN_MESSAGE_THREAD_ID",
      "TELEGRAM_MESSAGE_THREAD_ID",
      "INPUT_MESSAGE_THREAD_ID",
    ]);
  });
  it("accepts custom prefixes", () => {
    expect(paramKeys("only_match_email", ["PLUGIN_", "INPUT_"])).toEqual([
      "PLUGIN_ONLY_MATCH_EMAIL",
      "INPUT_ONLY_MATCH_EMAIL",
    ]);
  });
});

describe("firstSet", () => {
  it("returns the first non-blank value with its key", () => {
    const env = { PLUGIN_TO: "   ", TELEGRAM_TO: "1", INPUT_TO: "2" };
    expect(firstSet(env, paramKeys("to"))).toEqual({ key: "TELEGRAM_TO", value: "1" });
  });
  it("returns undefined when nothing is set", () => {
    expect(firstSet({ A: "" }, ["A", "B"])).toBeUndefined();
  });
});

describe("parseBool", () => {
  it.each(["1", "t", "T", "TRUE", "true", "True"])("parses %s as true", (v) => {
    expect(parseBool({ key: "K", value: v })).toBe(true);
  });
  it.each(["0", "f", "F", "FALSE", "false", "False"])("parses %s as false", (v) => {
    expect(parseBool({ key: "K", value: v }, true)).toBe(false);
  });
  it("uses the fallback when unset", () => {
    expect(parseBool(undefined)).toBe(false);
    expect(parseBool(undefined, true)).toBe(true);
  });
  it("rejects anything else with the key in the message", () => {
    expect(() => parseBool({ key: "PLUGIN_DEBUG", value: "yes" })).toThrow(ConfigError);
    expect(() => parseBool({ key: "PLUGIN_DEBUG", value: "yes" })).toThrow('PLUGIN_DEBUG: invalid boolean "yes"');
  });
});

describe("parseInteger", () => {
  it("parses integers with surrounding spaces", () => {
    expect(parseInteger({ key: "K", value: " -7 " })).toBe(-7);
    expect(parseInteger({ key: "K", value: "42" })).toBe(42);
  });
  it("returns undefined when unset", () => {
    expect(parseInteger(undefined)).toBeUndefined();
  });
  it("rejects non-integers", () => {
    expect(() => parseInteger({ key: "PLUGIN_TIMEOUT", value: "4.2" })).toThrow('PLUGIN_TIMEOUT: invalid integer "4.2"');
  });
});

describe("parseList", () => {
  it("splits on commas, trims and drops blanks", () => {
    expect(parseList({ key: "K", value: "1, 2,, 3 ,  " })).toEqual(["1", "2", "3"]);
  });
  it("returns [] when unset", () => {
    expect(parseList(undefined)).toEqual([]);
  });
});
```

- [ ] **Step 3: Запустить — должен упасть**

Run: `npx vitest run test/env.test.ts`
Expected: FAIL — `Failed to load url ../src/env.js` (модуля нет).

- [ ] **Step 4: Реализовать** — `src/env.ts`:

```ts
export type Env = Record<string, string | undefined>;

export class ConfigError extends Error {
  override name = "ConfigError";
}

export const PREFIXES = ["PLUGIN_", "TELEGRAM_", "INPUT_"] as const;

export interface RawValue {
  key: string;
  value: string;
}

export function paramKeys(name: string, prefixes: readonly string[] = PREFIXES): string[] {
  const upper = name.toUpperCase();
  return prefixes.map((prefix) => prefix + upper);
}

/** First key whose value is not blank — blank values count as unset, like drone-telegram's unsetEmptyEnv. */
export function firstSet(env: Env, keys: readonly string[]): RawValue | undefined {
  for (const key of keys) {
    const value = env[key];
    if (value !== undefined && value.trim() !== "") return { key, value };
  }
  return undefined;
}

// Go strconv.ParseBool
const TRUE_VALUES = new Set(["1", "t", "T", "TRUE", "true", "True"]);
const FALSE_VALUES = new Set(["0", "f", "F", "FALSE", "false", "False"]);

export function parseBool(raw: RawValue | undefined, fallback = false): boolean {
  if (!raw) return fallback;
  const value = raw.value.trim();
  if (TRUE_VALUES.has(value)) return true;
  if (FALSE_VALUES.has(value)) return false;
  throw new ConfigError(`${raw.key}: invalid boolean "${raw.value}"`);
}

export function parseInteger(raw: RawValue | undefined): number | undefined {
  if (!raw) return undefined;
  const value = raw.value.trim();
  if (!/^-?\d+$/.test(value)) throw new ConfigError(`${raw.key}: invalid integer "${raw.value}"`);
  return Number(value);
}

export function parseList(raw: RawValue | undefined): string[] {
  if (!raw) return [];
  return raw.value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}
```

- [ ] **Step 5: Запустить тесты и typecheck**

Run: `npx vitest run test/env.test.ts && npm run typecheck`
Expected: PASS, typecheck без ошибок.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json tsconfig.json tsconfig.build.json .gitignore src/env.ts test/env.test.ts
git commit -m "feat: project scaffold and env parsing" -m "<TRAILER>"
```

---

### Task 2: `config.ts` и `redact.ts`

**Files:**
- Create: `src/config.ts`, `src/redact.ts`
- Test: `test/config.test.ts`, `test/redact.test.ts`

**Interfaces:**
- Consumes: `Env`, `ConfigError`, `RawValue`, `firstSet`, `paramKeys`, `parseBool`, `parseInteger`, `parseList` из `src/env.ts`.
- Produces:
  - `type Format = "markdown" | "html"`, `type Mode = "send" | "session"`
  - `interface ProxyConfig { host: string; port: number; secret: string }`
  - `interface Config { token; to: string[]; message?; messageFile?; templateVars?; templateVarsFile?; format: Format; messageThreadId?: number; disableWebPagePreview: boolean; disableNotification: boolean; onlyMatchEmail: boolean; debug: boolean; apiId: number; apiHash: string; proxy?: ProxyConfig; session?: string; timeoutSec: number }` (строки — `string`)
  - `loadConfig(env: Env, mode?: Mode): Config`
  - `validateProxySecret(secret: string, key?: string): void`
  - `type Redactor = (text: string) => string`, `makeRedactor(secrets: ReadonlyArray<string | undefined>): Redactor`

- [ ] **Step 1: Написать падающие тесты**

`test/redact.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { makeRedactor } from "../src/redact.js";

describe("makeRedactor", () => {
  it("replaces every occurrence of every secret", () => {
    const redact = makeRedactor(["123:SECRET", "hash0123", undefined]);
    expect(redact("bot 123:SECRET failed, hash0123 / 123:SECRET")).toBe("bot <redacted> failed, <redacted> / <redacted>");
  });
  it("replaces longer secrets first", () => {
    const redact = makeRedactor(["abcd", "abcd1234"]);
    expect(redact("x abcd1234 y abcd")).toBe("x <redacted> y <redacted>");
  });
  it("ignores empty and too-short values", () => {
    const redact = makeRedactor(["", "ab", "  "]);
    expect(redact("ab cd")).toBe("ab cd");
  });
});
```

`test/config.test.ts`:
```ts
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
```

- [ ] **Step 2: Запустить — должны упасть**

Run: `npx vitest run test/config.test.ts test/redact.test.ts`
Expected: FAIL — модулей `src/config.js`, `src/redact.js` нет.

- [ ] **Step 3: Реализовать**

`src/redact.ts`:
```ts
export type Redactor = (text: string) => string;

/** Replaces secret values with <redacted>. Values shorter than 4 chars are ignored to avoid mangling output. */
export function makeRedactor(secrets: ReadonlyArray<string | undefined>): Redactor {
  const values = secrets
    .filter((secret): secret is string => typeof secret === "string" && secret.trim().length >= 4)
    .sort((a, b) => b.length - a.length);
  return (text) => values.reduce((acc, secret) => acc.split(secret).join("<redacted>"), text);
}
```

`src/config.ts`:
```ts
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
```

- [ ] **Step 4: Запустить тесты и typecheck**

Run: `npx vitest run test/config.test.ts test/redact.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/redact.ts test/config.test.ts test/redact.test.ts
git commit -m "feat: config loading, validation and secret redaction" -m "<TRAILER>"
```

---

### Task 3: `ci-context.ts`

**Files:**
- Create: `src/ci-context.ts`
- Test: `test/ci-context.test.ts`

**Interfaces:**
- Consumes: `Env`, `firstSet`, `parseBool` из `src/env.ts`.
- Produces (имена полей — Go-имена из drone-telegram, это важно для §6.1):
  - `interface Repo { FullName: string; Namespace: string; Name: string }`
  - `interface Commit { Sha: string; Ref: string; Branch: string; Link: string; Author: string; Avatar: string; Email: string; Message: string }`
  - `interface Build { Tag: string; Event: string; Number: number; Status: string; Link: string; Started: number; Finished: number; PR: string; DeployTo: string }`
  - `interface GitHub { Workflow: string; Workspace: string; Action: string; EventName: string; EventPath: string }`
  - `interface CiContext { isActions: boolean; repo: Repo; commit: Commit; build: Build; gitHub: GitHub }`
  - `loadCiContext(env: Env): CiContext`

- [ ] **Step 1: Написать падающий тест** — `test/ci-context.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { loadCiContext } from "../src/ci-context.js";

const drone = {
  DRONE_REPO: "org/web_app",
  DRONE_REPO_OWNER: "org",
  DRONE_REPO_NAME: "web_app",
  DRONE_COMMIT_SHA: "abc",
  DRONE_COMMIT_REF: "refs/heads/dev",
  DRONE_COMMIT_BRANCH: "dev",
  DRONE_COMMIT_LINK: "https://git.example.com/org/web_app/commit/abc",
  DRONE_COMMIT_AUTHOR: "ivan",
  DRONE_COMMIT_AUTHOR_EMAIL: "ivan@example.com",
  DRONE_COMMIT_AUTHOR_AVATAR: "https://git.example.com/avatar.png",
  DRONE_COMMIT_MESSAGE: "fix_login",
  DRONE_BUILD_EVENT: "push",
  DRONE_BUILD_NUMBER: "42",
  DRONE_BUILD_STATUS: "failure",
  DRONE_BUILD_LINK: "https://drone.example.com/org/web_app/42",
  DRONE_TAG: "v1",
  DRONE_PULL_REQUEST: "7",
  DRONE_STAGE_STARTED: "1000",
  DRONE_BUILD_FINISHED: "1215",
  DRONE_DEPLOY_TO: "prod",
};

const actions = {
  GITHUB_ACTIONS: "true",
  GITHUB_REPOSITORY: "org/web_app",
  GITHUB_ACTOR: "ivan",
  GITHUB_SHA: "abc",
  GITHUB_REF: "refs/heads/dev",
  GITHUB_REF_NAME: "dev",
  GITHUB_SERVER_URL: "https://gitea.example.com/",
  GITHUB_RUN_ID: "99",
  GITHUB_RUN_NUMBER: "7",
  GITHUB_EVENT_NAME: "pull_request",
  GITHUB_WORKFLOW: "ci",
  GITHUB_ACTION: "notify",
  GITHUB_WORKSPACE: "/workspace",
  GITHUB_EVENT_PATH: "/event.json",
};

describe("loadCiContext", () => {
  it("maps Drone variables like drone-telegram", () => {
    expect(loadCiContext(drone)).toEqual({
      isActions: false,
      repo: { FullName: "org/web_app", Namespace: "org", Name: "web_app" },
      commit: {
        Sha: "abc",
        Ref: "refs/heads/dev",
        Branch: "dev",
        Link: "https://git.example.com/org/web_app/commit/abc",
        Author: "ivan",
        Avatar: "https://git.example.com/avatar.png",
        Email: "ivan@example.com",
        Message: "fix_login",
      },
      build: {
        Tag: "v1",
        Event: "push",
        Number: 42,
        Status: "failure",
        Link: "https://drone.example.com/org/web_app/42",
        Started: 1000,
        Finished: 1215,
        PR: "7",
        DeployTo: "prod",
      },
      gitHub: { Workflow: "", Workspace: "", Action: "", EventName: "", EventPath: "" },
    });
  });

  it("applies drone-telegram defaults", () => {
    const ctx = loadCiContext({});
    expect(ctx.isActions).toBe(false);
    expect(ctx.commit.Branch).toBe("master");
    expect(ctx.build).toMatchObject({ Event: "push", Status: "success", Number: 0, Started: 0, Finished: 0 });
  });

  it("turns non-numeric numbers into 0", () => {
    expect(loadCiContext({ DRONE_BUILD_NUMBER: "x", DRONE_STAGE_STARTED: "1.5" }).build).toMatchObject({ Number: 0, Started: 0 });
  });

  it("maps and derives Gitea/Forgejo Actions variables", () => {
    const ctx = loadCiContext(actions);
    expect(ctx.isActions).toBe(true);
    expect(ctx.repo).toEqual({ FullName: "org/web_app", Namespace: "ivan", Name: "web_app" });
    expect(ctx.commit).toMatchObject({
      Sha: "abc",
      Ref: "refs/heads/dev",
      Branch: "dev",
      Link: "https://gitea.example.com/org/web_app/commit/abc",
    });
    expect(ctx.build).toMatchObject({
      Event: "pull_request",
      Number: 7,
      Link: "https://gitea.example.com/org/web_app/actions/runs/99",
    });
    expect(ctx.gitHub).toEqual({
      Workflow: "ci",
      Workspace: "/workspace",
      Action: "notify",
      EventName: "pull_request",
      EventPath: "/event.json",
    });
  });

  it("enables Actions mode via PLUGIN_GITHUB", () => {
    expect(loadCiContext({ PLUGIN_GITHUB: "true" }).isActions).toBe(true);
  });

  it("does not derive Actions-only fields outside Actions mode", () => {
    const ctx = loadCiContext({ GITHUB_REF_NAME: "dev", GITHUB_RUN_NUMBER: "7", GITHUB_REPOSITORY: "org/x" });
    expect(ctx.commit.Branch).toBe("master");
    expect(ctx.build.Number).toBe(0);
    expect(ctx.repo).toEqual({ FullName: "org/x", Namespace: "", Name: "" });
  });
});
```

- [ ] **Step 2: Запустить — должен упасть**

Run: `npx vitest run test/ci-context.test.ts`
Expected: FAIL — модуля `src/ci-context.js` нет.

- [ ] **Step 3: Реализовать** — `src/ci-context.ts`:

```ts
import { type Env, firstSet, parseBool } from "./env.js";

export interface Repo {
  FullName: string;
  Namespace: string;
  Name: string;
}

export interface Commit {
  Sha: string;
  Ref: string;
  Branch: string;
  Link: string;
  Author: string;
  Avatar: string;
  Email: string;
  Message: string;
}

export interface Build {
  Tag: string;
  Event: string;
  Number: number;
  Status: string;
  Link: string;
  Started: number;
  Finished: number;
  PR: string;
  DeployTo: string;
}

export interface GitHub {
  Workflow: string;
  Workspace: string;
  Action: string;
  EventName: string;
  EventPath: string;
}

export interface CiContext {
  isActions: boolean;
  repo: Repo;
  commit: Commit;
  build: Build;
  gitHub: GitHub;
}

/** Env mapping follows drone-telegram main.go; Actions-only derivations are marked in spec §5. */
export function loadCiContext(env: Env): CiContext {
  const isActions = env.GITHUB_ACTIONS === "true" || parseBool(firstSet(env, ["PLUGIN_GITHUB", "GITHUB"]));
  const str = (...keys: string[]) => firstSet(env, keys)?.value ?? "";
  const num = (...keys: string[]) => toNumber(str(...keys));
  const actionsStr = (key: string) => (isActions ? str(key) : "");

  const server = (env.GITHUB_SERVER_URL ?? "").replace(/\/+$/, "");
  const ghRepo = env.GITHUB_REPOSITORY ?? "";
  const ghLink = (path: string) => (isActions && server && ghRepo ? `${server}/${ghRepo}/${path}` : "");

  return {
    isActions,
    repo: {
      FullName: str("DRONE_REPO", "GITHUB_REPOSITORY"),
      Namespace: str("DRONE_REPO_OWNER", "DRONE_REPO_NAMESPACE", "GITHUB_ACTOR"),
      Name: str("DRONE_REPO_NAME") || (isActions ? ghRepo.split("/").slice(1).join("/") : ""),
    },
    commit: {
      Sha: str("DRONE_COMMIT_SHA", "GITHUB_SHA"),
      Ref: str("DRONE_COMMIT_REF", "GITHUB_REF"),
      Branch: str("DRONE_COMMIT_BRANCH") || actionsStr("GITHUB_REF_NAME") || "master",
      Link: str("DRONE_COMMIT_LINK") || (env.GITHUB_SHA ? ghLink(`commit/${env.GITHUB_SHA}`) : ""),
      Author: str("DRONE_COMMIT_AUTHOR"),
      Avatar: str("DRONE_COMMIT_AUTHOR_AVATAR"),
      Email: str("DRONE_COMMIT_AUTHOR_EMAIL"),
      Message: str("DRONE_COMMIT_MESSAGE"),
    },
    build: {
      Tag: str("DRONE_TAG"),
      Event: str("DRONE_BUILD_EVENT") || actionsStr("GITHUB_EVENT_NAME") || "push",
      Number: num("DRONE_BUILD_NUMBER") || (isActions ? num("GITHUB_RUN_NUMBER") : 0),
      Status: str("DRONE_BUILD_STATUS") || "success",
      Link: str("DRONE_BUILD_LINK") || (env.GITHUB_RUN_ID ? ghLink(`actions/runs/${env.GITHUB_RUN_ID}`) : ""),
      // sic: drone-telegram reads build.started from DRONE_STAGE_STARTED
      Started: num("DRONE_STAGE_STARTED"),
      Finished: num("DRONE_BUILD_FINISHED"),
      PR: str("DRONE_PULL_REQUEST"),
      DeployTo: str("DRONE_DEPLOY_TO"),
    },
    gitHub: {
      Workflow: str("GITHUB_WORKFLOW"),
      Workspace: str("GITHUB_WORKSPACE"),
      Action: str("GITHUB_ACTION"),
      EventName: str("GITHUB_EVENT_NAME"),
      EventPath: str("GITHUB_EVENT_PATH"),
    },
  };
}

function toNumber(value: string): number {
  const trimmed = value.trim();
  return /^-?\d+$/.test(trimmed) ? Number(trimmed) : 0;
}
```

- [ ] **Step 4: Запустить тесты и typecheck**

Run: `npx vitest run test/ci-context.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ci-context.ts test/ci-context.test.ts
git commit -m "feat: map Drone and Gitea Actions variables to CI context" -m "<TRAILER>"
```

---

### Task 4: `recipients.ts`

**Files:**
- Create: `src/recipients.ts`
- Test: `test/recipients.test.ts`

**Interfaces:**
- Produces: `parseTo(to: readonly string[], authorEmail: string, matchEmail: boolean, warn?: (message: string) => void): string[]` — нормализованные id (`"123"`, `"-100…"`, `"@name"`), порядок как в drone-telegram (§8).

- [ ] **Step 1: Написать падающий тест** — `test/recipients.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { parseTo } from "../src/recipients.js";

// Cases from drone-telegram plugin_test.go TestParseTo
const input = ["0", "1:1@gmail.com", "2:2@gmail.com", "3:3@gmail.com", "4", "5"];

describe("parseTo", () => {
  it("appends email-matched ids after plain ids", () => {
    expect(parseTo(input, "1@gmail.com", false)).toEqual(["0", "4", "5", "1"]);
  });
  it("sends only to matched ids when only_match_email is set", () => {
    expect(parseTo(input, "1@gmail.com", true)).toEqual(["1"]);
  });
  it("falls back to plain ids when no email matches", () => {
    expect(parseTo(input, "a@gmail.com", false)).toEqual(["0", "4", "5"]);
    expect(parseTo(input, "a@gmail.com", true)).toEqual(["0", "4", "5"]);
  });
  it("returns [] for blank input", () => {
    expect(parseTo(["", " ", "   "], "a@gmail.com", true)).toEqual([]);
  });
  it("accepts @username, also with an email filter", () => {
    expect(parseTo(["@ci_bot_chat", "@ci_team:1@gmail.com"], "1@gmail.com", false)).toEqual(["@ci_bot_chat", "@ci_team"]);
    expect(parseTo(["@ci_bot_chat", "@ci_team:1@gmail.com"], "1@gmail.com", true)).toEqual(["@ci_team"]);
  });
  it("normalizes numeric ids and keeps negative chat ids", () => {
    expect(parseTo(["+5", "-1001234567890", "-42"], "", false)).toEqual(["5", "-1001234567890", "-42"]);
  });
  it("skips invalid recipients with a warning", () => {
    const warn = vi.fn();
    expect(parseTo(["中文ID", "abc", "@ab", ":", "12"], "", false, warn)).toEqual(["12"]);
    expect(warn).toHaveBeenCalledTimes(4);
    expect(warn).toHaveBeenCalledWith('skipping recipient "中文ID": not a numeric id or @username');
  });
});
```

- [ ] **Step 2: Запустить — должен упасть**

Run: `npx vitest run test/recipients.test.ts`
Expected: FAIL — модуля `src/recipients.js` нет.

- [ ] **Step 3: Реализовать** — `src/recipients.ts`:

```ts
const NUMERIC_ID = /^[+-]?\d+$/;
const USERNAME = /^@[A-Za-z0-9_]{4,32}$/;

/**
 * Port of drone-telegram parseTo: plain ids always receive the message, `id:email` entries only when
 * the email matches the commit author; with matchEmail, any match restricts delivery to matched entries.
 * Extension: `@username` is accepted wherever a numeric id is.
 */
export function parseTo(
  to: readonly string[],
  authorEmail: string,
  matchEmail: boolean,
  warn: (message: string) => void = () => {},
): string[] {
  const ids: string[] = [];
  const emails: string[] = [];
  let attachEmail = true;

  for (const value of to.map((item) => item.trim()).filter((item) => item !== "")) {
    const parts = value
      .split(":")
      .map((part) => part.trim())
      .filter((part) => part !== "");
    const id = normalizeId(parts[0] ?? "");
    if (id === undefined) {
      warn(`skipping recipient "${value}": not a numeric id or @username`);
      continue;
    }
    if (parts.length > 1) {
      if (parts[1] !== authorEmail) continue;
      emails.push(id);
      attachEmail = false;
      continue;
    }
    ids.push(id);
  }

  if (matchEmail && !attachEmail) return emails;
  return [...ids, ...emails];
}

function normalizeId(value: string): string | undefined {
  if (NUMERIC_ID.test(value)) return BigInt(value).toString();
  if (USERNAME.test(value)) return value;
  return undefined;
}
```

- [ ] **Step 4: Запустить тесты и typecheck**

Run: `npx vitest run test/recipients.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/recipients.ts test/recipients.test.ts
git commit -m "feat: port drone-telegram recipient parsing with @username support" -m "<TRAILER>"
```

---

### Task 5: `helpers/golang.ts` — Go-совместимые примитивы

Хелперы drone-template-lib и sprig — Go-код; здесь их семантика: приведение типов spf13/cast, `time.Duration.String()`, `url.QueryEscape`, Go-layout дат (`2006-01-02 15:04`), RE2-замены (`$1`, `${name}`), нулевые значения Go (для `if`/`default`).

**Files:**
- Create: `src/helpers/golang.ts`
- Test: `test/golang.test.ts`

**Interfaces:**
- Produces:
  - `toInt64(value: unknown): number`, `toFloat64(value: unknown): number`
  - `goDuration(totalSeconds: number): string`
  - `goQueryEscape(value: string): string`
  - `goRegExp(pattern: string, global?: boolean): RegExp`, `goRegexReplaceAll(pattern: string, input: string, replacement: string): string`
  - `goTitle(value: string): string`, `goQuote(value: string): string`
  - `isGoZero(value: unknown): boolean`, `goString(value: unknown): string`
  - `isValidTimeZone(timeZone: string): boolean`
  - `goFormatTime(date: Date, layout: string, timeZone?: string): string` — `timeZone` = IANA-имя, `undefined` = локальная зона процесса

- [ ] **Step 1: Написать падающий тест** — `test/golang.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  goDuration,
  goFormatTime,
  goQueryEscape,
  goQuote,
  goRegExp,
  goRegexReplaceAll,
  goString,
  goTitle,
  isGoZero,
  isValidTimeZone,
  toFloat64,
  toInt64,
} from "../src/helpers/golang.js";

// 2023-11-14T22:13:20Z, a Tuesday; Europe/Moscow is UTC+3 all year (Wednesday 01:13:20).
const T = new Date(1700000000 * 1000);

describe("toInt64 / toFloat64", () => {
  it.each([
    [3.9, 3],
    [-3.9, -3],
    ["12", 12],
    [" 7 ", 7],
    ["1.5", 0],
    ["x", 0],
    [true, 1],
    [undefined, 0],
    [Number.NaN, 0],
  ])("toInt64(%s) = %s", (input, expected) => {
    expect(toInt64(input)).toBe(expected);
  });
  it.each([
    ["1.5", 1.5],
    ["x", 0],
    [2, 2],
    [false, 0],
  ])("toFloat64(%s) = %s", (input, expected) => {
    expect(toFloat64(input)).toBe(expected);
  });
});

describe("goDuration", () => {
  it.each([
    [0, "0s"],
    [45, "45s"],
    [125, "2m5s"],
    [3600, "1h0m0s"],
    [3725, "1h2m5s"],
    [-61, "-1m1s"],
    [12.9, "12s"],
  ])("goDuration(%s) = %s", (input, expected) => {
    expect(goDuration(input)).toBe(expected);
  });
});

describe("goQueryEscape", () => {
  it("matches url.QueryEscape", () => {
    expect(goQueryEscape("a b&c=d/é!*'()~_-.")).toBe("a+b%26c%3Dd%2F%C3%A9%21%2A%27%28%29~_-.");
  });
});

describe("regexp helpers", () => {
  it("turns a leading (?i) into a flag", () => {
    expect(goRegExp("(?i)abc").test("xABCx")).toBe(true);
  });
  it("converts Go replacement syntax", () => {
    expect(goRegexReplaceAll("(\\w+)@(\\w+)", "ivan@example", "$2:${1}")).toBe("example:ivan");
    expect(goRegexReplaceAll("a", "banana", "$$")).toBe("b$n$n$");
    expect(goRegexReplaceAll("a", "a a", "x y")).toBe("x y x y");
    expect(goRegexReplaceAll("(?P<user>\\w+)@", "ivan@x", "${user}!")).toBe("ivan!x");
    expect(goRegexReplaceAll("[0-9]+", "build 42", "#${0}")).toBe("build #42");
  });
});

describe("isGoZero / goString", () => {
  it.each([undefined, null, false, "", 0, Number.NaN, [], {}])("%s is a zero value", (value) => {
    expect(isGoZero(value)).toBe(true);
  });
  it.each([true, "x", 1, -1, [0], { a: 1 }, new Date(0)])("%s is not a zero value", (value) => {
    expect(isGoZero(value)).toBe(false);
  });
  it("renders nil as empty string", () => {
    expect([goString(undefined), goString(null), goString(42), goString(true)]).toEqual(["", "", "42", "true"]);
  });
});

describe("goTitle / goQuote", () => {
  it("title-cases words like strings.Title", () => {
    expect(goTitle("hello big_world o'neil")).toBe("Hello Big_world O'Neil");
  });
  it("quotes like strconv.Quote", () => {
    expect(goQuote('a "b"\n')).toBe('"a \\"b\\"\\n"');
  });
});

describe("goFormatTime", () => {
  it.each([
    ["2006-01-02 15:04:05", "UTC", "2023-11-14 22:13:20"],
    ["Jan _2 2006 3:04PM MST", "UTC", "Nov 14 2023 10:13PM UTC"],
    ["Monday, January 2", "Europe/Moscow", "Wednesday, November 15"],
    ["15:04 -07:00 Z07:00", "Europe/Moscow", "01:13 +03:00 +03:00"],
    ["Z07:00 -0700 -07", "UTC", "Z +0000 +00"],
    ["06 1 2 3 4 5 pm Mon", "UTC", "23 11 14 10 13 20 pm Tue"],
    ["Build 1.0", "UTC", "Build 11.0"],
  ])("formats %s in %s", (layout, zone, expected) => {
    expect(goFormatTime(T, layout, zone)).toBe(expected);
  });
  it("formats fractional seconds", () => {
    expect(goFormatTime(new Date(1700000000123), "05.000 05.999", "UTC")).toBe("20.123 20.123");
    expect(goFormatTime(new Date(1700000000000), "05.000 05.999", "UTC")).toBe("20.000 20");
  });
  it("pads _2 with a space", () => {
    expect(goFormatTime(new Date(Date.UTC(2023, 0, 5)), "_2", "UTC")).toBe(" 5");
  });
});

describe("isValidTimeZone", () => {
  it("accepts IANA names and rejects garbage", () => {
    expect(isValidTimeZone("Europe/Moscow")).toBe(true);
    expect(isValidTimeZone("Mars/Base")).toBe(false);
  });
});
```

- [ ] **Step 2: Запустить — должен упасть**

Run: `npx vitest run test/golang.test.ts`
Expected: FAIL — модуля `src/helpers/golang.js` нет.

- [ ] **Step 3: Реализовать** — `src/helpers/golang.ts`:

```ts
// Go-compatible primitives used by the template helpers (drone-template-lib and sprig are Go libraries).

/** spf13/cast ToInt64 as used by sprig: integers and integer strings; anything else is 0. */
export function toInt64(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? Math.trunc(value) : 0;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return /^[+-]?\d+$/.test(trimmed) ? Number(trimmed) : 0;
  }
  return 0;
}

/** spf13/cast ToFloat64 as used by sprig. */
export function toFloat64(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(trimmed) ? Number(trimmed) : 0;
  }
  return 0;
}

/** time.Duration.String() for whole seconds: 0s, 45s, 2m5s, 1h0m0s. */
export function goDuration(totalSeconds: number): string {
  let seconds = Math.trunc(totalSeconds);
  if (seconds === 0) return "0s";
  const sign = seconds < 0 ? "-" : "";
  seconds = Math.abs(seconds);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  if (hours > 0) return `${sign}${hours}h${minutes}m${rest}s`;
  if (minutes > 0) return `${sign}${minutes}m${rest}s`;
  return `${sign}${rest}s`;
}

/** url.QueryEscape: keeps A-Z a-z 0-9 - _ . ~, space becomes +, everything else is %XX of UTF-8 bytes. */
export function goQueryEscape(value: string): string {
  return encodeURIComponent(value)
    .replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%20/g, "+");
}

/** RE2 pattern → RegExp; a leading (?flags) group with i/m/s becomes JS flags. */
export function goRegExp(pattern: string, global = false): RegExp {
  let source = pattern;
  let flags = global ? "g" : "";
  const inline = /^\(\?([ims]+)\)/.exec(pattern);
  if (inline) {
    source = pattern.slice(inline[0].length);
    for (const flag of inline[1]!) if (!flags.includes(flag)) flags += flag;
  }
  // RE2 named groups (?P<name>...) → JS (?<name>...)
  source = source.replace(/\(\?P</g, "(?<");
  return new RegExp(source, flags);
}

/** regexp.ReplaceAllString with Go's $1 / ${1} / ${name} / $0 / $$ replacement syntax. */
export function goRegexReplaceAll(pattern: string, input: string, replacement: string): string {
  // "$$" means a literal "$" in both Go and JS replacement strings, so convert the pieces between them.
  const jsReplacement = replacement
    .split("$$")
    .map((piece) =>
      piece.replace(/\$\{(\w+)\}|\$(\w+)/g, (_match, braced: string | undefined, bare: string | undefined) => {
        const name = braced ?? bare ?? "";
        if (name === "0") return "$&";
        return /^\d+$/.test(name) ? `$${name}` : `$<${name}>`;
      }),
    )
    .join("$$");
  return input.replace(goRegExp(pattern, true), jsReplacement);
}

/** strings.Title: upper-cases the first letter of every word. */
export function goTitle(value: string): string {
  return value.replace(/(^|[^\p{L}\p{N}_])(\p{L})/gu, (_match, separator: string, letter: string) => separator + letter.toUpperCase());
}

/** strconv.Quote (close enough: JSON string escaping). */
export function goQuote(value: string): string {
  return JSON.stringify(value);
}

/** Go zero value (raymond's !IsTrue): nil, "", 0, false, empty array or object. */
export function isGoZero(value: unknown): boolean {
  if (value === undefined || value === null || value === false || value === "") return true;
  if (typeof value === "number") return value === 0 || Number.isNaN(value);
  if (Array.isArray(value)) return value.length === 0;
  if (value instanceof Date) return false;
  if (typeof value === "object") return Object.keys(value).length === 0;
  return false;
}

/** How raymond renders a value: nil → "", everything else via its string form. */
export function goString(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

interface TimeFields {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  ms: number;
  weekday: string;
  offsetMinutes: number;
  zoneName: string;
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function timeFields(date: Date, timeZone?: string): TimeFields {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      weekday: "long",
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  const second = Number(parts.second);
  const ms = date.getUTCMilliseconds();
  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute, second, ms);
  const zoneName =
    new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" })
      .formatToParts(date)
      .find((part) => part.type === "timeZoneName")?.value ?? "UTC";
  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    ms,
    weekday: String(parts.weekday),
    offsetMinutes: Math.round((wallAsUtc - date.getTime()) / 60000),
    zoneName,
  };
}

type Chunk = (fields: TimeFields) => string;

const pad = (value: number, width: number) => String(value).padStart(width, "0");
const hour12 = (fields: TimeFields) => fields.hour % 12 || 12;

function zone(options: { z: boolean; colon: boolean; minutes: boolean; seconds: boolean }): Chunk {
  return (fields) => {
    if (options.z && fields.offsetMinutes === 0) return "Z";
    const sign = fields.offsetMinutes < 0 ? "-" : "+";
    const abs = Math.abs(fields.offsetMinutes);
    const separator = options.colon ? ":" : "";
    let out = sign + pad(Math.floor(abs / 60), 2);
    if (options.minutes) out += separator + pad(abs % 60, 2);
    if (options.seconds) out += separator + "00";
    return out;
  };
}

// Order matters: at each position the first matching token wins (longer tokens first), as in Go's nextStdChunk.
const STD_CHUNKS: Array<[string, Chunk]> = [
  ["January", (f) => MONTHS[f.month - 1]!],
  ["Jan", (f) => MONTHS[f.month - 1]!.slice(0, 3)],
  ["Monday", (f) => f.weekday],
  ["Mon", (f) => f.weekday.slice(0, 3)],
  ["MST", (f) => f.zoneName],
  ["2006", (f) => pad(f.year, 4)],
  ["_2006", (f) => "_" + pad(f.year, 4)],
  ["_2", (f) => String(f.day).padStart(2, " ")],
  ["01", (f) => pad(f.month, 2)],
  ["02", (f) => pad(f.day, 2)],
  ["03", (f) => pad(hour12(f), 2)],
  ["04", (f) => pad(f.minute, 2)],
  ["05", (f) => pad(f.second, 2)],
  ["06", (f) => pad(f.year % 100, 2)],
  ["15", (f) => pad(f.hour, 2)],
  ["1", (f) => String(f.month)],
  ["2", (f) => String(f.day)],
  ["3", (f) => String(hour12(f))],
  ["4", (f) => String(f.minute)],
  ["5", (f) => String(f.second)],
  ["PM", (f) => (f.hour >= 12 ? "PM" : "AM")],
  ["pm", (f) => (f.hour >= 12 ? "pm" : "am")],
  ["-07:00:00", zone({ z: false, colon: true, minutes: true, seconds: true })],
  ["-070000", zone({ z: false, colon: false, minutes: true, seconds: true })],
  ["-07:00", zone({ z: false, colon: true, minutes: true, seconds: false })],
  ["-0700", zone({ z: false, colon: false, minutes: true, seconds: false })],
  ["-07", zone({ z: false, colon: false, minutes: false, seconds: false })],
  ["Z07:00:00", zone({ z: true, colon: true, minutes: true, seconds: true })],
  ["Z070000", zone({ z: true, colon: false, minutes: true, seconds: true })],
  ["Z07:00", zone({ z: true, colon: true, minutes: true, seconds: false })],
  ["Z0700", zone({ z: true, colon: false, minutes: true, seconds: false })],
  ["Z07", zone({ z: true, colon: false, minutes: false, seconds: false })],
];

const FRACTION = /^([.,])(0+|9+)(?![0-9])/;

/** time.Time.Format with a Go reference layout; timeZone is an IANA name, undefined = process local zone. */
export function goFormatTime(date: Date, layout: string, timeZone?: string): string {
  const fields = timeFields(date, timeZone);
  let out = "";
  let i = 0;
  scan: while (i < layout.length) {
    const rest = layout.slice(i);
    const fraction = FRACTION.exec(rest);
    if (fraction) {
      const [whole, separator, run] = fraction as unknown as [string, string, string];
      const digits = String(fields.ms).padStart(3, "0").padEnd(run.length, "0").slice(0, run.length);
      if (run[0] === "0") out += separator + digits;
      else if (digits.replace(/0+$/, "") !== "") out += separator + digits.replace(/0+$/, "");
      i += whole.length;
      continue;
    }
    for (const [token, chunk] of STD_CHUNKS) {
      if (rest.startsWith(token)) {
        out += chunk(fields);
        i += token.length;
        continue scan;
      }
    }
    out += layout[i];
    i++;
  }
  return out;
}
```

- [ ] **Step 4: Запустить тесты и typecheck**

Run: `npx vitest run test/golang.test.ts && npm run typecheck`
Expected: PASS (тесты с `Europe/Moscow` опираются на full ICU, который есть в Node 22).

- [ ] **Step 5: Commit**

```bash
git add src/helpers/golang.ts test/golang.test.ts
git commit -m "feat: Go-compatible primitives for template helpers" -m "<TRAILER>"
```

---

### Task 6: `helpers/drone.ts` — хелперы drone-template-lib

**Files:**
- Create: `src/helpers/drone.ts`
- Test: `test/helpers-drone.test.ts`

**Interfaces:**
- Consumes: всё из `src/helpers/golang.ts` (Task 5).
- Produces:
  - `plainHelper(fn: (...args: any[]) => unknown): (...raw: unknown[]) => unknown` — отрезает объект `options`, который Handlebars передаёт последним аргументом
  - `registerDroneHelpers(hb: typeof Handlebars, now: () => Date): void` — `duration`, `datetime`, `success`, `failure`, `truncate`, `urlencode`, `since`, `uppercasefirst`, `uppercase`, `lowercase`, `regexReplace`, `equal`

- [ ] **Step 1: Написать падающий тест** — `test/helpers-drone.test.ts`:

```ts
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
```

- [ ] **Step 2: Запустить — должен упасть**

Run: `npx vitest run test/helpers-drone.test.ts`
Expected: FAIL — модуля `src/helpers/drone.js` нет.

- [ ] **Step 3: Реализовать** — `src/helpers/drone.ts`:

```ts
import type Handlebars from "handlebars";
import {
  goDuration,
  goFormatTime,
  goQueryEscape,
  goRegexReplaceAll,
  goString,
  isGoZero,
  isValidTimeZone,
  toInt64,
} from "./golang.js";

type HandlebarsInstance = typeof Handlebars;
type HelperOptions = Handlebars.HelperOptions;

/** Handlebars passes an options object as the last argument; plain helpers never need it. */
export function plainHelper(fn: (...args: any[]) => unknown): (...raw: unknown[]) => unknown {
  return (...raw) => fn(...raw.slice(0, -1));
}

function statusBlock(matches: readonly string[]) {
  return function (this: unknown, conditional: unknown, options: HelperOptions): string {
    if (isGoZero(conditional)) return options.inverse(this);
    return matches.includes(goString(conditional)) ? options.fn(this) : options.inverse(this);
  };
}

/** Helpers of appleboy/drone-template-lib (template/helpers.go) plus raymond's built-in `equal`. */
export function registerDroneHelpers(hb: HandlebarsInstance, now: () => Date): void {
  hb.registerHelper({
    duration: plainHelper((started, finished) => goDuration(toInt64(finished) - toInt64(started))),
    datetime: plainHelper((timestamp, layout, zone) => {
      const tz = goString(zone);
      return goFormatTime(
        new Date(toInt64(timestamp) * 1000),
        goString(layout),
        tz !== "" && isValidTimeZone(tz) ? tz : undefined,
      );
    }),
    success: statusBlock(["success"]),
    failure: statusBlock(["failure", "error", "killed"]),
    truncate: plainHelper((value, length) => {
      const runes = Array.from(goString(value));
      const n = toInt64(length);
      if (runes.length <= Math.abs(n)) return runes.join("");
      return n < 0 ? runes.slice(-n).join("") : runes.slice(0, n).join("");
    }),
    urlencode: function (this: unknown, options: HelperOptions) {
      return goQueryEscape(options.fn(this));
    },
    since: plainHelper((start) => goDuration(Math.floor(now().getTime() / 1000) - toInt64(start))),
    uppercasefirst: plainHelper((value) => {
      const runes = Array.from(goString(value));
      if (runes.length === 0) return "";
      runes[0] = runes[0]!.toUpperCase();
      return runes.join("");
    }),
    uppercase: plainHelper((value) => goString(value).toUpperCase()),
    lowercase: plainHelper((value) => goString(value).toLowerCase()),
    regexReplace: plainHelper((pattern, input, replacement) =>
      goRegexReplaceAll(goString(pattern), goString(input), goString(replacement)),
    ),
    equal: function (this: unknown, a: unknown, b: unknown, options: HelperOptions) {
      return goString(a) === goString(b) ? options.fn(this) : options.inverse(this);
    },
  });
}
```

- [ ] **Step 4: Запустить тесты и typecheck**

Run: `npx vitest run test/helpers-drone.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/helpers/drone.ts test/helpers-drone.test.ts
git commit -m "feat: drone-template-lib helpers" -m "<TRAILER>"
```

---

### Task 7: `helpers/sprig.ts` — подмножество sprig

`div`/`sub`/`mod` из референсного `.drone.yml` живут здесь. Семантика int64: `div` усекает к нулю (`{{div 215 60}}` → `3`).

**Files:**
- Create: `src/helpers/sprig.ts`
- Test: `test/helpers-sprig.test.ts`

**Interfaces:**
- Consumes: `plainHelper` (Task 6), примитивы `golang.ts` (Task 5), `Env` (Task 1).
- Produces: `interface SprigDeps { now: () => Date; env: Env }`, `registerSprigHelpers(hb: typeof Handlebars, deps: SprigDeps): void` — ровно список §6.2; остальные имена не регистрируются (Handlebars бросает `Missing helper: "X"`, Task 9 превращает это в понятную ошибку).

- [ ] **Step 1: Написать падающий тест** — `test/helpers-sprig.test.ts`:

```ts
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
```

- [ ] **Step 2: Запустить — должен упасть**

Run: `npx vitest run test/helpers-sprig.test.ts`
Expected: FAIL — модуля `src/helpers/sprig.js` нет.

- [ ] **Step 3: Реализовать** — `src/helpers/sprig.ts`:

```ts
import type Handlebars from "handlebars";
import type { Env } from "../env.js";
import { plainHelper } from "./drone.js";
import {
  goDuration,
  goFormatTime,
  goQuote,
  goRegExp,
  goRegexReplaceAll,
  goString,
  goTitle,
  isGoZero,
  isValidTimeZone,
  toFloat64,
  toInt64,
} from "./golang.js";

type HandlebarsInstance = typeof Handlebars;

export interface SprigDeps {
  now: () => Date;
  env: Env;
}

/** sprig's date argument: time.Time, or unix seconds as a number; anything else means "now". */
function toDate(value: unknown, now: () => Date): Date {
  if (value instanceof Date) return value;
  if (typeof value === "number") return new Date(Math.trunc(value) * 1000);
  return now();
}

function trimCutset(value: string, cutset: string): string {
  const set = new Set(Array.from(cutset));
  const runes = Array.from(value);
  let start = 0;
  let end = runes.length;
  while (start < end && set.has(runes[start]!)) start++;
  while (end > start && set.has(runes[end - 1]!)) end--;
  return runes.slice(start, end).join("");
}

function indent(spaces: unknown, value: unknown): string {
  const pad = " ".repeat(Math.max(0, toInt64(spaces)));
  return pad + goString(value).replace(/\n/g, `\n${pad}`);
}

function nonNil(values: unknown[]): unknown[] {
  return values.filter((value) => value !== undefined && value !== null);
}

function divisor(value: unknown, name: string): number {
  const d = toInt64(value);
  if (d === 0) throw new Error(`${name}: integer divide by zero`);
  return d;
}

/**
 * Subset of Masterminds/sprig GenericFuncMap (spec §6.2). Argument order and int64 semantics follow sprig;
 * string slicing helpers work on runes instead of bytes so Cyrillic is never cut in half.
 */
export function registerSprigHelpers(hb: HandlebarsInstance, deps: SprigDeps): void {
  const helpers: Record<string, (...args: any[]) => unknown> = {
    // math: int64 results, division truncates toward zero
    add: (...values) => values.reduce((sum: number, value) => sum + toInt64(value), 0),
    add1: (value) => toInt64(value) + 1,
    sub: (a, b) => toInt64(a) - toInt64(b),
    mul: (a, ...values) => values.reduce((product: number, value) => product * toInt64(value), toInt64(a)),
    div: (a, b) => Math.trunc(toInt64(a) / divisor(b, "div")),
    mod: (a, b) => toInt64(a) % divisor(b, "mod"),
    max: (a, ...values) => values.reduce((m: number, value) => Math.max(m, toInt64(value)), toInt64(a)),
    min: (a, ...values) => values.reduce((m: number, value) => Math.min(m, toInt64(value)), toInt64(a)),
    floor: (value) => Math.floor(toFloat64(value)),
    ceil: (value) => Math.ceil(toFloat64(value)),
    round: (value, places, roundOn) => {
      const pow = 10 ** toInt64(places);
      const digit = pow * toFloat64(value);
      const fraction = digit - Math.trunc(digit);
      const threshold = roundOn === undefined ? 0.5 : toFloat64(roundOn);
      return (fraction >= threshold ? Math.ceil(digit) : Math.floor(digit)) / pow;
    },

    // strings
    trim: (s) => goString(s).trim(),
    trimAll: (cutset, s) => trimCutset(goString(s), goString(cutset)),
    trimPrefix: (prefix, s) => {
      const value = goString(s);
      const p = goString(prefix);
      return p !== "" && value.startsWith(p) ? value.slice(p.length) : value;
    },
    trimSuffix: (suffix, s) => {
      const value = goString(s);
      const x = goString(suffix);
      return x !== "" && value.endsWith(x) ? value.slice(0, -x.length) : value;
    },
    upper: (s) => goString(s).toUpperCase(),
    lower: (s) => goString(s).toLowerCase(),
    title: (s) => goTitle(goString(s)),
    replace: (from, to, s) => goString(s).split(goString(from)).join(goString(to)),
    contains: (substr, s) => goString(s).includes(goString(substr)),
    hasPrefix: (prefix, s) => goString(s).startsWith(goString(prefix)),
    hasSuffix: (suffix, s) => goString(s).endsWith(goString(suffix)),
    trunc: (count, s) => {
      const runes = Array.from(goString(s));
      const n = toInt64(count);
      if (n < 0 && runes.length + n > 0) return runes.slice(runes.length + n).join("");
      if (n >= 0 && runes.length > n) return runes.slice(0, n).join("");
      return runes.join("");
    },
    abbrev: (width, s) => {
      const runes = Array.from(goString(s));
      const w = toInt64(width);
      if (w < 4 || runes.length <= w) return runes.join("");
      return runes.slice(0, w - 3).join("") + "...";
    },
    substr: (start, end, s) => {
      const runes = Array.from(goString(s));
      const a = toInt64(start);
      const b = toInt64(end);
      if (a < 0) return runes.slice(0, b).join("");
      if (b < 0 || b > runes.length) return runes.slice(a).join("");
      return runes.slice(a, b).join("");
    },
    repeat: (count, s) => goString(s).repeat(Math.max(0, toInt64(count))),
    quote: (...values) => nonNil(values).map((value) => goQuote(goString(value))).join(" "),
    squote: (...values) => nonNil(values).map((value) => `'${goString(value)}'`).join(" "),
    nospace: (s) => goString(s).replace(/\s+/gu, ""),
    indent: (spaces, s) => indent(spaces, s),
    nindent: (spaces, s) => `\n${indent(spaces, s)}`,
    plural: (one, many, count) => (toInt64(count) === 1 ? goString(one) : goString(many)),
    cat: (...values) => nonNil(values).map(goString).join(" "),
    // explicit type: `toString` collides with Object.prototype and gets no contextual type
    toString: (value: unknown) => goString(value),
    atoi: (s) => toInt64(goString(s)),
    int: (value) => toInt64(value),
    int64: (value) => toInt64(value),

    // defaults
    default: (fallback, ...given) => (given.length === 0 || isGoZero(given[0]) ? fallback : given[0]),
    empty: (value) => isGoZero(value),
    coalesce: (...values) => values.find((value) => !isGoZero(value)),
    ternary: (whenTrue, whenFalse, condition) => (isGoZero(condition) ? whenFalse : whenTrue),

    // dates
    now: () => deps.now(),
    date: (layout, date) => goFormatTime(toDate(date, deps.now), goString(layout)),
    dateInZone: (layout, date, zone) => {
      const tz = goString(zone);
      return goFormatTime(toDate(date, deps.now), goString(layout), isValidTimeZone(tz) && tz !== "" ? tz : "UTC");
    },
    unixEpoch: (date) => String(Math.floor(toDate(date, deps.now).getTime() / 1000)),
    ago: (date) => goDuration(Math.round((deps.now().getTime() - toDate(date, deps.now).getTime()) / 1000)),

    // regex
    regexMatch: (pattern, s) => goRegExp(goString(pattern)).test(goString(s)),
    regexFind: (pattern, s) => goRegExp(goString(pattern)).exec(goString(s))?.[0] ?? "",
    regexReplaceAll: (pattern, s, replacement) => goRegexReplaceAll(goString(pattern), goString(s), goString(replacement)),

    // other
    b64enc: (s) => Buffer.from(goString(s), "utf8").toString("base64"),
    b64dec: (s) => Buffer.from(goString(s), "base64").toString("utf8"),
    env: (name) => deps.env[goString(name)] ?? "",
    expandenv: (s) =>
      goString(s).replace(/\$\{([^}]*)\}|\$([A-Za-z0-9_]+)/g, (_match, braced: string | undefined, bare: string | undefined) =>
        deps.env[braced ?? bare ?? ""] ?? "",
      ),
  };

  for (const [name, fn] of Object.entries(helpers)) hb.registerHelper(name, plainHelper(fn));
}
```

- [ ] **Step 4: Запустить тесты и typecheck**

Run: `npx vitest run test/helpers-sprig.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/helpers/sprig.ts test/helpers-sprig.test.ts
git commit -m "feat: sprig helper subset with int64 math semantics" -m "<TRAILER>"
```

---

### Task 8: `markdown.ts` и `format.ts` — разметка в entities

Порт tdlib `parse_markdown` (исходник: `td/telegram/MessageEntity.cpp`, функция `parse_markdown(string &text)`) с двумя отклонениями из §7.1. Готовых тест-кейсов у tdlib для легаси-парсера нет (`check_parse_markdown` в `td/test/message_entities.cpp` тестирует MarkdownV2) — кейсы ниже выведены из алгоритма; нормализация URL сверена с кейсами `[…](telegram.org)` из того же файла.

**Files:**
- Create: `src/markdown.ts`, `src/format.ts`
- Test: `test/markdown.test.ts`, `test/format.test.ts`

**Interfaces:**
- Consumes: `Format` (Task 2).
- Produces:
  - `type MdEntity` (`bold` | `italic` | `code` | `pre` с `language` | `text_url` с `url`; все с `offset`, `length` в UTF-16), `interface ParsedMarkdown { text: string; entities: MdEntity[] }`
  - `parseLegacyMarkdown(source: string): ParsedMarkdown`, `checkLink(raw: string): string | undefined`
  - `MAX_MESSAGE_LENGTH = 4096`, `interface FormattedMessage { text: string; entities: Api.TypeMessageEntity[] }`
  - `toApiEntity(entity: MdEntity): Api.TypeMessageEntity`, `formatMessage(source: string, format: Format): FormattedMessage` — бросает `message too long (N > 4096)`

- [ ] **Step 1: Написать падающие тесты**

`test/markdown.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { checkLink, type MdEntity, parseLegacyMarkdown } from "../src/markdown.js";

const cases: Array<[string, string, MdEntity[]]> = [
  // tdlib behaviour
  ["plain text", "plain text", []],
  ["", "", []],
  ["*bold*", "bold", [{ type: "bold", offset: 0, length: 4 }]],
  ["a _it_ b", "a it b", [{ type: "italic", offset: 2, length: 2 }]],
  ["`x`", "x", [{ type: "code", offset: 0, length: 1 }]],
  ["\\_\\*\\`\\[", "_*`[", []],
  ["\\a \\\\", "\\a \\\\", []],
  ["```js\nconst a\n```", "const a\n", [{ type: "pre", offset: 0, length: 8, language: "js" }]],
  ["```\nabc```", "abc", [{ type: "pre", offset: 0, length: 3, language: "" }]],
  ["``` update travis ```", " update travis ", [{ type: "pre", offset: 0, length: 15, language: "" }]],
  ["[text](http://example.com)", "text", [{ type: "text_url", offset: 0, length: 4, url: "http://example.com/" }]],
  ["[telegram.org]", "telegram.org", [{ type: "text_url", offset: 0, length: 12, url: "http://telegram.org/" }]],
  ["[telegram.org]a", "telegram.orga", [{ type: "text_url", offset: 0, length: 12, url: "http://telegram.org/" }]],
  ["[ ](telegram.org)", " ", [{ type: "text_url", offset: 0, length: 1, url: "http://telegram.org/" }]],
  ["[ ](as)", " ", []],
  ["[](telegram.org)", "", []],
  ["[x](https://telegram.dog?)", "x", [{ type: "text_url", offset: 0, length: 1, url: "https://telegram.dog/?" }]],
  ["**", "", []],
  ["*a\\*b*", "a\\b*", [{ type: "bold", offset: 0, length: 2 }]],
  ["[a](http://x.org", "a", [{ type: "text_url", offset: 0, length: 1, url: "http://x.org/" }]],
  ["_a_ *b* `c`", "a b c", [
    { type: "italic", offset: 0, length: 1 },
    { type: "bold", offset: 2, length: 1 },
    { type: "code", offset: 4, length: 1 },
  ]],
  // UTF-16 offsets
  ["🏟 *🏟*", "🏟 🏟", [{ type: "bold", offset: 3, length: 2 }]],
  ["Сборка *ok*", "Сборка ok", [{ type: "bold", offset: 7, length: 2 }]],
  // deviation 1: \_ is "_" inside entities and URLs
  ["[fix\\_login](https://x.org/a\\_b)", "fix_login", [{ type: "text_url", offset: 0, length: 9, url: "https://x.org/a_b" }]],
  ["``` fix\\_login ```", " fix_login ", [{ type: "pre", offset: 0, length: 11, language: "" }]],
  ["*snake\\_case*", "snake_case", [{ type: "bold", offset: 0, length: 10 }]],
  ["`a\\_b`", "a_b", [{ type: "code", offset: 0, length: 3 }]],
  // deviation 2: unclosed entities stay as text
  ["2*3", "2*3", []],
  ["```abc", "```abc", []],
  ["```js\ncode", "```js\ncode", []],
  ["[abc", "[abc", []],
  ["a_b *c*", "a_b c", [{ type: "bold", offset: 4, length: 1 }]],
];

describe("parseLegacyMarkdown", () => {
  it.each(cases)("%j", (source, text, entities) => {
    expect(parseLegacyMarkdown(source)).toEqual({ text, entities });
  });
});

describe("checkLink", () => {
  it.each([
    ["telegram.org", "http://telegram.org/"],
    ["localhost:8080", "http://localhost:8080/"],
    ["mailto:a@b.io", "mailto:a@b.io"],
    ["tg://resolve?domain=x", "tg://resolve?domain=x"],
    ["javascript:alert(1)", undefined],
    ["as", undefined],
    ["", undefined],
  ])("%s → %s", (input, expected) => {
    expect(checkLink(input)).toBe(expected);
  });
});
```

`test/format.test.ts`:
```ts
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
```

- [ ] **Step 2: Запустить — должны упасть**

Run: `npx vitest run test/markdown.test.ts test/format.test.ts`
Expected: FAIL — модулей нет.

- [ ] **Step 3: Реализовать**

`src/markdown.ts`:
```ts
// Port of tdlib's legacy `parse_markdown` (td/telegram/MessageEntity.cpp) — the parser behind Bot API
// parse_mode=Markdown. Two deliberate deviations (spec §7.1):
//  1. `\_` is a literal `_` everywhere, including inside entities and URLs (tdlib only unescapes outside).
//  2. An unclosed entity keeps its opening delimiter as text instead of failing the whole message.

export type MdEntity =
  | { type: "bold" | "italic" | "code"; offset: number; length: number }
  | { type: "pre"; offset: number; length: number; language: string }
  | { type: "text_url"; offset: number; length: number; url: string };

export interface ParsedMarkdown {
  text: string;
  entities: MdEntity[];
}

const DELIMITERS = new Set(["_", "*", "`", "["]);

// td::is_space; `undefined` stands for the terminating '\0' tdlib reads past the end.
function isSpace(ch: string | undefined): boolean {
  if (ch === undefined) return true;
  const code = ch.charCodeAt(0);
  return ch === " " || ch === "\t" || ch === "\r" || ch === "\n" || code === 11 || code === 0;
}

/** Offsets and lengths are UTF-16 code units, which is what JS string indices already are. */
export function parseLegacyMarkdown(source: string): ParsedMarkdown {
  const size = source.length;
  const entities: MdEntity[] = [];
  let text = "";
  let i = 0;

  while (i < size) {
    const ch = source[i]!;
    if (ch === "\\" && DELIMITERS.has(source[i + 1] ?? "")) {
      text += source[i + 1];
      i += 2;
      continue;
    }
    if (!DELIMITERS.has(ch)) {
      text += ch;
      i++;
      continue;
    }

    // entity start
    const begin = i;
    const endChar = ch === "[" ? "]" : ch;
    let j = i + 1;
    let isPre = false;
    let language = "";
    if (ch === "`" && source[j] === "`" && source[j + 1] === "`") {
      j += 2;
      isPre = true;
      let languageEnd = j;
      while (!isSpace(source[languageEnd]) && source[languageEnd] !== "`") languageEnd++;
      if (j !== languageEnd && languageEnd < size && source[languageEnd] !== "`") {
        language = source.slice(j, languageEnd);
        j = languageEnd;
      }
      // skip one new line in the beginning of the text
      if (source[j] === "\n" || source[j] === "\r") {
        if ((source[j + 1] === "\n" || source[j + 1] === "\r") && source[j] !== source[j + 1]) j += 2;
        else j++;
      }
    }

    const bodyStart = j;
    let body = "";
    while (j < size && (source[j] !== endChar || (isPre && !(source[j + 1] === "`" && source[j + 2] === "`")))) {
      if (source[j] === "\\" && source[j + 1] === "_") {
        body += "_"; // deviation 1
        j += 2;
        continue;
      }
      body += source[j];
      j++;
    }
    if (j >= size) {
      text += source.slice(begin, bodyStart); // deviation 2
      i = bodyStart;
      continue;
    }

    const offset = text.length;
    text += body;
    let url = body; // `[url]` without `(…)` uses the text as URL
    if (ch === "[" && source[j + 1] === "(") {
      j += 2;
      url = "";
      while (j < size && source[j] !== ")") {
        if (source[j] === "\\" && source[j + 1] === "_") {
          url += "_"; // deviation 1
          j += 2;
          continue;
        }
        url += source[j];
        j++;
      }
    }

    if (body.length > 0) {
      const length = body.length;
      if (ch === "_") entities.push({ type: "italic", offset, length });
      else if (ch === "*") entities.push({ type: "bold", offset, length });
      else if (ch === "`") entities.push(isPre ? { type: "pre", offset, length, language } : { type: "code", offset, length });
      else {
        const checked = checkLink(url);
        if (checked !== undefined) entities.push({ type: "text_url", offset, length, url: checked });
      }
    }
    i = j + (isPre ? 3 : 1);
  }

  return { text, entities };
}

/** Approximates tdlib get_checked_link: default scheme http, web links need a dotted host (or localhost). */
export function checkLink(raw: string): string | undefined {
  const value = raw.trim();
  if (value === "") return undefined;
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) || /^(tg|ton|mailto):/i.test(value);
  let url: URL;
  try {
    url = new URL(hasScheme ? value : `http://${value}`);
  } catch {
    return undefined;
  }
  switch (url.protocol) {
    case "http:":
    case "https:":
      return url.hostname.includes(".") || url.hostname === "localhost" ? url.href : undefined;
    case "tg:":
    case "ton:":
    case "mailto:":
      return value;
    default:
      return undefined;
  }
}
```

`src/format.ts`:
```ts
import { Api } from "teleproto";
import { HTMLParser } from "teleproto/extensions/html.js";
import type { Format } from "./config.js";
import { type MdEntity, parseLegacyMarkdown } from "./markdown.js";

export const MAX_MESSAGE_LENGTH = 4096;

export interface FormattedMessage {
  text: string;
  entities: Api.TypeMessageEntity[];
}

export function toApiEntity(entity: MdEntity): Api.TypeMessageEntity {
  const { offset, length } = entity;
  switch (entity.type) {
    case "bold":
      return new Api.MessageEntityBold({ offset, length });
    case "italic":
      return new Api.MessageEntityItalic({ offset, length });
    case "code":
      return new Api.MessageEntityCode({ offset, length });
    case "pre":
      return new Api.MessageEntityPre({ offset, length, language: entity.language });
    case "text_url":
      return new Api.MessageEntityTextUrl({ offset, length, url: entity.url });
  }
}

/** MTProto has no server-side parse_mode: turn markup into plain text + entities here (spec §7). */
export function formatMessage(source: string, format: Format): FormattedMessage {
  let result: FormattedMessage;
  if (format === "html") {
    const [text, entities] = HTMLParser.parse(source);
    result = { text, entities };
  } else {
    const parsed = parseLegacyMarkdown(source);
    result = { text: parsed.text, entities: parsed.entities.map(toApiEntity) };
  }
  if (result.text.length > MAX_MESSAGE_LENGTH) {
    throw new Error(`message too long (${result.text.length} > ${MAX_MESSAGE_LENGTH})`);
  }
  return result;
}
```

- [ ] **Step 4: Запустить тесты и typecheck**

Run: `npx vitest run test/markdown.test.ts test/format.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/markdown.ts src/format.ts test/markdown.test.ts test/format.test.ts
git commit -m "feat: legacy Bot API markdown parser and entity formatting" -m "<TRAILER>"
```

---

### Task 9: `template.ts` — пайплайн рендера

Шаги 1–5 §6.3, сообщения по умолчанию §6.5, контекст с двойными ключами §6.1. Тест прогоняет три шаблона из референсного `.drone.yml` через `renderMessage` + `formatMessage` и сверяет итоговый текст и ссылки.

**Files:**
- Create: `src/template.ts`
- Test: `test/template.test.ts`

**Interfaces:**
- Consumes: `CiContext`, `loadCiContext` (Task 3); `Config`, `Format` (Task 2); `ConfigError`, `Env` (Task 1); `registerDroneHelpers` (Task 6); `registerSprigHelpers` (Task 7); в тестах `formatMessage` (Task 8).
- Produces:
  - `interface RenderDeps { env: Env; now: () => Date; readText: (path: string) => Promise<string>; fetchText: (url: string) => Promise<string> }`, `defaultRenderDeps(env: Env): RenderDeps`
  - `type TemplateSettings = Pick<Config, "message" | "messageFile" | "templateVars" | "templateVarsFile" | "format">`
  - `interface RenderedMessage { text: string; format: Format }` — пустой `text` значит «отправлять нечего»
  - `defaultMessage(ci: CiContext): string`, `escapeMarkdownOne(value: string): string`, `escapeOutsideMustaches(template: string): string`
  - `buildTemplateContext(ci: CiContext, tpl: Record<string, string>): Record<string, unknown>`
  - `renderMessage(settings: TemplateSettings, ci: CiContext, deps: RenderDeps): Promise<RenderedMessage>` — ошибки шаблона/файлов — `ConfigError`

- [ ] **Step 1: Написать падающий тест** — `test/template.test.ts`:

```ts
import type { Api } from "teleproto";
import { describe, expect, it } from "vitest";
import { type CiContext, loadCiContext } from "../src/ci-context.js";
import type { Format } from "../src/config.js";
import { formatMessage } from "../src/format.js";
import {
  defaultMessage,
  escapeMarkdownOne,
  escapeOutsideMustaches,
  type RenderDeps,
  renderMessage,
  type TemplateSettings,
} from "../src/template.js";

const droneEnv = {
  DRONE_REPO: "org/web_app",
  DRONE_REPO_OWNER: "org",
  DRONE_REPO_NAME: "web_app",
  DRONE_COMMIT_BRANCH: "dev",
  DRONE_COMMIT_LINK: "https://git.example.com/org/web_app/commit/abc",
  DRONE_COMMIT_AUTHOR: "ivan",
  DRONE_COMMIT_MESSAGE: "fix_login *urgent*",
  DRONE_BUILD_NUMBER: "42",
  DRONE_BUILD_STATUS: "success",
  DRONE_BUILD_LINK: "https://drone.example.com/org/web_app/42",
  DRONE_STAGE_STARTED: "1000",
  DRONE_BUILD_FINISHED: "1215",
};
const ci = loadCiContext(droneEnv);

const files: Record<string, string> = {
  "msg.tpl": "from file {{build.number}}",
  "/tmp/t.tpl": "file {{build.number}}",
  "vars.json": '{"env":"stage"}',
};
const deps: RenderDeps = {
  env: droneEnv,
  now: () => new Date(1700000100 * 1000),
  readText: async (path) => {
    const content = files[path];
    if (content === undefined) throw new Error(`ENOENT: ${path}`);
    return content;
  },
  fetchText: async (url) => `remote {{repo.name}} from ${url}`,
};
const settings = (overrides: Partial<TemplateSettings> = {}): TemplateSettings => ({ format: "markdown", ...overrides });
const render = async (message: string, format: Format = "markdown", context: CiContext = ci) =>
  (await renderMessage(settings({ message, format }), context, deps)).text;

// Values from drone-telegram plugin_test.go TestDefaultMessageFormat / TestDefaultMessageFormatFromGitHub
const goTestCi: CiContext = {
  isActions: false,
  repo: { FullName: "appleboy/go-hello", Name: "go-hello", Namespace: "appleboy" },
  commit: {
    Sha: "e7c4f0a63ceeb42a39ac7806f7b51f3f0d204fd2",
    Ref: "",
    Branch: "master",
    Link: "",
    Author: "Bo-Yi Wu",
    Avatar: "",
    Email: "",
    Message: "update travis",
  },
  build: {
    Tag: "",
    Event: "push",
    Number: 101,
    Status: "success",
    Link: "https://github.com/appleboy/go-hello",
    Started: 0,
    Finished: 0,
    PR: "",
    DeployTo: "",
  },
  gitHub: { Workflow: "test-workflow", Workspace: "", Action: "send notification", EventName: "push", EventPath: "" },
};

describe("escaping", () => {
  it.each([
    ["user", "user"],
    ["user_name", "user\\_name"],
    ["user_name_long", "user\\_name\\_long"],
    ["user\\_name\\_escaped", "user\\_name\\_escaped"],
  ])("escapeMarkdownOne(%s)", (input, expected) => {
    expect(escapeMarkdownOne(input)).toBe(expected);
  });
  it("leaves mustaches alone", () => {
    expect(escapeOutsideMustaches("a_b {{tpl.x_y}} c_d")).toBe("a\\_b {{tpl.x_y}} c\\_d");
  });
});

describe("defaultMessage", () => {
  it("matches drone-telegram for Drone", () => {
    expect(defaultMessage(goTestCi)).toBe(
      "✅ Build #101 of `appleboy/go-hello` success.\n\n📝 Commit by Bo-Yi Wu on `master`:\n``` update travis ```\n\n🌐 https://github.com/appleboy/go-hello",
    );
  });
  it("matches drone-telegram for Actions", () => {
    expect(defaultMessage({ ...goTestCi, isActions: true })).toBe("appleboy/go-hello/test-workflow triggered by appleboy (push)");
  });
  it("is rendered as markdown even when html is configured, with readable underscores", async () => {
    const rendered = await renderMessage(settings({ format: "html" }), ci, deps);
    expect(rendered.format).toBe("markdown");
    const message = formatMessage(rendered.text, rendered.format);
    expect(message.text).toBe(
      "✅ Build #42 of org/web_app success.\n\n📝 Commit by ivan on dev:\n fix_login *urgent* \n\n🌐 https://drone.example.com/org/web_app/42",
    );
    expect(message.entities.map((e) => e.className)).toEqual(["MessageEntityCode", "MessageEntityCode", "MessageEntityPre"]);
  });
});

// The three notify templates of the reference .drone.yml, verbatim (YAML `|` keeps the trailing newline).
const reference = {
  prepare:
    "🚀 Сборка [#{{build.number}}]({{build.link}}) запущена\n○ Репозиторий: {{repo.name}}\n○ Ветка: {{commit.branch}}\n○ Коммит: [{{commit.message}}]({{commit.link}})\n○ Инициатор: {{commit.author}}\n",
  success:
    "✅ Сборка [#{{build.number}}]({{build.link}}) прошла успешно\n○ Репозиторий: {{repo.name}}\n○ Ветка: {{commit.branch}}\n○ Коммит: [{{commit.message}}]({{commit.link}})\n○ Инициатор: {{commit.author}}\n○ Время сборки: {{ div (sub build.finished build.started) 60 }} минут {{ mod (sub build.finished build.started) 60 }} секунд\n",
  failure:
    "❌ Сборка [#{{build.number}}]({{build.link}}) завершилось с ошибкой\n○ Репозиторий: {{repo.name}}\n○ Ветка: {{commit.branch}}\n○ Коммит: [{{commit.message}}]({{commit.link}})\n○ Инициатор: {{commit.author}}\n○ Время сборки: {{ div (sub build.finished build.started) 60 }} минут {{ mod (sub build.finished build.started) 60 }} секунд\n",
};
const tail = "○ Репозиторий: web_app\n○ Ветка: dev\n○ Коммит: fix_login *urgent*\n○ Инициатор: ivan";
const time = "\n○ Время сборки: 3 минут 35 секунд";

describe("reference .drone.yml templates", () => {
  it.each([
    ["prepare", `🚀 Сборка #42 запущена\n${tail}`],
    ["success", `✅ Сборка #42 прошла успешно\n${tail}${time}`],
    ["failure", `❌ Сборка #42 завершилось с ошибкой\n${tail}${time}`],
  ] as const)("%s", async (name, expectedText) => {
    const message = formatMessage(await render(reference[name]), "markdown");
    expect(message.text).toBe(expectedText);
    const links = message.entities.map((e) => {
      const link = e as Api.MessageEntityTextUrl;
      return [link.className, link.offset, link.length, link.url];
    });
    expect(links).toEqual([
      ["MessageEntityTextUrl", expectedText.indexOf("#42"), 3, "https://drone.example.com/org/web_app/42"],
      ["MessageEntityTextUrl", expectedText.indexOf("fix_login"), 18, "https://git.example.com/org/web_app/commit/abc"],
    ]);
  });
});

describe("renderMessage", () => {
  it("resolves fields like raymond, with the github alias and without config", async () => {
    const context = loadCiContext({ ...droneEnv, GITHUB_WORKFLOW: "ci", DRONE_PULL_REQUEST: "7" });
    const tpl = "{{repo.FullName}}|{{repo.fullName}}|{{repo.fullname}}|{{github.workflow}}|{{gitHub.Workflow}}|{{config.token}}|{{build.PR}}";
    expect(await render(tpl, "html", context)).toBe("org/web_app|org/web_app||ci|ci||7");
  });

  it("escapes underscores in markdown outside mustaches and in CI fields", async () => {
    expect(await render("a_b {{commit.message}}")).toBe("a\\_b fix\\_login *urgent*");
  });

  it("merges template vars, file values win", async () => {
    const rendered = await renderMessage(
      settings({ message: "{{tpl.env}} {{tpl.x_y}}", templateVars: '{"env":"prod","x_y":"1"}', templateVarsFile: "vars.json" }),
      ci,
      deps,
    );
    expect(rendered.text).toBe("stage 1");
  });

  it("validates template vars", async () => {
    await expect(renderMessage(settings({ message: "x", templateVars: '{"a":1}' }), ci, deps)).rejects.toThrow(
      "template_vars must be a JSON object with string values",
    );
    await expect(renderMessage(settings({ message: "x", templateVars: "{" }), ci, deps)).rejects.toThrow("unable to parse template_vars");
    await expect(renderMessage(settings({ message: "x", templateVarsFile: "nope.json" }), ci, deps)).rejects.toThrow(
      "unable to read file with template vars 'nope.json'",
    );
  });

  it("reads message_file", async () => {
    expect((await renderMessage(settings({ messageFile: "msg.tpl", message: "ignored" }), ci, deps)).text).toBe("from file 42");
    await expect(renderMessage(settings({ messageFile: "nope.tpl" }), ci, deps)).rejects.toThrow("error loading message file 'nope.tpl'");
  });

  it("loads templates given as a URL", async () => {
    expect(await render("https://example.com/t.tpl", "html")).toBe("remote web_app from https://example.com/t.tpl");
    expect(await render("file:///tmp/t.tpl", "html")).toBe("file 42");
  });

  it("round-trips HTML escaping like render + html.UnescapeString", async () => {
    const context = loadCiContext({ ...droneEnv, DRONE_COMMIT_MESSAGE: "a &amp; b <c>" });
    expect(await render("{{commit.message}}", "html", context)).toBe("a &amp; b <c>");
  });

  it("trims the template and the result", async () => {
    expect(await render("\n\n  hi {{build.number}}  \n")).toBe("hi 42");
    expect(await render("{{tpl.none}}")).toBe("");
  });

  it("reports unsupported helpers", async () => {
    await expect(render("{{semver 1}}")).rejects.toThrow('helper "semver" is not supported (sprig subset, see README)');
  });
});
```

- [ ] **Step 2: Запустить — должен упасть**

Run: `npx vitest run test/template.test.ts`
Expected: FAIL — модуля `src/template.js` нет.

- [ ] **Step 3: Реализовать** — `src/template.ts`:

```ts
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

export function defaultRenderDeps(env: Env): RenderDeps {
  return {
    env,
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
```

- [ ] **Step 4: Запустить тесты и typecheck**

Run: `npx vitest run test/template.test.ts && npm run typecheck`
Expected: PASS, включая `reference .drone.yml templates` (3 шаблона, время сборки «3 минут 35 секунд», `_` без обратных слэшей).

- [ ] **Step 5: Commit**

```bash
git add src/template.ts test/template.test.ts
git commit -m "feat: drone-telegram compatible template rendering" -m "<TRAILER>"
```

---

### Task 10: `telegram.ts` — ожидание прокси и клиент teleproto

`waitForPort`, `toPeer`, `createDeadline` покрыты unit-тестами (локальный TCP-сервер, без Telegram). `connectBot` проверяется спайком (Task 0) и e2e (Task 13). Решения, сверенные с исходниками teleproto 1.229.0: `proxy.ip` — это адрес для `net.connect`, поэтому имя сервиса резолвится через `dns.lookup` заранее; `start({botAuthToken})` не логинится повторно при валидной `session` (`client/auth.ts:135`); `replyTo: threadId` превращается в `InputReplyToMessage{replyToMsgId}` — так пишут в тему форума (`client/uploads.ts:382`); числовой id → `number`, тогда `getInputEntity` сам делает `users.getUsers`/`channels.getChannels` с `accessHash = 0` (`client/users.ts:555`).

**Files:**
- Create: `src/telegram.ts`
- Test: `test/telegram.test.ts`

**Interfaces:**
- Consumes: `Config` (Task 2), `FormattedMessage` (Task 8).
- Produces:
  - `interface Deadline { readonly timeoutSec: number; remainingMs(): number }`, `createDeadline(timeoutSec: number, now?: () => number): Deadline`
  - `interface SendOptions { linkPreview: boolean; silent: boolean; threadId?: number }`
  - `interface TelegramGateway { sendText(peer: string, message: FormattedMessage, options: SendOptions): Promise<number>; exportSession(): string; close(): Promise<void> }`
  - `waitForPort(host: string, port: number, deadline: Deadline): Promise<void>` — ошибка `proxy <host>:<port> is not reachable after <N>s`
  - `toPeer(id: string): string | number`
  - `connectBot(config: Config, deadline: Deadline): Promise<TelegramGateway>`

- [ ] **Step 1: Написать падающий тест** — `test/telegram.test.ts`:

```ts
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
```

- [ ] **Step 2: Запустить — должен упасть**

Run: `npx vitest run test/telegram.test.ts`
Expected: FAIL — модуля `src/telegram.js` нет.

- [ ] **Step 3: Реализовать** — `src/telegram.ts`:

```ts
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
```

- [ ] **Step 4: Запустить тесты и typecheck**

Run: `npx vitest run test/telegram.test.ts && npm run typecheck`
Expected: PASS (тесты `waitForPort` занимают ~3 с).

- [ ] **Step 5: Commit**

```bash
git add src/telegram.ts test/telegram.test.ts
git commit -m "feat: proxy readiness wait and teleproto bot gateway" -m "<TRAILER>"
```

---

### Task 11: `main.ts` — оркестрация и точка входа

`run()` получает все побочные эффекты через `MainDeps`, поэтому тестируется с фейковым gateway. Порядок: конфиг → рендер и разметка (ошибки шаблона — до сети) → получатели → ожидание прокси → логин → отправка. Общий дедлайн `timeout` срабатывает на 1 с позже, чтобы сообщения этапов (`proxy … is not reachable`) успевали выиграть гонку.

**Files:**
- Create: `src/main.ts`
- Test: `test/main.test.ts`

**Interfaces:**
- Consumes: всё из Tasks 1–10.
- Produces:
  - `interface MainDeps { env: Env; stdout: (line: string) => void; stderr: (line: string) => void; connect: (config: Config, deadline: Deadline) => Promise<TelegramGateway>; waitForPort: (host: string, port: number, deadline: Deadline) => Promise<void>; renderDeps: RenderDeps }`
  - `describeError(error: unknown): string`
  - `run(argv: readonly string[], deps: MainDeps): Promise<number>` — код выхода; `argv[0]`: нет/`send` → отправка, `session` → печать StringSession
  - точка входа `dist/main.js` (выполняется только при прямом запуске)

- [ ] **Step 1: Написать падающий тест** — `test/main.test.ts`:

```ts
import { errors } from "teleproto";
import { describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.js";
import type { FormattedMessage } from "../src/format.js";
import { describeError, type MainDeps, run } from "../src/main.js";
import type { SendOptions, TelegramGateway } from "../src/telegram.js";

const HEX = "0123456789abcdef0123456789abcdef";
const baseEnv = {
  PLUGIN_TOKEN: "123:SECRET",
  PLUGIN_TO: "1,@team",
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
      { peer: "@team", text: "hi 42", options: { linkPreview: true, silent: false, threadId: undefined } },
    ]);
    expect(out).toEqual(["sent to 1 (message id 1)", "sent to @team (message id 2)"]);
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
    expect(out).toEqual(["sent to @team (message id 7)"]);
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
    expect(describeError(flood)).toContain('"session"');
  });
  it("uses the message of other errors", () => {
    expect(describeError(new Error("boom"))).toBe("boom");
    expect(describeError("text")).toBe("text");
  });
});
```

- [ ] **Step 2: Запустить — должен упасть**

Run: `npx vitest run test/main.test.ts`
Expected: FAIL — модуля `src/main.js` нет.

- [ ] **Step 3: Реализовать** — `src/main.ts`:

```ts
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
```

- [ ] **Step 4: Запустить все тесты, typecheck, сборку и smoke**

```bash
npm test && npm run typecheck && npm run build
env -i PATH="$PATH" node dist/main.js; echo "exit=$?"
env -i PATH="$PATH" PLUGIN_TOKEN=1:x PLUGIN_TO=1 PLUGIN_API_ID=1 PLUGIN_API_HASH=hhhh PLUGIN_PHOTO=a.png node dist/main.js; echo "exit=$?"
```
Expected: все тесты PASS; затем `error: missing required settings: token, to, api_id, api_hash` / `exit=1` и `error: PLUGIN_PHOTO is not supported: drone-telegram-mtproto v1 sends text messages only` / `exit=1`.

- [ ] **Step 5: Commit**

```bash
git add src/main.ts test/main.test.ts
git commit -m "feat: orchestrate send and session modes with deadline and redaction" -m "<TRAILER>"
```

---

### Task 12: Docker-образ, примеры и README

**Files:**
- Create: `Dockerfile`, `.dockerignore`, `examples/drone.yml`, `examples/gitea.yml`, `README.md`

**Interfaces:**
- Consumes: `npm run build` → `dist/main.js` (Task 11).
- Produces: образ с `ENTRYPOINT ["node", "/app/dist/main.js"]`, пользователь `node`.

- [ ] **Step 1: Написать `Dockerfile`**

```dockerfile
# syntax=docker/dockerfile:1.7

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER node
ENTRYPOINT ["node", "/app/dist/main.js"]
```

`.dockerignore`:
```
node_modules
dist
.git
docs
test
e2e
examples
.drone.yml
*.md
```

- [ ] **Step 2: Собрать и проверить образ**

```bash
docker build -t drone-telegram-mtproto:dev .
docker run --rm drone-telegram-mtproto:dev; echo "exit=$?"
docker run --rm -e PLUGIN_TOKEN=1:x -e PLUGIN_TO=1 -e PLUGIN_API_ID=1 -e PLUGIN_API_HASH=hhhh -e PLUGIN_MESSAGE=hi \
  -e PLUGIN_PROXY_HOST=127.0.0.1 -e PLUGIN_PROXY_SECRET=0123456789abcdef0123456789abcdef -e PLUGIN_TIMEOUT=2 \
  drone-telegram-mtproto:dev; echo "exit=$?"
docker run --rm --entrypoint id drone-telegram-mtproto:dev
```
Expected: `error: missing required settings: token, to, api_id, api_hash` / `exit=1`; `error: proxy 127.0.0.1:1443 is not reachable after 2s` / `exit=1`; `uid=1000(node)`. Размер образа ~180 MB.

Если `npm run build` в образе падает с `sh: tsc: not found` — `package-lock.json` сгенерирован не из реального `node_modules` (например, при симлинке): пересоздать его `rm -rf node_modules package-lock.json && npm i`.

- [ ] **Step 3: Примеры** — `examples/drone.yml` (миграция референсного пайплайна; обратите внимание на слияние именно карты `settings`):

```yaml
# Notify steps of a Drone pipeline migrated from appleboy/drone-telegram to drone-telegram-mtproto.
# Secrets: TG_BOT_TOKEN, TG_BOT_CHATID, TG_API_ID, TG_API_HASH (my.telegram.org),
#          TG_PROXY_SECRET (32 hex chars: `openssl rand -hex 16`).
kind: pipeline
type: docker
name: Frontend CI/CD

trigger:
  event:
    - push
  branch:
    - dev

# tg-ws-proxy runs next to the steps for the whole pipeline and is reachable by its name.
services:
  - name: tg-ws-proxy
    image: registry.example.com/tg-ws-proxy:latest
    environment:
      TG_WS_PROXY_SECRET:
        from_secret: TG_PROXY_SECRET

# Merge only the settings map: `<<:` is shallow, so a step-level `settings:` would replace
# a whole merged step template including token and to.
tg-settings: &tg-settings
  token:
    from_secret: TG_BOT_TOKEN
  to:
    from_secret: TG_BOT_CHATID
  api_id:
    from_secret: TG_API_ID
  api_hash:
    from_secret: TG_API_HASH
  proxy_host: tg-ws-proxy
  proxy_secret:
    from_secret: TG_PROXY_SECRET

steps:
  - name: notify-prepare
    image: registry.example.com/drone-telegram-mtproto:1
    failure: ignore
    settings:
      <<: *tg-settings
      message: |
        🚀 Сборка [#{{build.number}}]({{build.link}}) запущена
        ○ Репозиторий: {{repo.name}}
        ○ Ветка: {{commit.branch}}
        ○ Коммит: [{{commit.message}}]({{commit.link}})
        ○ Инициатор: {{commit.author}}

  - name: build
    image: node:22-alpine
    commands:
      - npm ci
      - npm run build

  - name: notify-build-success
    image: registry.example.com/drone-telegram-mtproto:1
    failure: ignore
    depends_on:
      - build
    when:
      status: [success]
    settings:
      <<: *tg-settings
      message: |
        ✅ Сборка [#{{build.number}}]({{build.link}}) прошла успешно
        ○ Репозиторий: {{repo.name}}
        ○ Ветка: {{commit.branch}}
        ○ Коммит: [{{commit.message}}]({{commit.link}})
        ○ Инициатор: {{commit.author}}
        ○ Время сборки: {{ div (sub build.finished build.started) 60 }} минут {{ mod (sub build.finished build.started) 60 }} секунд

  - name: notify-build-failure
    image: registry.example.com/drone-telegram-mtproto:1
    failure: ignore
    depends_on:
      - build
    when:
      status: [failure]
    settings:
      <<: *tg-settings
      message: |
        ❌ Сборка [#{{build.number}}]({{build.link}}) завершилась с ошибкой
        ○ Репозиторий: {{repo.name}}
        ○ Ветка: {{commit.branch}}
        ○ Коммит: [{{commit.message}}]({{commit.link}})
        ○ Инициатор: {{commit.author}}
        ○ Время сборки: {{ div (sub build.finished build.started) 60 }} минут {{ mod (sub build.finished build.started) 60 }} секунд
```

`examples/gitea.yml`:
```yaml
# Gitea/Forgejo Actions: .gitea/workflows/build.yml (or .forgejo/workflows/build.yml).
# Secrets: TG_BOT_TOKEN, TG_BOT_CHATID, TG_API_ID, TG_API_HASH, TG_PROXY_SECRET.
name: build

on:
  push:

jobs:
  build:
    runs-on: ubuntu-latest
    services:
      tg-ws-proxy:
        image: registry.example.com/tg-ws-proxy:latest
        env:
          TG_WS_PROXY_SECRET: ${{ secrets.TG_PROXY_SECRET }}
    steps:
      - uses: actions/checkout@v4

      - name: build
        run: npm ci && npm run build

      - name: notify
        if: always()
        uses: docker://registry.example.com/drone-telegram-mtproto:1
        with:
          token: ${{ secrets.TG_BOT_TOKEN }}
          to: ${{ secrets.TG_BOT_CHATID }}
          api_id: ${{ secrets.TG_API_ID }}
          api_hash: ${{ secrets.TG_API_HASH }}
          proxy_host: tg-ws-proxy
          proxy_secret: ${{ secrets.TG_PROXY_SECRET }}
          template_vars: '{"status": "${{ job.status }}"}'
          message: |
            {{#success tpl.status}}✅{{else}}❌{{/success}} [{{repo.fullName}} #{{build.number}}]({{build.link}}): {{tpl.status}}
            ○ Ветка: {{commit.branch}}
            ○ Коммит: [{{commit.sha}}]({{commit.link}})
            ○ Инициатор: {{repo.namespace}}
```

- [ ] **Step 4: README** — `README.md`:

````markdown
# drone-telegram-mtproto

Замена [appleboy/drone-telegram](https://github.com/appleboy/drone-telegram) для CI-уведомлений в Telegram,
которая ходит не в Bot API (`api.telegram.org`), а по MTProto — через
[tg-ws-proxy](https://github.com/Flowseal/tg-ws-proxy), который туннелирует MTProto в WebSocket к `*.web.telegram.org`.

```
шаг пайплайна ──MTProto (MTProxy)──▶ сервис tg-ws-proxy ──WSS──▶ Telegram
```

Шаблоны сообщений, переменные (`{{build.number}}`, `{{commit.message}}` …), хелперы и параметры — как у
drone-telegram. Отличия собраны в [таблице](#отличия-от-drone-telegram).

Версия 1 отправляет только текст: фото, документы, стикеры, геолокация и `socks5` не поддерживаются
(указание такого параметра — ошибка конфигурации).

## Что понадобится

1. **Бот** — токен от [@BotFather](https://t.me/BotFather). Как и с Bot API, писать можно только тем, кто
   запустил бота, и в группы/каналы, где он состоит.
2. **`api_id` и `api_hash`** — на [my.telegram.org](https://my.telegram.org) → API development tools.
   MTProto требует их даже для ботов.
3. **Секрет прокси** — 32 hex-символа: `openssl rand -hex 16`.
4. **Образы в своём registry.** tg-ws-proxy не публикует образ:

   ```sh
   git clone https://github.com/Flowseal/tg-ws-proxy && cd tg-ws-proxy
   docker build -t registry.example.com/tg-ws-proxy:latest . && docker push registry.example.com/tg-ws-proxy:latest

   git clone <этот репозиторий> && cd drone-telegram-mtproto
   docker build -t registry.example.com/drone-telegram-mtproto:1 . && docker push registry.example.com/drone-telegram-mtproto:1
   ```

## Drone

Полный пример — [`examples/drone.yml`](examples/drone.yml). Суть миграции:

```yaml
services:
  - name: tg-ws-proxy
    image: registry.example.com/tg-ws-proxy:latest
    environment:
      TG_WS_PROXY_SECRET:
        from_secret: TG_PROXY_SECRET

tg-settings: &tg-settings
  token:        { from_secret: TG_BOT_TOKEN }
  to:           { from_secret: TG_BOT_CHATID }
  api_id:       { from_secret: TG_API_ID }
  api_hash:     { from_secret: TG_API_HASH }
  proxy_host:   tg-ws-proxy
  proxy_secret: { from_secret: TG_PROXY_SECRET }

steps:
  - name: notify
    image: registry.example.com/drone-telegram-mtproto:1
    failure: ignore
    settings:
      <<: *tg-settings
      message: |
        ✅ Сборка [#{{build.number}}]({{build.link}}) прошла успешно
```

> **Осторожно с `<<:`.** Слияние YAML неглубокое: если шаблон шага содержит `settings`, а шаг задаёт свой
> `settings:`, то шаблонный `settings` (с `token` и `to`) целиком заменяется. Сливайте именно карту
> настроек, как выше.

Плагин ждёт, пока сервис `tg-ws-proxy` начнёт принимать соединения (до `timeout` секунд), так что
отдельный шаг ожидания не нужен.

## Gitea / Forgejo Actions

Пример — [`examples/gitea.yml`](examples/gitea.yml): `services: tg-ws-proxy` в job и шаг
`uses: docker://registry.example.com/drone-telegram-mtproto:1` с параметрами в `with:`. Статус job
в Actions нет в переменных окружения — передайте его через `template_vars: '{"status": "${{ job.status }}"}'`.

## Параметры

Каждый параметр читается из `PLUGIN_<ИМЯ>`, `TELEGRAM_<ИМЯ>` или `INPUT_<ИМЯ>` (первое непустое):
`settings.api_id` в Drone → `PLUGIN_API_ID`, `with.api_id` в Actions → `INPUT_API_ID`.

| Параметр | По умолчанию | Описание |
|---|---|---|
| `token` | — | токен бота, **обязателен** |
| `to` | — | получатели через запятую, **обязателен**, см. ниже |
| `api_id`, `api_hash` | — | с my.telegram.org, **обязательны** |
| `proxy_host` | — | имя/адрес tg-ws-proxy; без него — прямое подключение к Telegram |
| `proxy_port` | `1443` | |
| `proxy_secret` | — | секрет tg-ws-proxy: 32 hex, `dd…` или `ee…` |
| `message` | сообщение drone-telegram | шаблон; если это ровно один `http(s)://` или `file://` URL — шаблон загружается оттуда |
| `message_file` | — | шаблон из файла (приоритетнее `message`) |
| `template_vars` | — | JSON-объект строк, доступен как `{{tpl.имя}}` |
| `template_vars_file` | — | то же из файла, перекрывает `template_vars` |
| `format` | `markdown` | `markdown` (легаси-Markdown Bot API) или `html` |
| `message_thread_id` | — | id темы форума |
| `disable_web_page_preview` | `false` | |
| `disable_notification` | `false` | беззвучная отправка |
| `only_match_email` | `false` | см. получатели; только `PLUGIN_`/`INPUT_` |
| `session` | — | StringSession, см. ниже |
| `timeout` | `60` | секунд на весь запуск: ожидание прокси, логин, отправка |
| `debug` | `false` | подробный лог teleproto |

### Получатели (`to`)

- `123456` — пользователь, `-100…` — канал/супергруппа, `-123…` — обычная группа, `@username`;
- `id:email` — получит сообщение, только если `email` совпадает с автором коммита;
- с `only_match_email: true` при совпадении хотя бы одного `id:email` сообщение уходит только совпавшим.

Ошибка отправки одному получателю не мешает остальным; шаг завершится с кодом 1.

### Сессия (`session`)

Без `session` бот логинится при каждом запуске. При частых сборках Telegram может ответить `FLOOD_WAIT`.
Сохраните сессию один раз и передавайте её как секрет:

```sh
docker run --rm -e PLUGIN_TOKEN=… -e PLUGIN_API_ID=… -e PLUGIN_API_HASH=… \
  registry.example.com/drone-telegram-mtproto:1 session
```

Команда печатает строку сессии. Она даёт полный доступ к боту — храните как токен.

## Шаблоны

Handlebars с правилами raymond (как в drone-telegram): поле доступно по Go-имени или с маленькой первой буквой —
`{{repo.FullName}}` и `{{repo.fullName}}` работают, `{{repo.fullname}}` — пусто.

| Объект | Поля |
|---|---|
| `repo` | `fullName`, `namespace`, `name` |
| `commit` | `sha`, `ref`, `branch`, `link`, `author`, `avatar`, `email`, `message` |
| `build` | `tag`, `event`, `number`, `status`, `link`, `started`, `finished`, `PR`, `deployTo` |
| `github` (`gitHub`) | `workflow`, `workspace`, `action`, `eventName`, `eventPath` |
| `tpl` | ваши `template_vars` |

Хелперы drone-template-lib: `success`, `failure`, `truncate`, `since`, `duration`, `datetime`,
`uppercasefirst`, `uppercase`, `lowercase`, `urlencode`, `regexReplace`, а также `equal`.

Подмножество [sprig](https://masterminds.github.io/sprig/) (аргументы как в sprig; `div`/`mod` — целочисленные):
`add add1 sub mul div mod max min floor ceil round`,
`trim trimAll trimPrefix trimSuffix upper lower title replace contains hasPrefix hasSuffix trunc abbrev substr repeat quote squote nospace indent nindent plural cat toString atoi int int64`,
`default empty coalesce ternary`, `now date dateInZone unixEpoch ago`, `regexMatch regexFind regexReplaceAll`,
`b64enc b64dec env expandenv`. Прочие функции sprig дают ошибку `helper "X" is not supported`.

Пример: `{{ div (sub build.finished build.started) 60 }} мин {{ mod (sub build.finished build.started) 60 }} с`.

### Разметка

`markdown` — легаси-Markdown Bot API: `*жирный*`, `_курсив_`, `` `код` ``, ```` ```язык … ``` ````,
`[текст](url)`. Как и в drone-telegram, `_` в тексте и в полях коммита экранируется, так что `_курсив_` не
работает, зато имена веток вроде `fix_login` не ломают разметку. `html` — `<b>`, `<i>`, `<code>`, `<pre>`,
`<a href>` и т.д.

## tg-ws-proxy и дата-центры

По умолчанию tg-ws-proxy пускает через WebSocket только DC2 и DC4 (`TG_WS_PROXY_DC_IPS="2:149.154.167.220 4:149.154.167.220"`),
остальные DC идут через fallback (CfProxy или прямой TCP). Если бот живёт на другом DC и прямой доступ
закрыт, добавьте его в `TG_WS_PROXY_DC_IPS` сервиса.

## Отличия от drone-telegram

| Где | drone-telegram | Здесь |
|---|---|---|
| Транспорт | Bot API по HTTPS | MTProto через MTProxy; нужны `api_id`/`api_hash` |
| Незакрытая разметка (`*` в коммите) | ошибка, сообщение не уходит | символ остаётся текстом |
| `_` внутри ссылок и блоков кода | виден как `\_`, ссылки с `_` ломаются | `_` |
| `_` внутри `{{…}}` в markdown | ошибка разбора шаблона | не трогается |
| Ошибка одному получателю | остановка | остальные получают, код 1 |
| `to` | только числа | числа и `@username` |
| Поля в Actions (`repo.name`, `commit.branch/link`, `build.number/link/event`) | пустые | заполняются |
| `{{github.x}}` | пусто | работает |
| `{{config.x}}` | доступен (включая токен) | недоступен |
| sprig | все функции | подмножество |
| Медиа, location/venue, socks5, MarkdownV2 | есть | нет (ошибка конфигурации) |
| Голые env-имена (`FORMAT`, `DEBUG`, `PHOTO`) | читаются | только с префиксами |

## Разработка

```sh
npm ci
npm test            # unit-тесты, без сети
npm run typecheck
npm run build
E2E_TOKEN=… E2E_API_ID=… E2E_API_HASH=… E2E_TO=… npm run e2e   # реальная отправка через tg-ws-proxy
```
````

- [ ] **Step 5: Commit**

```bash
git add Dockerfile .dockerignore examples/drone.yml examples/gitea.yml README.md
git commit -m "feat: Docker image, pipeline examples and README" -m "<TRAILER>"
```

---

### Task 13: E2E через tg-ws-proxy

**Files:**
- Create: `e2e/docker-compose.yml`, `e2e/run.sh`

**Interfaces:**
- Consumes: `Dockerfile` (Task 12), tg-ws-proxy из git (`build: https://github.com/Flowseal/tg-ws-proxy.git`).
- Produces: `npm run e2e` — пропускается (exit 0) без `E2E_TOKEN`, `E2E_API_ID`, `E2E_API_HASH`, `E2E_TO`; опционально `E2E_THREAD_ID`, `E2E_PROXY_SECRET`.

- [ ] **Step 1: Написать файлы**

`e2e/docker-compose.yml`:
```yaml
# Real send through tg-ws-proxy. Run via `npm run e2e` (e2e/run.sh checks the required variables).
services:
  tg-ws-proxy:
    build: https://github.com/Flowseal/tg-ws-proxy.git
    environment:
      TG_WS_PROXY_SECRET: ${E2E_PROXY_SECRET:-0123456789abcdef0123456789abcdef}

  notify:
    build: ..
    depends_on:
      - tg-ws-proxy
    environment:
      PLUGIN_TOKEN: ${E2E_TOKEN:?}
      PLUGIN_TO: ${E2E_TO:?}
      PLUGIN_API_ID: ${E2E_API_ID:?}
      PLUGIN_API_HASH: ${E2E_API_HASH:?}
      PLUGIN_PROXY_HOST: tg-ws-proxy
      PLUGIN_PROXY_SECRET: ${E2E_PROXY_SECRET:-0123456789abcdef0123456789abcdef}
      PLUGIN_MESSAGE_THREAD_ID: ${E2E_THREAD_ID:-}
      PLUGIN_MESSAGE: "🧪 e2e [#{{build.number}}]({{build.link}}): {{commit.message}}"
      DRONE_BUILD_NUMBER: "1"
      DRONE_BUILD_LINK: https://example.com/builds/1
      DRONE_COMMIT_MESSAGE: e2e_check *ok*
```

`e2e/run.sh`:
```sh
#!/bin/sh
# End-to-end: builds tg-ws-proxy and the plugin, sends one real message.
# Skipped (exit 0) unless E2E_TOKEN, E2E_API_ID, E2E_API_HASH and E2E_TO are set.
set -eu

for var in E2E_TOKEN E2E_API_ID E2E_API_HASH E2E_TO; do
  eval "value=\${$var:-}"
  if [ -z "$value" ]; then
    echo "e2e skipped: $var is not set"
    exit 0
  fi
done

cd "$(dirname "$0")"
trap 'docker compose down --remove-orphans >/dev/null 2>&1 || true' EXIT
docker compose up --build --abort-on-container-exit --exit-code-from notify
```

- [ ] **Step 2: Проверить обвязку без сети**

```bash
sh -n e2e/run.sh && env -u E2E_TOKEN npm run e2e
E2E_TOKEN=t E2E_TO=1 E2E_API_ID=1 E2E_API_HASH=h docker compose -f e2e/docker-compose.yml config >/dev/null && echo "compose ok"
```
Expected: `e2e skipped: E2E_TOKEN is not set`, `compose ok`.

- [ ] **Step 3: Реальный прогон** (нужны данные пользователя, как в Task 0; спросить)

```bash
E2E_TOKEN=… E2E_API_ID=… E2E_API_HASH=… E2E_TO="<user_id>,-100<group_id>" npm run e2e
```
Expected: в логе `notify` строки `sent to … (message id N)` для каждого получателя, код выхода 0; в Telegram сообщение «🧪 e2e #1: e2e_check *ok*» со ссылкой на `#1` и видимыми `_` и `*`.

- [ ] **Step 4: Commit**

```bash
git add e2e/docker-compose.yml e2e/run.sh
git commit -m "test: end-to-end send through tg-ws-proxy" -m "<TRAILER>"
```

