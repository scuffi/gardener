import { changed, decodeJson, encodeJson } from "./shared";

export interface RepositoryEventInput {
  id: string;
  provider: string;
  deliveryId: string;
  eventKind: string;
  action: string;
  repositoryId: string;
  resourceType: string;
  resourceId: string;
  actor: unknown;
  resourceAuthor: unknown | null;
  facts: unknown;
  envelope: unknown;
  envelopeHash: string;
  occurredAt: string | null;
}

interface EventRow {
  id: string;
  schema_version: number;
  provider: string;
  delivery_id: string;
  event_kind: string;
  action: string;
  repository_id: string;
  resource_type: string;
  resource_id: string;
  actor_json: string;
  resource_author_json: string | null;
  facts_json: string;
  envelope_json: string;
  envelope_hash: string;
  occurred_at: string | null;
  received_at: string;
  admission_status: "pending" | "processing" | "completed";
  admission_token: string | null;
  admission_lease_expires_at: string | null;
  admission_completed_at: string | null;
}

export interface RepositoryEventDto {
  id: string;
  schemaVersion: 2;
  provider: string;
  deliveryId: string;
  eventKind: string;
  action: string;
  repositoryId: string;
  resourceType: string;
  resourceId: string;
  actor: unknown;
  resourceAuthor: unknown | null;
  facts: unknown;
  envelope: unknown;
  envelopeHash: string;
  occurredAt: string | null;
  receivedAt: string;
  admissionStatus: "pending" | "processing" | "completed";
  admissionCompletedAt: string | null;
}

function eventDto(row: EventRow): RepositoryEventDto {
  return {
    id: row.id,
    schemaVersion: 2,
    provider: row.provider,
    deliveryId: row.delivery_id,
    eventKind: row.event_kind,
    action: row.action,
    repositoryId: row.repository_id,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    actor: decodeJson(row.actor_json),
    resourceAuthor: decodeJson(row.resource_author_json),
    facts: decodeJson(row.facts_json),
    envelope: decodeJson(row.envelope_json),
    envelopeHash: row.envelope_hash,
    occurredAt: row.occurred_at,
    receivedAt: row.received_at,
    admissionStatus: row.admission_status,
    admissionCompletedAt: row.admission_completed_at,
  };
}

