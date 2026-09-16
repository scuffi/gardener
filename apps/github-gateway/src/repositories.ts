import {
  connectedGitHubRepositorySchema,
  githubRepositorySyncResultSchema,
  type ConnectedGitHubRepository,
  type GitHubRepositorySyncResult,
} from "@gardener/provider-github";
import { nowSeconds, randomToken } from "./database";
import type { Env } from "./env";
import { discoverRepositories } from "./github-client";

interface ActiveInstallationRow {
  id: string;
  sync_generation: number;
}

export async function syncAllRepositories(env: Env): Promise<GitHubRepositorySyncResult> {
  const installations = await env.DB.prepare(
    "SELECT id, sync_generation FROM installations " +
    "WHERE suspended_at IS NULL AND revoked_at IS NULL ORDER BY id",
  ).all<ActiveInstallationRow>();

  const repositories: ConnectedGitHubRepository[] = [];
  for (const installation of installations.results) {
    repositories.push(...await syncInstallationRepositories(env, installation));
  }
  return githubRepositorySyncResultSchema.parse({ repositories });
}

export async function syncInstallationRepositories(
  env: Env,
  installation: ActiveInstallationRow,
): Promise<ConnectedGitHubRepository[]> {
  const leaseToken = randomToken("sync_");
  const now = nowSeconds();
  const claimed = await env.DB.prepare(
    "UPDATE installations SET sync_lease_token = ?, sync_lease_expires_at = ? WHERE id = ? " +
    "AND (sync_lease_token IS NULL OR sync_lease_expires_at <= ?)",
  ).bind(leaseToken, now + 10 * 60, installation.id, now).run();
  if ((claimed.meta.changes ?? 0) !== 1) throw new Error("repository_sync_in_progress");

  try {
    const current = await env.DB.prepare(
      "SELECT sync_generation FROM installations WHERE id = ? AND sync_lease_token = ?",
    ).bind(installation.id, leaseToken).first<{ sync_generation: number }>();
    if (!current) throw new Error("repository_sync_lease_lost");
    const discovered = await discoverRepositories(env, installation.id);
    // Validate the complete provider boundary before mutating authoritative state.
    // A contract drift must not leave a partially synchronized installation behind.
    const connected = discovered.map((repository) => connectedGitHubRepositorySchema.parse(repository));
    const generation = current.sync_generation + 1;

    const statements = connected.map((repository) => env.DB.prepare(
      "INSERT INTO repositories " +
      "(id, installation_id, owner, name, default_branch, active, sync_generation, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, 1, ?, CURRENT_TIMESTAMP) " +
      "ON CONFLICT(id) DO UPDATE SET installation_id = excluded.installation_id, " +
      "owner = excluded.owner, name = excluded.name, default_branch = excluded.default_branch, " +
      "active = 1, sync_generation = excluded.sync_generation, updated_at = CURRENT_TIMESTAMP",
    ).bind(
      repository.id,
      repository.installationId,
      repository.owner,
      repository.name,
      repository.defaultBranch ?? null,
      generation,
    ));

    const results = await env.DB.batch([
      ...statements,
      env.DB.prepare(
        "UPDATE repositories SET active = 0, updated_at = CURRENT_TIMESTAMP " +
        "WHERE installation_id = ? AND sync_generation < ?",
      ).bind(installation.id, generation),
      env.DB.prepare(
        "UPDATE installations SET sync_generation = ?, sync_lease_token = NULL, " +
        "sync_lease_expires_at = NULL, updated_at = CURRENT_TIMESTAMP " +
        "WHERE id = ? AND sync_lease_token = ?",
      ).bind(generation, installation.id, leaseToken),
    ]);
    if ((results.at(-1)?.meta.changes ?? 0) !== 1) throw new Error("repository_sync_lease_lost");

    return connected;
  } catch (error) {
    await env.DB.prepare(
      "UPDATE installations SET sync_lease_token = NULL, sync_lease_expires_at = NULL " +
      "WHERE id = ? AND sync_lease_token = ?",
    ).bind(installation.id, leaseToken).run();
    throw error;
  }
}

export async function activeRepositories(env: Env): Promise<ConnectedGitHubRepository[]> {
  const rows = await env.DB.prepare(
    "SELECT 'github' provider, r.id, r.installation_id installationId, r.owner, r.name, " +
    "r.default_branch defaultBranch FROM repositories r " +
    "JOIN installations i ON i.id = r.installation_id " +
    "WHERE r.active = 1 AND i.suspended_at IS NULL AND i.revoked_at IS NULL " +
    "ORDER BY r.owner, r.name",
  ).all();
  return rows.results.map((row) => connectedGitHubRepositorySchema.parse(row));
}
