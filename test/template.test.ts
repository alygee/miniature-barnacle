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
