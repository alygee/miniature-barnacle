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
