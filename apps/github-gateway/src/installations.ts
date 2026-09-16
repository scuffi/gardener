import {
  beginGitHubInstallationResultSchema,
  finalizeGitHubInstallationResultSchema,
  githubInstallationRequestSchema,
  type BeginGitHubInstallationResult,
  type FinalizeGitHubInstallationResult,
  type GitHubInstallationRequest,
} from "@gardener/provider-github";
import { nowSeconds, randomToken, sha256 } from "./database";
import type { Env } from "./env";
import { getInstallation } from "./github-client";
import { syncInstallationRepositories } from "./repositories";

const FLOW_TTL_SECONDS = 15 * 60;

interface InstallationFlowRow {
  request_id: string;
  requested_by_github_user_id: string;
  requested_by_github_login: string;
  expires_at: number;
  state_consumed_at: string | null;
  ready_at: string | null;
  finalized_at: string | null;
  installation_id: string | null;
}

export async function beginGitHubInstallation(
  env: Env,
  inputValue: GitHubInstallationRequest,
): Promise<BeginGitHubInstallationResult> {
  const input = githubInstallationRequestSchema.parse(inputValue);
  const state = randomToken("install_");
  await env.DB.prepare(
    "INSERT INTO installation_flows " +
    "(state_hash, request_id, requested_by_github_user_id, requested_by_github_login, expires_at) " +
    "VALUES (?, ?, ?, ?, ?)",
  ).bind(
    await sha256(state),
    input.requestId,
    input.requestedBy.subject,
    input.requestedBy.login,
    nowSeconds() + FLOW_TTL_SECONDS,
  ).run();

  const installationUrl = new URL(`https://github.com/apps/${env.GITHUB_APP_SLUG}/installations/new`);
  installationUrl.searchParams.set("state", state);
  return beginGitHubInstallationResultSchema.parse({ installationUrl: installationUrl.toString() });
}

export async function completeGitHubInstallationCallback(
  env: Env,
  input: { installationId: string; state: string },
): Promise<string> {
  const stateHash = await sha256(input.state);
  let flow = await readFlowByState(env.DB, stateHash);
  if (!flow || flow.expires_at < nowSeconds()) throw new Error("invalid_or_expired_installation_state");

  if (!flow.state_consumed_at) {
    const claimed = await env.DB.prepare(
      "UPDATE installation_flows SET state_consumed_at = CURRENT_TIMESTAMP " +
      "WHERE state_hash = ? AND state_consumed_at IS NULL AND expires_at >= ?",
    ).bind(stateHash, nowSeconds()).run();
    if ((claimed.meta.changes ?? 0) !== 1) throw new Error("installation_state_replayed");
  }

  if (!flow.ready_at) {
    const installation = await getInstallation(env, input.installationId);
    await env.DB.prepare(
      "UPDATE installation_flows SET installation_id = ?, ready_at = CURRENT_TIMESTAMP " +
      "WHERE state_hash = ? AND installation_id IS NULL",
    ).bind(installation.id, stateHash).run();
    flow = await readFlowByState(env.DB, stateHash);
  }

  if (!flow?.installation_id || flow.installation_id !== input.installationId) {
    throw new Error("installation_callback_mismatch");
  }

  const destination = new URL("/settings", env.GARDENER_ORIGIN);
  destination.searchParams.set("installation", "ready");
  destination.searchParams.set("request", flow.request_id);
  return destination.toString();
}

export async function finalizeGitHubInstallation(
  env: Env,
  inputValue: GitHubInstallationRequest,
): Promise<FinalizeGitHubInstallationResult> {
  const input = githubInstallationRequestSchema.parse(inputValue);
  const flow = await readFlowByRequest(env.DB, input.requestId);
  if (!flow || flow.expires_at < nowSeconds() || !flow.ready_at || !flow.installation_id) {
    throw new Error("installation_not_ready");
  }
  if (flow.requested_by_github_user_id !== input.requestedBy.subject) {
    throw new Error("installation_owner_mismatch");
  }

  const installation = await getInstallation(env, flow.installation_id);
  await env.DB.prepare(
    "INSERT INTO installations " +
    "(id, account_id, account_login, account_type, suspended_at, revoked_at) " +
    "VALUES (?, ?, ?, ?, NULL, NULL) " +
    "ON CONFLICT(id) DO UPDATE SET account_id = excluded.account_id, " +
    "account_login = excluded.account_login, account_type = excluded.account_type, " +
    "suspended_at = NULL, revoked_at = NULL, updated_at = CURRENT_TIMESTAMP",
  ).bind(
    installation.id,
    installation.accountId,
    installation.accountLogin,
    installation.accountType,
  ).run();

  const row = await env.DB.prepare(
    "SELECT id, sync_generation FROM installations WHERE id = ?",
  ).bind(installation.id).first<{ id: string; sync_generation: number }>();
  if (!row) throw new Error("installation_persistence_failed");
  const repositories = await syncInstallationRepositories(env, row);

  await env.DB.prepare(
    "UPDATE installation_flows SET finalized_at = CURRENT_TIMESTAMP " +
    "WHERE request_id = ? AND finalized_at IS NULL",
  ).bind(input.requestId).run();

  return finalizeGitHubInstallationResultSchema.parse({
    installation: { ...installation, active: true },
    repositories,
  });
}

async function readFlowByState(db: D1Database, stateHash: string): Promise<InstallationFlowRow | null> {
  return db.prepare(
    "SELECT request_id, requested_by_github_user_id, requested_by_github_login, expires_at, " +
    "state_consumed_at, ready_at, finalized_at, installation_id " +
    "FROM installation_flows WHERE state_hash = ?",
  ).bind(stateHash).first<InstallationFlowRow>();
}

async function readFlowByRequest(db: D1Database, requestId: string): Promise<InstallationFlowRow | null> {
  return db.prepare(
    "SELECT request_id, requested_by_github_user_id, requested_by_github_login, expires_at, " +
    "state_consumed_at, ready_at, finalized_at, installation_id " +
    "FROM installation_flows WHERE request_id = ?",
  ).bind(requestId).first<InstallationFlowRow>();
}
