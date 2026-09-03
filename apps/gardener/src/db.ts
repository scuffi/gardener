import type { ConnectEvent, PolicyMode } from "./domain";
import type { Env } from "./env";

export async function getSetting(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

export async function setSetting(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP",
    )
    .bind(key, value)
    .run();
}

export function repositoryPauseSetting(repositoryId: string): string {
  return `repository_paused:${repositoryId}`;
}

export type PauseScope = "global" | "repository";
export async function pauseScope(db: D1Database, repositoryId: string): Promise<PauseScope | null> {
  if ((await getSetting(db, "global_paused")) !== "false") return "global";
  return (await getSetting(db, repositoryPauseSetting(repositoryId))) === "true" ? "repository" : null;
}

export async function policySnapshot(db: D1Database): Promise<Record<string, PolicyMode>> {
  const { results } = await db
    .prepare("SELECT operation_kind, mode FROM operation_policies ORDER BY operation_kind")
    .all<{ operation_kind: string; mode: PolicyMode }>();
  return Object.fromEntries(results.map((row) => [row.operation_kind, row.mode]));
}

export async function ingestEvent(db: D1Database, event: ConnectEvent): Promise<boolean> {
  const repository = event.repository;
  const results = await db.batch([
    db
      .prepare(
        "INSERT INTO repositories (id, installation_id, owner, name, default_branch, updated_at) " +
          "VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP) ON CONFLICT(id) DO UPDATE SET " +
          "installation_id = excluded.installation_id, owner = excluded.owner, name = excluded.name, " +
          "default_branch = excluded.default_branch, active = 1, updated_at = CURRENT_TIMESTAMP",
      )
      .bind(
        repository.id,
        repository.installationId,
        repository.owner,
        repository.name,
        repository.defaultBranch ?? null,
      ),
    db
      .prepare(
        "INSERT OR IGNORE INTO events " +
          "(id, delivery_id, event_kind, action, repository_id, resource_id, envelope) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        event.id,
        event.deliveryId,
        event.kind,
        event.action,
        repository.id,
        event.kind === "github.issue" ? event.issue.id : event.pullRequest.id,
        JSON.stringify(event),
      ),
  ]);
  return (results[1]?.meta.changes ?? 0) > 0;
}

interface RunnableWorkflow {
  id: string;
  version: number;
  compiled_plan: string;
}

export function workflowMatchesEvent(compiledPlan: string, event: ConnectEvent): boolean {
  try {
    const plan = JSON.parse(compiledPlan) as { triggers?: unknown };
    return Array.isArray(plan.triggers) && plan.triggers.includes(`${event.kind}.${event.action}`);
  } catch {
    // Invalid compiled plans fail closed rather than broadening their trigger.
    return false;
  }
}

export async function createRunsForEvent(env: Env, event: ConnectEvent): Promise<string[]> {
  const { results: workflows } = await env.DB
    .prepare(
      "SELECT id, version, compiled_plan FROM workflows WHERE enabled = 1 AND trigger_kind = ? ORDER BY id",
    )
    .bind(event.kind)
    .all<RunnableWorkflow>();
  const policies = await policySnapshot(env.DB);
  const runIds: string[] = [];
  for (const workflow of workflows.filter((candidate) => workflowMatchesEvent(candidate.compiled_plan, event))) {
    const runId = crypto.randomUUID();
    const result = await env.DB
      .prepare(
        "INSERT OR IGNORE INTO runs " +
          "(id, event_id, workflow_id, workflow_version, status, policy_snapshot) VALUES (?, ?, ?, ?, 'queued', ?)",
      )
      .bind(runId, event.id, workflow.id, workflow.version, JSON.stringify(policies))
      .run();
    if ((result.meta.changes ?? 0) > 0) runIds.push(runId);
  }
  await Promise.all(runIds.map((runId) => env.RUN_QUEUE.send({ runId })));
  return runIds;
}

export async function audit(
  db: D1Database,
  actor: string,
  action: string,
  resourceType: string,
  resourceId: string,
  detail?: unknown,
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO audit_records (actor, action, resource_type, resource_id, detail) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(actor, action, resourceType, resourceId, detail === undefined ? null : JSON.stringify(detail))
    .run();
}
