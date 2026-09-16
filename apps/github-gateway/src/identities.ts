import {
  resolveGitHubUsernameResultSchema,
  resolveGitHubUsernameSchema,
  type ResolveGitHubUsername,
  type ResolveGitHubUsernameResult,
} from "@gardener/provider-github";
import { nowSeconds } from "./database";
import type { Env } from "./env";
import { resolveGitHubUsername as resolveThroughGitHub } from "./github-client";

const WINDOW_SECONDS = 60 * 60;
const MAX_ATTEMPTS = 30;

export async function resolveGitHubUsername(
  env: Env,
  inputValue: ResolveGitHubUsername,
): Promise<ResolveGitHubUsernameResult> {
  const input = resolveGitHubUsernameSchema.parse(inputValue);
  const installations = await env.DB.prepare(
    "SELECT id FROM installations WHERE suspended_at IS NULL AND revoked_at IS NULL ORDER BY id",
  ).all<{ id: string }>();
  if (installations.results.length === 0) throw new Error("github_installation_required");
  await claimLookup(env.DB, installations.results[0]!.id);

  for (const installation of installations.results) {
    const user = await resolveThroughGitHub(env, installation.id, input.login);
    if (user) {
      return resolveGitHubUsernameResultSchema.parse({
        identity: { provider: "github", subject: user.id, login: user.login },
      });
    }
  }
  return resolveGitHubUsernameResultSchema.parse({ identity: null });
}

async function claimLookup(db: D1Database, installationId: string): Promise<void> {
  const windowStartedAt = Math.floor(nowSeconds() / WINDOW_SECONDS) * WINDOW_SECONDS;
  const claimed = await db.prepare(
    "UPDATE installations SET username_lookup_attempts = " +
    "CASE WHEN username_lookup_window = ? THEN username_lookup_attempts + 1 ELSE 1 END, " +
    "username_lookup_window = ? WHERE id = ? AND " +
    "(username_lookup_window IS NULL OR username_lookup_window <> ? OR username_lookup_attempts < ?)",
  ).bind(
    windowStartedAt,
    windowStartedAt,
    installationId,
    windowStartedAt,
    MAX_ATTEMPTS,
  ).run();
  if ((claimed.meta.changes ?? 0) !== 1) throw new Error("username_lookup_rate_limited");
}
