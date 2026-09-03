import { compiledWorkflowPlanV2Schema, type CompiledWorkflowPlanV2 } from "@gardener/contracts";
import { evaluateWorkflowCondition } from "@gardener/core";
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
  active_revision: number | null;
  revision_compiled_plan: string | null;
}

export function parseCompiledWorkflowV2(compiledPlan: string | null): CompiledWorkflowPlanV2 | null {
  if (!compiledPlan) return null;
  try {
    const value = JSON.parse(compiledPlan) as unknown;
    if (typeof value !== "object" || value === null || (value as { schemaVersion?: unknown }).schemaVersion !== "v2") return null;
    return compiledWorkflowPlanV2Schema.parse(value);
  } catch {
    return null;
  }
}

export function workflowMatchesEvent(compiledPlan: string, event: ConnectEvent): boolean {
  try {
    const raw = JSON.parse(compiledPlan) as { schemaVersion?: unknown; triggers?: unknown };
    if (!Array.isArray(raw.triggers) || !raw.triggers.includes(`${event.kind}.${event.action}`)) return false;
    if (raw.schemaVersion !== "v2") return true;
    const plan = compiledWorkflowPlanV2Schema.parse(raw);
    if (!plan.repositoryIds.includes(event.repository.id)) return false;
    return evaluateWorkflowCondition(plan.condition, event).matched;
  } catch {
    // Invalid compiled plans, unavailable facts, and unresolved conditions fail closed.
    return false;
  }
}

export async function createRunsForEvent(env: Env, event: ConnectEvent): Promise<string[]> {
  const { results: workflows } = await env.DB
    .prepare(
      "SELECT w.id, w.version, w.compiled_plan, w.active_revision, wr.compiled_plan_json AS revision_compiled_plan " +
        "FROM workflows w LEFT JOIN workflow_revisions wr ON wr.workflow_id = w.id AND wr.revision = w.active_revision " +
        "WHERE w.enabled = 1 AND w.trigger_kind = ? ORDER BY w.id",
    )
    .bind(event.kind)
    .all<RunnableWorkflow>();
  const policies = await policySnapshot(env.DB);
  const runIds: string[] = [];
  for (const workflow of workflows) {
    const pinnedPlanJson = workflow.active_revision === null ? workflow.compiled_plan : workflow.revision_compiled_plan;
    if (!pinnedPlanJson || !workflowMatchesEvent(pinnedPlanJson, event)) continue;
    const pinnedPlan = workflow.active_revision === null ? null : parseCompiledWorkflowV2(pinnedPlanJson);
    if (workflow.active_revision !== null && !pinnedPlan) continue;
    const workflowVersion = workflow.active_revision ?? workflow.version;
    const runId = crypto.randomUUID();
    const statements = [env.DB.prepare(
      "INSERT OR IGNORE INTO runs " +
        "(id, event_id, workflow_id, workflow_version, status, policy_snapshot) VALUES (?, ?, ?, ?, 'queued', ?)",
    ).bind(runId, event.id, workflow.id, workflowVersion, JSON.stringify(policies))];
    if (pinnedPlan) {
      statements.push(env.DB.prepare(
        "INSERT OR IGNORE INTO run_workflow_plans (run_id, workflow_id, revision, plan_id, content_hash) " +
          "SELECT id, ?, ?, ?, ? FROM runs WHERE id = ?",
      ).bind(workflow.id, workflowVersion, pinnedPlan.planId, pinnedPlan.contentHash, runId));
    }
    const results = await env.DB.batch(statements);
    if ((results[0]?.meta.changes ?? 0) > 0) runIds.push(runId);
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