export async function admitRepositoryEvent(
  db: D1Database,
  input: RepositoryEventInput,
): Promise<{ event: RepositoryEventDto; admitted: boolean }> {
  const result = await db.prepare(`
    INSERT OR IGNORE INTO repository_events (
      id, schema_version, provider, delivery_id, event_kind, action, repository_id,
      resource_type, resource_id, actor_json, resource_author_json, facts_json,
      envelope_json, envelope_hash, occurred_at
    ) VALUES (?, 2, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    input.id,
    input.provider,
    input.deliveryId,
    input.eventKind,
    input.action,
    input.repositoryId,
    input.resourceType,
    input.resourceId,
    encodeJson(input.actor),
    input.resourceAuthor === null ? null : encodeJson(input.resourceAuthor),
    encodeJson(input.facts),
    encodeJson(input.envelope),
    input.envelopeHash,
    input.occurredAt,
  ).run();
  const row = await db.prepare(`
    SELECT * FROM repository_events WHERE provider = ? AND delivery_id = ?
  `).bind(input.provider, input.deliveryId).first<EventRow>();
  if (!row) throw new Error("Repository event admission failed");
  if (
    row.envelope_hash !== input.envelopeHash
    || row.repository_id !== input.repositoryId
    || row.event_kind !== input.eventKind
    || row.action !== input.action
    || row.resource_type !== input.resourceType
    || row.resource_id !== input.resourceId
  ) {
    throw new Error("Repository event dedupe conflict");
  }
  return { event: eventDto(row), admitted: changed(result) };
}

export async function getRepositoryEvent(db: D1Database, eventId: string): Promise<RepositoryEventDto | null> {
  const row = await db.prepare("SELECT * FROM repository_events WHERE id = ?").bind(eventId).first<EventRow>();
  return row ? eventDto(row) : null;
}

export async function claimRepositoryEventAdmission(
  db: D1Database,
  input: { eventId: string; token: string; now: string; leaseExpiresAt: string },
): Promise<boolean> {
  const result = await db.prepare(`
    UPDATE repository_events
    SET admission_status = 'processing', admission_token = ?, admission_lease_expires_at = ?
    WHERE id = ? AND (
      admission_status = 'pending'
      OR (admission_status = 'processing' AND admission_lease_expires_at <= ?)
    )
  `).bind(input.token, input.leaseExpiresAt, input.eventId, input.now).run();
  return changed(result);
}

export async function completeRepositoryEventAdmission(
  db: D1Database,
  input: { eventId: string; token: string; now: string },
): Promise<boolean> {
  const result = await db.prepare(`
    UPDATE repository_events
    SET admission_status = 'completed', admission_token = NULL,
      admission_lease_expires_at = NULL, admission_completed_at = ?
    WHERE id = ? AND admission_status = 'processing' AND admission_token = ?
  `).bind(input.now, input.eventId, input.token).run();
  return changed(result);
}

export async function releaseRepositoryEventAdmission(
  db: D1Database,
  input: { eventId: string; token: string },
): Promise<boolean> {
  const result = await db.prepare(`
    UPDATE repository_events
    SET admission_status = 'pending', admission_token = NULL, admission_lease_expires_at = NULL
    WHERE id = ? AND admission_status = 'processing' AND admission_token = ?
  `).bind(input.eventId, input.token).run();
  return changed(result);
}

export async function listRepositoryEventRunIds(db: D1Database, eventId: string): Promise<string[]> {
  const { results } = await db.prepare("SELECT id FROM agent_runs WHERE repository_event_id = ? ORDER BY id")
    .bind(eventId).all<{ id: string }>();
  return results.map((row) => row.id);
}

export type RunKind = "live" | "simulation" | "manual" | "scheduled";
export type RunStatus = "admitted" | "queued" | "running" | "waiting" | "completed" | "completed_with_errors" | "failed" | "cancelled";

export interface CreateRunInput {
  id: string;
  kind: RunKind;
  repositoryEventId: string | null;
  agentId: string;
  agentRevisionId: string;
  workflowInstanceId: string | null;
  parentRunId: string | null;
  status: RunStatus;
  runSnapshot: unknown;
  runSnapshotHash: string;
  policySnapshot: unknown;
  policySnapshotHash: string;
  capabilitySnapshot: unknown;
  capabilitySnapshotHash: string;
  harnessId: string;
  harnessVersion: string;
  budgets: unknown;
  /** Migration 0007 live authority binding. Omitted only for pre-v7/history compatibility. */
  repositoryId?: string | null;
  assignmentId?: string | null;
  assignmentVersion?: number | null;
  assignmentConfigHash?: string | null;
  repositoryPolicyHash?: string | null;
  repositoryPolicyVersion?: number | null;
}

interface RunRow {
  id: string;
  kind: RunKind;
  repository_event_id: string | null;
  agent_id: string;
  agent_revision_id: string;
  workflow_instance_id: string | null;
  parent_run_id: string | null;
  status: RunStatus;
  run_snapshot_json: string;
  run_snapshot_hash: string;
  policy_snapshot_json: string;
  policy_snapshot_hash: string;
  capability_snapshot_json: string;
  capability_snapshot_hash: string;
  harness_id: string;
  harness_version: string;
  budgets_json: string;
  usage_json: string;
  error_json: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  repository_id?: string | null;
  assignment_id?: string | null;
  assignment_version?: number | null;
  assignment_config_hash?: string | null;
  repository_policy_hash?: string | null;
  repository_policy_version?: number | null;
}

export interface RunDto {
  id: string;
  kind: RunKind;
  repositoryEventId: string | null;
  agentId: string;
  agentRevisionId: string;
  workflowInstanceId: string | null;
  parentRunId: string | null;
  status: RunStatus;
  runSnapshot: unknown;
  runSnapshotHash: string;
  policySnapshot: unknown;
  policySnapshotHash: string;
  capabilitySnapshot: unknown;
  capabilitySnapshotHash: string;
  harnessId: string;
  harnessVersion: string;
  budgets: unknown;
  usage: unknown;
  error: unknown | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  repositoryId: string | null;
  assignmentId: string | null;
  assignmentVersion: number | null;
  assignmentConfigHash: string | null;
  repositoryPolicyHash: string | null;
  repositoryPolicyVersion: number | null;
}

function runDto(row: RunRow): RunDto {
  return {
    id: row.id,
    kind: row.kind,
    repositoryEventId: row.repository_event_id,
    agentId: row.agent_id,
    agentRevisionId: row.agent_revision_id,
    workflowInstanceId: row.workflow_instance_id,
    parentRunId: row.parent_run_id,
    status: row.status,
    runSnapshot: decodeJson(row.run_snapshot_json),
    runSnapshotHash: row.run_snapshot_hash,
    policySnapshot: decodeJson(row.policy_snapshot_json),
    policySnapshotHash: row.policy_snapshot_hash,
    capabilitySnapshot: decodeJson(row.capability_snapshot_json),
    capabilitySnapshotHash: row.capability_snapshot_hash,
    harnessId: row.harness_id,
    harnessVersion: row.harness_version,
    budgets: decodeJson(row.budgets_json),
    usage: decodeJson(row.usage_json),
    error: decodeJson(row.error_json),
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    repositoryId: row.repository_id ?? null,
    assignmentId: row.assignment_id ?? null,
    assignmentVersion: row.assignment_version ?? null,
    assignmentConfigHash: row.assignment_config_hash ?? null,
    repositoryPolicyHash: row.repository_policy_hash ?? null,
    repositoryPolicyVersion: row.repository_policy_version ?? null,
  };
}

interface RunBinding {
  repositoryId: string;
  assignmentId: string;
  assignmentVersion: number;
  assignmentConfigHash: string;
  repositoryPolicyHash: string;
  repositoryPolicyVersion: number;
}

function runBinding(input: CreateRunInput): RunBinding | null {
  const values = [input.repositoryId, input.assignmentId, input.assignmentVersion, input.assignmentConfigHash,
    input.repositoryPolicyHash, input.repositoryPolicyVersion];
  const supplied = values.filter((value) => value !== undefined && value !== null).length;
  if (supplied !== 0 && supplied !== values.length) {
    throw new Error("Run binding must include all six binding fields");
  }
  if (supplied === 0) {
    if (input.kind === "live") throw new Error("Live runs require a complete binding");
    return null;
  }
  return {
    repositoryId: input.repositoryId as string,
    assignmentId: input.assignmentId as string,
    assignmentVersion: input.assignmentVersion as number,
    assignmentConfigHash: input.assignmentConfigHash as string,
    repositoryPolicyHash: input.repositoryPolicyHash as string,
    repositoryPolicyVersion: input.repositoryPolicyVersion as number,
  };
}

function assertRunIdentity(row: RunRow, input: CreateRunInput, binding: RunBinding | null): void {
  if (
    row.kind !== input.kind
    || row.repository_event_id !== input.repositoryEventId
    || row.agent_id !== input.agentId
    || row.agent_revision_id !== input.agentRevisionId
    || row.workflow_instance_id !== input.workflowInstanceId
    || row.parent_run_id !== input.parentRunId
    || row.run_snapshot_hash !== input.runSnapshotHash
    || row.policy_snapshot_hash !== input.policySnapshotHash
    || row.capability_snapshot_hash !== input.capabilitySnapshotHash
    || row.harness_id !== input.harnessId
    || row.harness_version !== input.harnessVersion
    || (row.repository_id ?? null) !== (binding?.repositoryId ?? null)
    || (row.assignment_id ?? null) !== (binding?.assignmentId ?? null)
    || (row.assignment_version ?? null) !== (binding?.assignmentVersion ?? null)
    || (row.assignment_config_hash ?? null) !== (binding?.assignmentConfigHash ?? null)
    || (row.repository_policy_hash ?? null) !== (binding?.repositoryPolicyHash ?? null)
    || (row.repository_policy_version ?? null) !== (binding?.repositoryPolicyVersion ?? null)
  ) {
    throw new Error("Run dedupe conflict");
  }
}

export async function getRun(db: D1Database, runId: string): Promise<RunDto | null> {
  const row = await db.prepare("SELECT * FROM agent_runs WHERE id = ?").bind(runId).first<RunRow>();
  return row ? runDto(row) : null;
}

export async function createRun(db: D1Database, input: CreateRunInput): Promise<{ run: RunDto; created: boolean }> {
  const binding = runBinding(input);
  const baseValues = [input.id, input.kind, input.repositoryEventId, input.agentId, input.agentRevisionId,
    input.workflowInstanceId, input.parentRunId, input.status, encodeJson(input.runSnapshot), input.runSnapshotHash,
    encodeJson(input.policySnapshot), input.policySnapshotHash, encodeJson(input.capabilitySnapshot),
    input.capabilitySnapshotHash, input.harnessId, input.harnessVersion, encodeJson(input.budgets)] as const;
  const result = binding
    ? await db.prepare(`INSERT OR IGNORE INTO agent_runs (
        id, kind, repository_event_id, agent_id, agent_revision_id, workflow_instance_id, parent_run_id, status,
        run_snapshot_json, run_snapshot_hash, policy_snapshot_json, policy_snapshot_hash, capability_snapshot_json,
        capability_snapshot_hash, harness_id, harness_version, budgets_json, repository_id, assignment_id,
        assignment_version, assignment_config_hash, repository_policy_hash, repository_policy_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(...baseValues, binding.repositoryId, binding.assignmentId, binding.assignmentVersion,
        binding.assignmentConfigHash, binding.repositoryPolicyHash, binding.repositoryPolicyVersion).run()
    : await db.prepare(`INSERT OR IGNORE INTO agent_runs (
        id, kind, repository_event_id, agent_id, agent_revision_id, workflow_instance_id, parent_run_id, status,
        run_snapshot_json, run_snapshot_hash, policy_snapshot_json, policy_snapshot_hash, capability_snapshot_json,
        capability_snapshot_hash, harness_id, harness_version, budgets_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(...baseValues).run();

  let row = await db.prepare("SELECT * FROM agent_runs WHERE id = ?").bind(input.id).first<RunRow>();
  if (!row && input.kind === "live" && input.repositoryEventId !== null) {
    row = await db.prepare(`
      SELECT * FROM agent_runs
      WHERE kind = 'live' AND repository_event_id = ? AND agent_id = ? AND agent_revision_id = ?
    `).bind(input.repositoryEventId, input.agentId, input.agentRevisionId).first<RunRow>();
  }
  if (!row) throw new Error("Run creation failed");
  assertRunIdentity(row, input, binding);
  return { run: runDto(row), created: changed(result) };
}

export async function admitEventAgentRun(
  db: D1Database,
  input: CreateRunInput & { admissionId: string; admissionKey: string },
): Promise<{ run: RunDto; created: boolean }> {
  if (input.kind !== "live" || input.repositoryEventId === null) {
    throw new Error("Event admission requires a live run and repository event");
  }
  const binding = runBinding(input);
  if (!binding) throw new Error("Live runs require a complete binding");

  const existingAdmission = await db.prepare(`
    SELECT admission_key FROM event_agent_admissions
    WHERE event_id = ? AND agent_id = ? AND revision_id = ?
  `).bind(input.repositoryEventId, input.agentId, input.agentRevisionId)
    .first<{ admission_key: string }>();
  if (existingAdmission && existingAdmission.admission_key !== input.admissionKey) {
    throw new Error("Event Agent admission conflict");
  }
  if (existingAdmission) {
    const existingRun = await db.prepare(`
      SELECT * FROM agent_runs
      WHERE kind = 'live' AND repository_event_id = ? AND agent_id = ? AND agent_revision_id = ?
    `).bind(input.repositoryEventId, input.agentId, input.agentRevisionId).first<RunRow>();
    if (existingRun) return { run: runDto(existingRun), created: false };
  }

  const runValues = [input.id, input.kind, input.repositoryEventId, input.agentId, input.agentRevisionId,
    input.workflowInstanceId, input.parentRunId, input.status, encodeJson(input.runSnapshot), input.runSnapshotHash,
    encodeJson(input.policySnapshot), input.policySnapshotHash, encodeJson(input.capabilitySnapshot), input.capabilitySnapshotHash,
    input.harnessId, input.harnessVersion, encodeJson(input.budgets)] as const;
  const admissionGuardValues = [input.repositoryEventId, input.agentId, input.agentRevisionId, input.admissionKey] as const;
  const runInsert = db.prepare(`INSERT INTO agent_runs (
      id, kind, repository_event_id, agent_id, agent_revision_id, workflow_instance_id, parent_run_id, status,
      run_snapshot_json, run_snapshot_hash, policy_snapshot_json, policy_snapshot_hash, capability_snapshot_json,
      capability_snapshot_hash, harness_id, harness_version, budgets_json, repository_id, assignment_id,
      assignment_version, assignment_config_hash, repository_policy_hash, repository_policy_version)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE EXISTS (SELECT 1 FROM event_agent_admissions WHERE event_id=? AND agent_id=? AND revision_id=? AND admission_key=?)
      AND NOT EXISTS (
        SELECT 1 FROM agent_runs
        WHERE kind='live' AND repository_event_id=? AND agent_id=? AND agent_revision_id=?
      )
    ON CONFLICT(repository_event_id, agent_id, agent_revision_id) WHERE kind='live' DO NOTHING`)
    .bind(...runValues, binding.repositoryId, binding.assignmentId, binding.assignmentVersion,
      binding.assignmentConfigHash, binding.repositoryPolicyHash, binding.repositoryPolicyVersion,
      ...admissionGuardValues, input.repositoryEventId, input.agentId, input.agentRevisionId);
  const results = await db.batch([
    db.prepare(`INSERT INTO event_agent_admissions (id,event_id,agent_id,revision_id,admission_key,status)
      VALUES (?, ?, ?, ?, ?, 'admitted') ON CONFLICT(event_id,agent_id,revision_id) DO NOTHING`).bind(
      input.admissionId, input.repositoryEventId, input.agentId, input.agentRevisionId, input.admissionKey),
    runInsert,
  ]);

  const admission = await db.prepare(`
    SELECT admission_key FROM event_agent_admissions
    WHERE event_id = ? AND agent_id = ? AND revision_id = ?
  `).bind(input.repositoryEventId, input.agentId, input.agentRevisionId)
    .first<{ admission_key: string }>();
  if (!admission || admission.admission_key !== input.admissionKey) {
    throw new Error("Event Agent admission conflict");
  }

  const row = await db.prepare(`
    SELECT * FROM agent_runs
    WHERE kind = 'live' AND repository_event_id = ? AND agent_id = ? AND agent_revision_id = ?
  `).bind(input.repositoryEventId, input.agentId, input.agentRevisionId).first<RunRow>();
  if (!row) throw new Error("Event Agent run creation failed");
  const created = changed(results[1]);
  // A concurrent redelivery may have frozen an older assignment/policy snapshot.
  // The live uniqueness key wins; never rebind or reject that original run.
  if (created) assertRunIdentity(row, input, binding);
  else if (row.repository_event_id !== input.repositoryEventId || row.agent_id !== input.agentId || row.agent_revision_id !== input.agentRevisionId) {
    throw new Error("Event Agent run identity conflict");
  }
  return { run: runDto(row), created };
}

const allowedRunTransitions: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  admitted: ["queued", "running", "failed", "cancelled"],
  queued: ["running", "failed", "cancelled"],
  running: ["waiting", "completed", "completed_with_errors", "failed", "cancelled"],
  waiting: ["running", "completed", "completed_with_errors", "failed", "cancelled"],
  completed: [],
  completed_with_errors: [],
  failed: [],
  cancelled: [],
};

export async function updateRunState(
  db: D1Database,
  input: { runId: string; expectedStatus: RunStatus; status: RunStatus; usage: unknown; error: unknown | null },
): Promise<RunDto> {
  const current = await getRun(db, input.runId);
  if (!current) throw new Error("Run not found");
  if (current.status === input.status) return current;
  if (current.status !== input.expectedStatus || !allowedRunTransitions[input.expectedStatus].includes(input.status)) {
    throw new Error(`Invalid or stale run transition from ${current.status} to ${input.status}`);
  }
  const result = await db.prepare(`
    UPDATE agent_runs SET status = ?, usage_json = ?, error_json = ?,
      started_at = CASE WHEN ? = 'running' THEN COALESCE(started_at, CURRENT_TIMESTAMP) ELSE started_at END,
      completed_at = CASE WHEN ? IN ('completed', 'completed_with_errors', 'failed', 'cancelled') THEN CURRENT_TIMESTAMP ELSE completed_at END
    WHERE id = ? AND status = ?
  `).bind(
    input.status,
    encodeJson(input.usage),
    input.error === null ? null : encodeJson(input.error),
    input.status,
    input.status,
    input.runId,
    input.expectedStatus,
  ).run();
  if (!changed(result)) throw new Error("Stale run state update");
  const run = await getRun(db, input.runId);
  if (!run || run.status !== input.status) throw new Error("Run state update failed");
  return run;
}

export type RunTaskStatus = "pending" | "running" | "waiting" | "completed" | "failed" | "cancelled";

export interface CreateRunTaskInput {
  id: string;
  runId: string;
  parentTaskId: string | null;
  stableKey: string;
  kind: string;
  parallelGroup: string | null;
  depth: number;
  assignedAgentId: string | null;
  assignedRevisionId: string | null;
  input: unknown;
  inputHash: string;
  budgets: unknown;
}

interface RunTaskRow {
  id: string;
  run_id: string;
  parent_task_id: string | null;
  stable_key: string;
  kind: string;
  status: RunTaskStatus;
  parallel_group: string | null;
  depth: number;
  assigned_agent_id: string | null;
  assigned_revision_id: string | null;
  input_json: string;
  input_hash: string;
  budgets_json: string;
  usage_json: string;
  result_json: string | null;
  result_hash: string | null;
  error_json: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface RunTaskDto {
  id: string;
  runId: string;
  parentTaskId: string | null;
  stableKey: string;
  kind: string;
  status: RunTaskStatus;
  parallelGroup: string | null;
  depth: number;
  assignedAgentId: string | null;
  assignedRevisionId: string | null;
  input: unknown;
  inputHash: string;
  budgets: unknown;
  usage: unknown;
  result: unknown | null;
  resultHash: string | null;
  error: unknown | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

function taskDto(row: RunTaskRow): RunTaskDto {
  return {
    id: row.id,
    runId: row.run_id,
    parentTaskId: row.parent_task_id,
    stableKey: row.stable_key,
    kind: row.kind,
    status: row.status,
    parallelGroup: row.parallel_group,
    depth: row.depth,
    assignedAgentId: row.assigned_agent_id,
    assignedRevisionId: row.assigned_revision_id,
    input: decodeJson(row.input_json),
    inputHash: row.input_hash,
    budgets: decodeJson(row.budgets_json),
    usage: decodeJson(row.usage_json),
    result: decodeJson(row.result_json),
    resultHash: row.result_hash,
    error: decodeJson(row.error_json),
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

export async function getRunTask(db: D1Database, taskId: string): Promise<RunTaskDto | null> {
  const row = await db.prepare("SELECT * FROM run_tasks WHERE id = ?").bind(taskId).first<RunTaskRow>();
  return row ? taskDto(row) : null;
}

export async function createRunTask(db: D1Database, input: CreateRunTaskInput): Promise<{ task: RunTaskDto; created: boolean }> {
  const result = await db.prepare(`
    INSERT OR IGNORE INTO run_tasks (
      id, run_id, parent_task_id, stable_key, kind, status, parallel_group,
      depth, assigned_agent_id, assigned_revision_id, input_json, input_hash, budgets_json
    ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    input.id,
    input.runId,
    input.parentTaskId,
    input.stableKey,
    input.kind,
    input.parallelGroup,
    input.depth,
    input.assignedAgentId,
    input.assignedRevisionId,
    encodeJson(input.input),
    input.inputHash,
    encodeJson(input.budgets),
  ).run();
  const row = await db.prepare("SELECT * FROM run_tasks WHERE run_id = ? AND stable_key = ?")
    .bind(input.runId, input.stableKey).first<RunTaskRow>();
  if (!row) throw new Error("Run task creation failed");
  if (
    row.parent_task_id !== input.parentTaskId
    || row.kind !== input.kind
    || row.parallel_group !== input.parallelGroup
    || row.depth !== input.depth
    || row.assigned_agent_id !== input.assignedAgentId
    || row.assigned_revision_id !== input.assignedRevisionId
    || row.input_hash !== input.inputHash
  ) throw new Error("Run task dedupe conflict");
  return { task: taskDto(row), created: changed(result) };
}

export async function claimRunTask(db: D1Database, taskId: string, inputHash: string): Promise<boolean> {
  const result = await db.prepare(`
    UPDATE run_tasks SET status = 'running', started_at = COALESCE(started_at, CURRENT_TIMESTAMP)
    WHERE id = ? AND input_hash = ? AND status = 'pending'
  `).bind(taskId, inputHash).run();
  return changed(result);
}

export async function waitRunTask(db: D1Database, taskId: string, inputHash: string): Promise<boolean> {
  const result = await db.prepare("UPDATE run_tasks SET status = 'waiting' WHERE id = ? AND input_hash = ? AND status = 'running'")
    .bind(taskId, inputHash).run();
  return changed(result);
}

export async function resumeRunTask(db: D1Database, taskId: string, inputHash: string): Promise<boolean> {
  const result = await db.prepare("UPDATE run_tasks SET status = 'pending' WHERE id = ? AND input_hash = ? AND status = 'waiting'")
    .bind(taskId, inputHash).run();
  return changed(result);
}

export async function completeRunTask(
  db: D1Database,
  input: { taskId: string; inputHash: string; result: unknown; resultHash: string; usage: unknown },
): Promise<boolean> {
  const result = await db.prepare(`
    UPDATE run_tasks SET status = 'completed', result_json = ?, result_hash = ?,
      usage_json = ?, completed_at = CURRENT_TIMESTAMP
    WHERE id = ? AND input_hash = ? AND status = 'running'
  `).bind(encodeJson(input.result), input.resultHash, encodeJson(input.usage), input.taskId, input.inputHash).run();
  return changed(result);
}

export async function failRunTask(
  db: D1Database,
  input: { taskId: string; inputHash: string; error: unknown; usage: unknown },
): Promise<boolean> {
  const result = await db.prepare(`
    UPDATE run_tasks SET status = 'failed', error_json = ?, usage_json = ?, completed_at = CURRENT_TIMESTAMP
    WHERE id = ? AND input_hash = ? AND status IN ('pending', 'running', 'waiting')
  `).bind(encodeJson(input.error), encodeJson(input.usage), input.taskId, input.inputHash).run();
  return changed(result);
}

export async function cancelRunTask(db: D1Database, taskId: string, inputHash: string): Promise<boolean> {
  const result = await db.prepare(`
    UPDATE run_tasks SET status = 'cancelled', completed_at = CURRENT_TIMESTAMP
    WHERE id = ? AND input_hash = ? AND status IN ('pending', 'running', 'waiting')
  `).bind(taskId, inputHash).run();
  return changed(result);
}

export type RunStepKind = "model" | "tool" | "checkpoint" | "effect" | "wait" | "workspace" | "evaluation";
export type RunStepStatus = "pending" | "running" | "waiting" | "succeeded" | "failed" | "cancelled";

export interface CreateRunStepInput {
  id: string;
  runId: string;
  taskId: string | null;
  stableKey: string;
  kind: RunStepKind;
  input: unknown;
  inputHash: string;
  maxAttempts: number;
}

interface RunStepRow {
  id: string;
  run_id: string;
  task_id: string | null;
  stable_key: string;
  kind: RunStepKind;
  status: RunStepStatus;
  input_json: string;
  input_hash: string;
  attempt_count: number;
  max_attempts: number;
  result_json: string | null;
  result_hash: string | null;
  artifact_refs_json: string;
  error_json: string | null;
  retry_at: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface RunStepDto {
  id: string;
  runId: string;
  taskId: string | null;
  stableKey: string;
  kind: RunStepKind;
  status: RunStepStatus;
  input: unknown;
  inputHash: string;
  attemptCount: number;
  maxAttempts: number;
  result: unknown | null;
  resultHash: string | null;
  artifactRefs: unknown;
  error: unknown | null;
  retryAt: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

function stepDto(row: RunStepRow): RunStepDto {
  return {
    id: row.id,
    runId: row.run_id,
    taskId: row.task_id,
    stableKey: row.stable_key,
    kind: row.kind,
    status: row.status,
    input: decodeJson(row.input_json),
    inputHash: row.input_hash,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    result: decodeJson(row.result_json),
    resultHash: row.result_hash,
    artifactRefs: decodeJson(row.artifact_refs_json),
    error: decodeJson(row.error_json),
    retryAt: row.retry_at,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

export async function getRunStep(db: D1Database, stepId: string): Promise<RunStepDto | null> {
  const row = await db.prepare("SELECT * FROM run_steps WHERE id = ?").bind(stepId).first<RunStepRow>();
  return row ? stepDto(row) : null;
}

export async function createRunStep(db: D1Database, input: CreateRunStepInput): Promise<{ step: RunStepDto; created: boolean }> {
  const result = await db.prepare(`
    INSERT OR IGNORE INTO run_steps
      (id, run_id, task_id, stable_key, kind, status, input_json, input_hash, max_attempts)
    VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)
  `).bind(
    input.id,
    input.runId,
    input.taskId,
    input.stableKey,
    input.kind,
    encodeJson(input.input),
    input.inputHash,
    input.maxAttempts,
  ).run();
  const row = await db.prepare("SELECT * FROM run_steps WHERE run_id = ? AND stable_key = ?")
    .bind(input.runId, input.stableKey).first<RunStepRow>();
  if (!row) throw new Error("Run step creation failed");
  if (row.task_id !== input.taskId || row.kind !== input.kind || row.input_hash !== input.inputHash || row.max_attempts !== input.maxAttempts) {
    throw new Error("Run step dedupe conflict");
  }
  return { step: stepDto(row), created: changed(result) };
}

export async function claimRunStep(
  db: D1Database,
  input: { stepId: string; inputHash: string; now: string },
): Promise<boolean> {
  const result = await db.prepare(`
    UPDATE run_steps SET status = 'running', attempt_count = attempt_count + 1,
      started_at = COALESCE(started_at, CURRENT_TIMESTAMP), error_json = NULL,
      retry_at = NULL, completed_at = NULL
    WHERE id = ? AND input_hash = ? AND status IN ('pending', 'failed')
      AND attempt_count < max_attempts AND (retry_at IS NULL OR retry_at <= ?)
  `).bind(input.stepId, input.inputHash, input.now).run();
  return changed(result);
}

export async function waitRunStep(db: D1Database, stepId: string, inputHash: string): Promise<boolean> {
  const result = await db.prepare("UPDATE run_steps SET status = 'waiting' WHERE id = ? AND input_hash = ? AND status = 'running'")
    .bind(stepId, inputHash).run();
  return changed(result);
}

export async function resumeRunStep(db: D1Database, stepId: string, inputHash: string): Promise<boolean> {
  const result = await db.prepare("UPDATE run_steps SET status = 'pending' WHERE id = ? AND input_hash = ? AND status = 'waiting'")
    .bind(stepId, inputHash).run();
  return changed(result);
}

export async function failRunStep(
  db: D1Database,
  input: { stepId: string; inputHash: string; error: unknown; retryAt: string | null },
): Promise<boolean> {
  const result = await db.prepare(`
    UPDATE run_steps SET status = 'failed', error_json = ?, retry_at = ?, completed_at = CURRENT_TIMESTAMP
    WHERE id = ? AND input_hash = ? AND status = 'running'
  `).bind(encodeJson(input.error), input.retryAt, input.stepId, input.inputHash).run();
  return changed(result);
}

export async function cancelRunStep(db: D1Database, stepId: string, inputHash: string): Promise<boolean> {
  const result = await db.prepare(`
    UPDATE run_steps SET status = 'cancelled', completed_at = CURRENT_TIMESTAMP
    WHERE id = ? AND input_hash = ? AND status IN ('pending', 'running', 'waiting', 'failed')
  `).bind(stepId, inputHash).run();
  return changed(result);
}

export async function completeRunStep(
  db: D1Database,
  input: { stepId: string; inputHash: string; result: unknown; resultHash: string; artifactRefs: unknown },
): Promise<boolean> {
  const result = await db.prepare(`
    UPDATE run_steps SET status = 'succeeded', result_json = ?, result_hash = ?,
      artifact_refs_json = ?, completed_at = CURRENT_TIMESTAMP
    WHERE id = ? AND input_hash = ? AND status = 'running'
  `).bind(
    encodeJson(input.result),
    input.resultHash,
    encodeJson(input.artifactRefs),
    input.stepId,
    input.inputHash,
  ).run();
  return changed(result);
}

export interface CreateArtifactInput {
  id: string;
  runId: string;
  taskId: string | null;
  stepId: string | null;
  kind: string;
  r2Key: string;
  contentHash: string;
  sizeBytes: number;
  mediaType: string;
  retentionUntil: string;
  metadata: unknown;
}

export async function createRunArtifact(db: D1Database, input: CreateArtifactInput): Promise<void> {
  await db.prepare(`
    INSERT INTO run_artifacts (
      id, run_id, task_id, step_id, kind, r2_key, content_hash, size_bytes,
      media_type, retention_until, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    input.id,
    input.runId,
    input.taskId,
    input.stepId,
    input.kind,
    input.r2Key,
    input.contentHash,
    input.sizeBytes,
    input.mediaType,
    input.retentionUntil,
    encodeJson(input.metadata),
  ).run();
}
