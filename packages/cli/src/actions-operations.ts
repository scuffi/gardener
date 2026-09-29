import { executeD1, queryD1, sql } from "./actions-d1.js";
import { readProjectLock, resolveInstallation, type ActionsInstallation } from "./actions-installation.js";

export async function setRepositoryEnabled(input: {
  workspace: string;
  repository: string;
  sourceRoot: string;
  enabled: boolean;
}): Promise<{ repositoryId: string; enabled: boolean }> {
  const installation = await resolveInstallation(input.workspace);
  const repositoryId = enrolledRepositoryId(input.sourceRoot, installation, input.repository);
  const enabled = input.enabled ? 1 : 0;
  executeD1(installation.cloudflare.database.name,
    `UPDATE actions_repository_enrollments SET enabled=${enabled},updated_at=CURRENT_TIMESTAMP WHERE repository_id=${sql(repositoryId)};`);
  const rows = queryD1(installation.cloudflare.database.name,
    `SELECT enabled FROM actions_repository_enrollments WHERE repository_id=${sql(repositoryId)};`);
  if (Number(rows[0]?.enabled) !== enabled) throw new Error("Repository enrollment did not update");
  return { repositoryId, enabled: input.enabled };
}

export async function listActionsRepositories(input: {
  workspace: string;
  sourceRoot: string;
}): Promise<{ repositories: Array<Record<string, unknown>> }> {
  const installation = await resolveInstallation(input.workspace);
  const rows = queryD1(installation.cloudflare.database.name,
    "SELECT repository_id,owner_id,owner_login,repository_name,visibility,enabled,updated_at FROM actions_repository_enrollments ORDER BY owner_login,repository_name;");
  return { repositories: rows };
}

export async function listActionsTasks(input: {
  workspace: string;
  repository?: string;
  sourceRoot: string;
}): Promise<{ tasks: Array<Record<string, unknown>> }> {
  const installation = await resolveInstallation(input.workspace);
  const predicate = input.repository
    ? `WHERE rt.repository_id=${sql(enrolledRepositoryId(input.sourceRoot, installation, input.repository))}`
    : "";
  const rows = queryD1(installation.cloudflare.database.name,
    `SELECT rt.repository_id,rt.task_id,rt.source_path,rt.bundle_hash,rt.enabled,rt.updated_at FROM actions_repository_tasks rt ${predicate} ORDER BY rt.repository_id,rt.task_id;`);
  return { tasks: rows };
}

export async function listActionsRuns(input: {
  workspace: string;
  repository?: string;
  sourceRoot: string;
  limit?: number;
}): Promise<{ runs: Array<Record<string, unknown>> }> {
  const installation = await resolveInstallation(input.workspace);
  const limit = Math.max(1, Math.min(100, input.limit ?? 20));
  const predicate = input.repository
    ? `WHERE repository_id=${sql(enrolledRepositoryId(input.sourceRoot, installation, input.repository))}`
    : "";
  const rows = queryD1(installation.cloudflare.database.name,
    `SELECT id,repository_id,github_run_id,github_run_attempt,bundle_hash,status,outcome_json,effect_receipt_json,created_at,updated_at FROM actions_task_runs ${predicate} ORDER BY created_at DESC,id DESC LIMIT ${limit};`);
  return { runs: rows.map(parseRunJson) };
}

export async function showActionsRun(input: {
  workspace: string;
  runId: string;
  sourceRoot: string;
}): Promise<{ run: Record<string, unknown>; audit: Array<Record<string, unknown>> }> {
  const installation = await resolveInstallation(input.workspace);
  const rows = queryD1(installation.cloudflare.database.name,
    `SELECT id,repository_id,github_run_id,github_run_attempt,bundle_hash,status,request_json,outcome_json,effect_receipt_json,created_at,updated_at FROM actions_task_runs WHERE id=${sql(input.runId)} LIMIT 1;`);
  if (rows.length !== 1) throw new Error(`Actions run not found: ${input.runId}`);
  const audit = queryD1(installation.cloudflare.database.name,
    `SELECT sequence,event,detail_json,created_at FROM actions_task_audit WHERE run_id=${sql(input.runId)} ORDER BY sequence;`)
    .map((row) => ({ ...row, detail: parseJson(row.detail_json) }));
  return { run: parseRunJson(rows[0]!), audit };
}

function enrolledRepositoryId(
  sourceRoot: string,
  installation: ActionsInstallation,
  repository: string,
): string {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error("Repository must use owner/name syntax");
  }
  const [owner, name] = repository.split("/") as [string, string];
  const rows = queryD1(installation.cloudflare.database.name,
    `SELECT repository_id FROM actions_repository_enrollments WHERE owner_login=${sql(owner)} COLLATE NOCASE AND repository_name=${sql(name)} COLLATE NOCASE;`);
  if (rows.length !== 1 || typeof rows[0]?.repository_id !== "string") {
    throw new Error(`Repository is not uniquely enrolled: ${repository}`);
  }
  return rows[0].repository_id;
}

function parseRunJson(row: Record<string, unknown>): Record<string, unknown> {
  return {
    ...row,
    ...(typeof row.request_json === "string" ? { request: parseJson(row.request_json) } : {}),
    ...(typeof row.outcome_json === "string" ? { outcome: parseJson(row.outcome_json) } : {}),
    ...(typeof row.effect_receipt_json === "string" ? { effectReceipt: parseJson(row.effect_receipt_json) } : {}),
  };
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return null;
  try { return JSON.parse(value); }
  catch { throw new Error("D1 contains invalid JSON state"); }
}
