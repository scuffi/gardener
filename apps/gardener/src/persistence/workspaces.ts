import { changed, decodeJson, encodeJson } from "./shared";

export type WorkspaceBackend = "filesystem" | "git" | "shell" | "javascript" | "container";
export type WorkspaceState = "provisioning" | "active" | "lost" | "releasing" | "released" | "failed";
export type CleanupState = "not_due" | "pending" | "claimed" | "completed" | "failed";

export interface CreateWorkspaceLeaseInput {
  id: string;
  runId: string;
  taskId: string | null;
  workspaceKey: string;
  backend: WorkspaceBackend;
  state: "provisioning" | "active";
  leaseTokenHash: string;
  leaseExpiresAt: string;
  cleanupAfter: string;
}

interface WorkspaceRow {
  id: string;
  run_id: string;
  task_id: string | null;
  workspace_key: string;
  provider: "cloudflare-computer";
  backend: WorkspaceBackend;
  state: WorkspaceState;
  lease_token_hash: string;
  lease_expires_at: string;
  cleanup_state: CleanupState;
  cleanup_after: string;
  cleanup_claim_token_hash: string | null;
  cleanup_claimed_by: string | null;
  cleanup_claimed_at: string | null;
  cleanup_claim_expires_at: string | null;
  cleanup_attempts: number;
  last_error_json: string | null;
  created_at: string;
  updated_at: string;
  released_at: string | null;
}

export interface WorkspaceLeaseDto {
  id: string;
  runId: string;
  taskId: string | null;
  workspaceKey: string;
  provider: "cloudflare-computer";
  backend: WorkspaceBackend;
  state: WorkspaceState;
  leaseExpiresAt: string;
  cleanupState: CleanupState;
  cleanupAfter: string;
  cleanupClaimedBy: string | null;
  cleanupClaimedAt: string | null;
  cleanupClaimExpiresAt: string | null;
  cleanupAttempts: number;
  lastError: unknown | null;
  createdAt: string;
  updatedAt: string;
  releasedAt: string | null;
}

function workspaceDto(row: WorkspaceRow): WorkspaceLeaseDto {
  return {
    id: row.id,
    runId: row.run_id,
    taskId: row.task_id,
    workspaceKey: row.workspace_key,
    provider: row.provider,
    backend: row.backend,
    state: row.state,
    leaseExpiresAt: row.lease_expires_at,
    cleanupState: row.cleanup_state,
    cleanupAfter: row.cleanup_after,
    cleanupClaimedBy: row.cleanup_claimed_by,
    cleanupClaimedAt: row.cleanup_claimed_at,
    cleanupClaimExpiresAt: row.cleanup_claim_expires_at,
    cleanupAttempts: row.cleanup_attempts,
    lastError: decodeJson(row.last_error_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    releasedAt: row.released_at,
  };
}

export async function createWorkspaceLease(db: D1Database, input: CreateWorkspaceLeaseInput): Promise<WorkspaceLeaseDto> {
  await db.prepare(`
    INSERT INTO workspace_leases (
      id, run_id, task_id, workspace_key, provider, backend, state,
      lease_token_hash, lease_expires_at, cleanup_state, cleanup_after
    ) VALUES (?, ?, ?, ?, 'cloudflare-computer', ?, ?, ?, ?, 'not_due', ?)
  `).bind(
    input.id,
    input.runId,
    input.taskId,
    input.workspaceKey,
    input.backend,
    input.state,
    input.leaseTokenHash,
    input.leaseExpiresAt,
    input.cleanupAfter,
  ).run();
  const lease = await getWorkspaceLease(db, input.id);
  if (!lease) throw new Error("Workspace lease creation failed");
  return lease;
}

export async function getWorkspaceLease(db: D1Database, id: string): Promise<WorkspaceLeaseDto | null> {
  const row = await db.prepare("SELECT * FROM workspace_leases WHERE id = ?").bind(id).first<WorkspaceRow>();
  return row ? workspaceDto(row) : null;
}

export async function renewWorkspaceLease(
  db: D1Database,
  input: { id: string; leaseTokenHash: string; leaseExpiresAt: string },
): Promise<boolean> {
  const result = await db.prepare(`
    UPDATE workspace_leases SET lease_expires_at = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND lease_token_hash = ? AND state IN ('provisioning', 'active')
  `).bind(input.leaseExpiresAt, input.id, input.leaseTokenHash).run();
  return changed(result);
}

export async function claimWorkspaceCleanup(
  db: D1Database,
  input: {
    id: string;
    workerId: string;
    claimTokenHash: string;
    now: string;
    claimExpiresAt: string;
  },
): Promise<{ claimed: boolean; lease: WorkspaceLeaseDto | null }> {
  await db.prepare(`
    UPDATE workspace_leases SET cleanup_state = 'pending', updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND cleanup_state = 'not_due' AND cleanup_after <= ?
  `).bind(input.id, input.now).run();

  const result = await db.prepare(`
    UPDATE workspace_leases SET cleanup_state = 'claimed',
      cleanup_claim_token_hash = ?, cleanup_claimed_by = ?, cleanup_claimed_at = ?,
      cleanup_claim_expires_at = ?, cleanup_attempts = cleanup_attempts + 1,
      state = CASE WHEN state IN ('released', 'releasing') THEN state ELSE 'releasing' END,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND cleanup_after <= ? AND ? > ? AND (
      cleanup_state IN ('pending', 'failed') OR
      (cleanup_state = 'claimed' AND cleanup_claim_expires_at <= ?)
    )
  `).bind(
    input.claimTokenHash,
    input.workerId,
    input.now,
    input.claimExpiresAt,
    input.id,
    input.now,
    input.claimExpiresAt,
    input.now,
    input.now,
  ).run();
  return { claimed: changed(result), lease: await getWorkspaceLease(db, input.id) };
}

export async function completeWorkspaceCleanup(
  db: D1Database,
  input: { id: string; claimTokenHash: string; now: string; completedAt: string; error: unknown | null },
): Promise<boolean> {
  const successful = input.error === null;
  const result = await db.prepare(`
    UPDATE workspace_leases SET
      cleanup_state = ?,
      state = ?,
      last_error_json = ?,
      released_at = ?,
      cleanup_claim_token_hash = NULL,
      cleanup_claimed_by = NULL,
      cleanup_claimed_at = NULL,
      cleanup_claim_expires_at = NULL,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND cleanup_state = 'claimed' AND cleanup_claim_token_hash = ?
      AND cleanup_claim_expires_at > ?
  `).bind(
    successful ? "completed" : "failed",
    successful ? "released" : "failed",
    input.error === null ? null : encodeJson(input.error),
    successful ? input.completedAt : null,
    input.id,
    input.claimTokenHash,
    input.now,
  ).run();
  return changed(result);
}
