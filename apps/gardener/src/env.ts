import type { GitHubGatewayRpc } from "@gardener/provider-github";
import type { HarnessToolFacade } from "./harness";
import type { TaskRunnerSession } from "./task-runtime/session";

export interface Env {
  DB: D1Database;
  AI: Ai;
  ASSETS: Fetcher;
  AI_MODEL: string;
  GITHUB_GATEWAY: GitHubGatewayRpc;
  GARDENER_WORKSPACE_ID: string;
  LOCAL_DEV_BYPASS?: string;

  COMPUTER_WORKSPACES: DurableObjectNamespace;
  COMPUTER_LOADER: unknown;
  COMPUTER_INPUTS?: R2Bucket;
  GARDENER_HARNESS_TOOLS?: HarnessToolFacade;
  RUNNER_SESSIONS: DurableObjectNamespace<TaskRunnerSession>;

  /** OAuth is mounted only when an operator provisions the required KV binding. */
  OAUTH_KV?: KVNamespace;
  OAUTH_PROVIDER?: unknown;
}

/** Stable, non-secret identity for one customer-owned Gardener deployment. */
export function instanceId(env: Pick<Env, "GARDENER_WORKSPACE_ID">): string {
  const value = env.GARDENER_WORKSPACE_ID?.trim();
  if (!value || !/^[A-Za-z0-9_-]{3,100}$/.test(value)) {
    throw new Error("Invalid Gardener workspace id");
  }
  return value;
}
