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
