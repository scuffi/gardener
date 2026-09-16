import { z } from "zod";
import {
  beginGitHubLoginResultSchema,
  completeGitHubLoginResultSchema,
  type BeginGitHubLoginResult,
} from "@gardener/provider-github";
import { nowSeconds, randomToken, sha256 } from "./database";
import type { Env } from "./env";
import { exchangeOAuthCode } from "./github-client";

const FLOW_TTL_SECONDS = 10 * 60;

export const githubOAuthCallbackQuerySchema = z.object({
  code: z.string().min(1).max(1_000),
  state: z.string().min(1).max(255),
  // GitHub includes the RFC 9207 authorization-server issuer in OAuth responses.
  // Keep the query strict, but bind an issuer when it is present rather than
  // treating GitHub's security signal as an unknown parameter.
  iss: z.literal("https://github.com/login/oauth").optional(),
}).strict();

interface OAuthFlowRow {
  expires_at: number;
  state_consumed_at: string | null;
  gardener_completed_at: string | null;
  github_user_id: string | null;
  github_login: string | null;
}

export async function beginGitHubLogin(env: Env): Promise<BeginGitHubLoginResult> {
  const now = nowSeconds();
  await env.DB.prepare(
    "DELETE FROM oauth_flows WHERE expires_at < ? OR " +
    "(gardener_completed_at IS NOT NULL AND gardener_completed_at < datetime('now', '-1 day'))",
  ).bind(now).run();
  const active = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM oauth_flows WHERE expires_at >= ?",
  ).bind(now).first<{ count: number }>();
  if ((active?.count ?? 0) >= 1_000) throw new Error("oauth_flow_capacity_reached");

  // The OAuth state is also the one-use browser handoff. Only its hash is persisted.
  const state = randomToken("login_");
  await env.DB.prepare(
    "INSERT INTO oauth_flows (state_hash, expires_at) VALUES (?, ?)",
  ).bind(await sha256(state), now + FLOW_TTL_SECONDS).run();

  const authorizationUrl = new URL("https://github.com/login/oauth/authorize");
  authorizationUrl.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  authorizationUrl.searchParams.set("redirect_uri", new URL("/oauth/github/callback", env.GATEWAY_ORIGIN).toString());
  authorizationUrl.searchParams.set("state", state);
  return beginGitHubLoginResultSchema.parse({ authorizationUrl: authorizationUrl.toString() });
}

export async function completeGitHubOAuthCallback(
  env: Env,
  input: { code: string; state: string },
): Promise<string> {
  const stateHash = await sha256(input.state);
  let flow = await readFlow(env.DB, stateHash);
  if (!flow || flow.expires_at < nowSeconds()) throw new Error("invalid_or_expired_oauth_state");
  if (flow.gardener_completed_at) throw new Error("oauth_state_replayed");

  if (!flow.state_consumed_at) {
    const claimed = await env.DB.prepare(
      "UPDATE oauth_flows SET state_consumed_at = CURRENT_TIMESTAMP " +
      "WHERE state_hash = ? AND state_consumed_at IS NULL AND expires_at >= ?",
    ).bind(stateHash, nowSeconds()).run();
    if ((claimed.meta.changes ?? 0) !== 1) throw new Error("oauth_state_replayed");

    const identity = await exchangeOAuthCode(env, input.code);
    await env.DB.prepare(
      "UPDATE oauth_flows SET github_user_id = ?, github_login = ? " +
      "WHERE state_hash = ? AND github_user_id IS NULL",
    ).bind(identity.id, identity.login, stateHash).run();
    flow = await readFlow(env.DB, stateHash);
  }

  if (!flow?.github_user_id || !flow.github_login) throw new Error("oauth_identity_unavailable");
  if (!env.GARDENER) throw new Error("gardener_binding_unavailable");

  if (!flow.gardener_completed_at) {
    const result = completeGitHubLoginResultSchema.parse(await env.GARDENER.completeLogin({
      handoffId: input.state,
      identity: { provider: "github", subject: flow.github_user_id, login: flow.github_login },
      expiresAt: flow.expires_at,
    }));
    if (!result.accepted) throw new Error("gardener_rejected_login");
    await env.DB.prepare(
      "UPDATE oauth_flows SET gardener_completed_at = CURRENT_TIMESTAMP " +
      "WHERE state_hash = ? AND gardener_completed_at IS NULL",
    ).bind(stateHash).run();
  }

  const destination = new URL("/api/auth/github/complete", env.GARDENER_ORIGIN);
  destination.searchParams.set("handoff", input.state);
  return destination.toString();
}

async function readFlow(db: D1Database, stateHash: string): Promise<OAuthFlowRow | null> {
  return db.prepare(
    "SELECT expires_at, state_consumed_at, gardener_completed_at, " +
    "github_user_id, github_login FROM oauth_flows WHERE state_hash = ?",
  ).bind(stateHash).first<OAuthFlowRow>();
}
