import { operationSchema, type OperationReceipt } from "@gardener/contracts";
import { canonicalOperationHash, canonicalSha256, validateOperationReceiptBinding } from "@gardener/core";
import { changed, decodeJson, encodeJson, type PolicyMode } from "./shared";

export type InterruptionKind = "clarification" | "capability" | "plan_review" | "effect_approval" | "patch_review" | "budget";
export type InterruptionStatus = "pending" | "responded" | "rejected" | "expired" | "cancelled";

export interface CreateInterruptionInput {
  id: string;
  runId: string;
  taskId: string | null;
  stepId: string | null;
  kind: InterruptionKind;
  eligibleResponders: unknown;
  eligibleRespondersHash: string;
  requestPayload: unknown;
  requestPayloadHash: string;
  nonceHash: string;
  expiresAt: string;
}

interface InterruptionRow {
  id: string;
  run_id: string;
  task_id: string | null;
  step_id: string | null;
  kind: InterruptionKind;
  status: InterruptionStatus;
  eligible_responders_json: string;
  eligible_responders_hash: string;
  request_payload_json: string;
  request_payload_hash: string;
  response_payload_json: string | null;
  response_payload_hash: string | null;
  nonce_hash: string;
  expires_at: string;
  responded_by: string | null;
  responded_at: string | null;
  terminal_at: string | null;
  created_at: string;
}

export interface InterruptionDto {
  id: string;
  runId: string;
  taskId: string | null;
  stepId: string | null;
  kind: InterruptionKind;
  status: InterruptionStatus;
  eligibleResponders: unknown;
  eligibleRespondersHash: string;
  requestPayload: unknown;
  requestPayloadHash: string;
  responsePayload: unknown | null;
  responsePayloadHash: string | null;
  expiresAt: string;
  respondedBy: string | null;
  respondedAt: string | null;
  terminalAt: string | null;
  createdAt: string;
}

function interruptionDto(row: InterruptionRow): InterruptionDto {
  return {
    id: row.id,
    runId: row.run_id,
    taskId: row.task_id,
    stepId: row.step_id,
    kind: row.kind,
    status: row.status,
    eligibleResponders: decodeJson(row.eligible_responders_json),
    eligibleRespondersHash: row.eligible_responders_hash,
    requestPayload: decodeJson(row.request_payload_json),
    requestPayloadHash: row.request_payload_hash,
    responsePayload: decodeJson(row.response_payload_json),
    responsePayloadHash: row.response_payload_hash,
    expiresAt: row.expires_at,
    respondedBy: row.responded_by,
    respondedAt: row.responded_at,
    terminalAt: row.terminal_at,
    createdAt: row.created_at,
  };
}

export async function createInterruption(db: D1Database, input: CreateInterruptionInput): Promise<InterruptionDto> {
  await db.prepare(`
    INSERT INTO run_interruptions (
      id, run_id, task_id, step_id, kind, eligible_responders_json,
      eligible_responders_hash, request_payload_json, request_payload_hash,
      nonce_hash, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    input.id,
    input.runId,
    input.taskId,
    input.stepId,
    input.kind,
    encodeJson(input.eligibleResponders),
    input.eligibleRespondersHash,
    encodeJson(input.requestPayload),
    input.requestPayloadHash,
    input.nonceHash,
    input.expiresAt,
  ).run();
  const result = await getInterruption(db, input.id);
  if (!result) throw new Error("Interruption creation failed");
  return result;
}

export async function getInterruption(db: D1Database, id: string): Promise<InterruptionDto | null> {
  const row = await db.prepare("SELECT * FROM run_interruptions WHERE id = ?").bind(id).first<InterruptionRow>();
  return row ? interruptionDto(row) : null;
}

export type InterruptionClaimResult =
  | { outcome: "accepted"; interruption: InterruptionDto }
  | { outcome: "expired" | "replayed"; interruption: InterruptionDto }
  | { outcome: "invalid" | "ineligible" | "conflict" | "not_found"; interruption: null };

export async function claimInterruptionResponse(
  db: D1Database,
  input: {
    id: string;
    nonceHash: string;
    responderId: string;
    decision: "responded" | "rejected";
    responsePayload: unknown;
    responsePayloadHash: string;
    now: string;
  },
): Promise<InterruptionClaimResult> {
  const response = await db.prepare(`
    UPDATE run_interruptions SET status = ?, response_payload_json = ?,
      response_payload_hash = ?, responded_by = ?, responded_at = ?, terminal_at = ?
    WHERE id = ? AND nonce_hash = ? AND status = 'pending' AND expires_at > ?
      AND EXISTS (
        SELECT 1 FROM json_each(run_interruptions.eligible_responders_json)
        WHERE json_each.type = 'text' AND json_each.value = ?
      )
  `).bind(
    input.decision,
    encodeJson(input.responsePayload),
    input.responsePayloadHash,
    input.responderId,
    input.now,
    input.now,
    input.id,
    input.nonceHash,
    input.now,
    input.responderId,
  ).run();

  if (changed(response)) {
    const interruption = await getInterruption(db, input.id);
    if (!interruption) throw new Error("Claimed interruption disappeared");
    return { outcome: "accepted", interruption };
  }

  const state = await db.prepare(`
    SELECT nonce_hash, status, response_payload_hash, expires_at,
      EXISTS (
        SELECT 1 FROM json_each(run_interruptions.eligible_responders_json)
        WHERE json_each.type = 'text' AND json_each.value = ?
      ) AS eligible
    FROM run_interruptions WHERE id = ?
  `).bind(input.responderId, input.id).first<{
    nonce_hash: string;
    status: InterruptionStatus;
    response_payload_hash: string | null;
    expires_at: string;
    eligible: number;
  }>();
  if (!state) return { outcome: "not_found", interruption: null };
  if (state.nonce_hash !== input.nonceHash) return { outcome: "invalid", interruption: null };
  if (state.eligible !== 1) return { outcome: "ineligible", interruption: null };

  if (state.status !== "pending") {
    if (state.status === "expired") {
      const interruption = await getInterruption(db, input.id);
      if (!interruption) throw new Error("Expired interruption disappeared");
      return { outcome: "expired", interruption };
    }
    if (state.response_payload_hash === input.responsePayloadHash) {
      const interruption = await getInterruption(db, input.id);
      if (!interruption) throw new Error("Replayed interruption disappeared");
      return { outcome: "replayed", interruption };
    }
    return { outcome: "conflict", interruption: null };
  }

  const expiry = await db.prepare(`
    UPDATE run_interruptions SET status = 'expired', terminal_at = ?
    WHERE id = ? AND nonce_hash = ? AND status = 'pending' AND expires_at <= ?
  `).bind(input.now, input.id, input.nonceHash, input.now).run();
  if (changed(expiry)) {
    const interruption = await getInterruption(db, input.id);
    if (!interruption) throw new Error("Expired interruption disappeared");
    return { outcome: "expired", interruption };
  }

  return { outcome: "conflict", interruption: null };
}

export type EffectStatus = "proposed" | "blocked" | "pending_approval" | "approved" | "executing" | "executed" | "rejected" | "failed" | "stale" | "cancelled";

export interface CreateEffectInput {
  id: string;
  operationId: string;
  runId: string;
  taskId: string | null;
  stepId: string | null;
  interruptionId: string | null;
  effectKind: string;
  operation: unknown;
  operationHash: string;
  rationale: string;
  policyMode: PolicyMode;
  policySnapshotHash: string;
  status: "proposed" | "blocked" | "pending_approval" | "approved";
}

interface EffectRow {
  id: string;
  operation_id: string;
  run_id: string;
  task_id: string | null;
  step_id: string | null;
  interruption_id: string | null;
  effect_kind: string;
  operation_json: string;
  operation_hash: string;
  rationale: string;
  policy_mode: PolicyMode;
  policy_snapshot_hash: string;
  status: EffectStatus;
  approval_hash: string | null;
  receipt_json: string | null;
  receipt_hash: string | null;
  error_json: string | null;
  created_at: string;
  decided_at: string | null;
  executed_at: string | null;
}

export interface EffectDto {
  id: string;
  operationId: string;
  runId: string;
  taskId: string | null;
  stepId: string | null;
  interruptionId: string | null;
  effectKind: string;
  operation: unknown;
  operationHash: string;
  rationale: string;
  policyMode: PolicyMode;
  policySnapshotHash: string;
  status: EffectStatus;
  approvalHash: string | null;
  receipt: unknown | null;
  receiptHash: string | null;
  error: unknown | null;
  createdAt: string;
  decidedAt: string | null;
  executedAt: string | null;
}

function effectDto(row: EffectRow): EffectDto {
  return {
    id: row.id,
    operationId: row.operation_id,
    runId: row.run_id,
    taskId: row.task_id,
    stepId: row.step_id,
    interruptionId: row.interruption_id,
    effectKind: row.effect_kind,
    operation: decodeJson(row.operation_json),
    operationHash: row.operation_hash,
    rationale: row.rationale,
    policyMode: row.policy_mode,
    policySnapshotHash: row.policy_snapshot_hash,
    status: row.status,
    approvalHash: row.approval_hash,
    receipt: decodeJson(row.receipt_json),
    receiptHash: row.receipt_hash,
    error: decodeJson(row.error_json),
    createdAt: row.created_at,
    decidedAt: row.decided_at,
    executedAt: row.executed_at,
  };
}

export async function getEffect(db: D1Database, effectId: string): Promise<EffectDto | null> {
  const row = await db.prepare("SELECT * FROM effects WHERE id = ?").bind(effectId).first<EffectRow>();
  return row ? effectDto(row) : null;
}

export async function createEffect(db: D1Database, input: CreateEffectInput): Promise<EffectDto> {
  const operation = operationSchema.parse(input.operation);
  const operationHash = await canonicalOperationHash(operation);
  if (operation.id !== input.operationId || operation.kind !== input.effectKind || operationHash !== input.operationHash) {
    throw new Error("Effect is not bound to the canonical exact operation");
  }
  if (input.status === "approved" && (input.policyMode !== "automatic" || input.interruptionId !== null)) {
    throw new Error("Only an automatic policy decision may create an approved effect");
  }
  await db.prepare(`
    INSERT OR IGNORE INTO effects (
      id, operation_id, run_id, task_id, step_id, interruption_id, effect_kind,
      operation_json, operation_hash, rationale, policy_mode, policy_snapshot_hash, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    input.id,
    input.operationId,
    input.runId,
    input.taskId,
    input.stepId,
    input.interruptionId,
    input.effectKind,
    encodeJson(operation),
    operationHash,
    input.rationale,
    input.policyMode,
    input.policySnapshotHash,
    input.status,
  ).run();
  const effect = await getEffect(db, input.id);
  if (!effect) throw new Error("Effect creation failed");
  if (
    effect.operationId !== input.operationId
    || effect.runId !== input.runId
    || effect.operationHash !== operationHash
    || effect.effectKind !== operation.kind
    || effect.policyMode !== input.policyMode
    || effect.policySnapshotHash !== input.policySnapshotHash
  ) throw new Error("Effect dedupe conflict");
  return effect;
}

export async function claimEffectExecution(
  db: D1Database,
  input: { effectId: string; operationHash: string },
): Promise<boolean> {
  const result = await db.prepare(`
    UPDATE effects SET status = 'executing'
    WHERE id = ? AND operation_hash = ? AND status = 'approved'
  `).bind(input.effectId, input.operationHash).run();
  if (changed(result)) return true;
  const effect = await getEffect(db, input.effectId);
  return effect?.status === "executing" && effect.operationHash === input.operationHash;
}

export async function recordEffectOutcome(
  db: D1Database,
  input: { effectId: string; operationHash: string; receipt: unknown },
): Promise<{ effect: EffectDto; receipt: Readonly<OperationReceipt>; retryable: boolean }> {
  const effect = await getEffect(db, input.effectId);
  if (!effect || effect.status !== "executing" || effect.operationHash !== input.operationHash) {
    throw new Error("Effect execution claim is stale or invalid");
  }
  const receipt = await validateOperationReceiptBinding(input.receipt, effect.operation);
  const receiptHash = await canonicalSha256(receipt);
  const status: EffectStatus = receipt.status === "succeeded" || receipt.status === "skipped"
    ? "executed"
    : receipt.status === "conflicted"
      ? "stale"
      : receipt.error?.retryable
        ? "executing"
        : "failed";
  const error = receipt.error ?? (receipt.status === "conflicted"
    ? { code: "operation_conflicted", message: "The exact operation no longer matched live provider state", retryable: false }
    : null);
  const result = await db.prepare(`
    UPDATE effects SET status = ?, receipt_json = ?, receipt_hash = ?, error_json = ?,
      executed_at = CASE WHEN ? = 'executed' THEN ? ELSE executed_at END
    WHERE id = ? AND operation_hash = ? AND status = 'executing'
  `).bind(
    status,
    encodeJson(receipt),
    receiptHash,
    error === null ? null : encodeJson(error),
    status,
    receipt.completedAt,
    input.effectId,
    input.operationHash,
  ).run();
  if (!changed(result)) throw new Error("Effect outcome persistence conflict");
  const updated = await getEffect(db, input.effectId);
  if (!updated) throw new Error("Effect disappeared after outcome persistence");
  return { effect: updated, receipt, retryable: status === "executing" };
}

export interface PutInboxItemInput {
  id: string;
  kind: "interruption" | "effect" | "failed_run" | "draft_activation" | "eval_regression" | "workspace_cleanup";
  runId: string | null;
  entityType: string;
  entityId: string;
  priority: "low" | "normal" | "high" | "urgent";
  title: string;
  summary: string;
  payload: unknown;
  payloadHash: string;
  eligibleResponders: unknown;
}

interface InboxRow {
  id: string;
  kind: PutInboxItemInput["kind"];
  run_id: string | null;
  entity_type: string;
  entity_id: string;
  status: "open" | "resolved" | "dismissed";
  priority: PutInboxItemInput["priority"];
  title: string;
  summary: string;
  payload_json: string;
  payload_hash: string;
  eligible_responders_json: string;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
}

export interface InboxItemDto {
  id: string;
  kind: PutInboxItemInput["kind"];
  runId: string | null;
  entityType: string;
  entityId: string;
  status: InboxRow["status"];
  priority: PutInboxItemInput["priority"];
  title: string;
  summary: string;
  payload: unknown;
  payloadHash: string;
  eligibleResponders: unknown;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}

function inboxDto(row: InboxRow): InboxItemDto {
  return {
    id: row.id,
    kind: row.kind,
    runId: row.run_id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    status: row.status,
    priority: row.priority,
    title: row.title,
    summary: row.summary,
    payload: decodeJson(row.payload_json),
    payloadHash: row.payload_hash,
    eligibleResponders: decodeJson(row.eligible_responders_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
  };
}

export async function listOpenInbox(db: D1Database): Promise<InboxItemDto[]> {
  const { results } = await db.prepare(`
    SELECT * FROM inbox_items WHERE status = 'open'
    ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
      created_at DESC
  `).all<InboxRow>();
  return results.map(inboxDto);
}

export async function putInboxItem(db: D1Database, input: PutInboxItemInput): Promise<InboxItemDto> {
  await db.prepare(`
    INSERT INTO inbox_items (
      id, kind, run_id, entity_type, entity_id, status, priority, title, summary,
      payload_json, payload_hash, eligible_responders_json
    ) VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?)
    ON CONFLICT(kind, entity_type, entity_id) DO UPDATE SET
      run_id = excluded.run_id, status = 'open', priority = excluded.priority,
      title = excluded.title, summary = excluded.summary,
      payload_json = excluded.payload_json, payload_hash = excluded.payload_hash,
      eligible_responders_json = excluded.eligible_responders_json,
      updated_at = CURRENT_TIMESTAMP, resolved_at = NULL
  `).bind(
    input.id,
    input.kind,
    input.runId,
    input.entityType,
    input.entityId,
    input.priority,
    input.title,
    input.summary,
    encodeJson(input.payload),
    input.payloadHash,
    encodeJson(input.eligibleResponders),
  ).run();
  const row = await db.prepare(`
    SELECT * FROM inbox_items WHERE kind = ? AND entity_type = ? AND entity_id = ?
  `).bind(input.kind, input.entityType, input.entityId).first<InboxRow>();
  if (!row) throw new Error("Inbox projection failed");
  return inboxDto(row);
}

export async function resolveInboxItem(db: D1Database, id: string, status: "resolved" | "dismissed"): Promise<boolean> {
  const result = await db.prepare(`
    UPDATE inbox_items SET status = ?, resolved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'open'
  `).bind(status, id).run();
  return changed(result);
}

export async function grantRunCapability(
  db: D1Database,
  input: {
    id: string;
    runId: string;
    interruptionId: string | null;
    capabilityKind: string;
    scope: unknown;
    scopeHash: string;
    grantedBy: string;
    reason: string;
    maxUses: number;
    expiresAt: string;
  },
): Promise<void> {
  await db.prepare(`
    INSERT INTO run_capability_grants (
      id, run_id, interruption_id, capability_kind, scope_json, scope_hash,
      status, granted_by, reason, max_uses, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)
  `).bind(
    input.id,
    input.runId,
    input.interruptionId,
    input.capabilityKind,
    encodeJson(input.scope),
    input.scopeHash,
    input.grantedBy,
    input.reason,
    input.maxUses,
    input.expiresAt,
  ).run();
}

export async function consumeRunCapabilityGrant(
  db: D1Database,
  input: { id: string; scopeHash: string; now: string },
): Promise<boolean> {
  const result = await db.prepare(`
    UPDATE run_capability_grants SET
      use_count = use_count + 1,
      status = CASE WHEN use_count + 1 >= max_uses THEN 'consumed' ELSE 'active' END,
      terminal_at = CASE WHEN use_count + 1 >= max_uses THEN ? ELSE NULL END
    WHERE id = ? AND scope_hash = ? AND status = 'active' AND expires_at > ?
      AND use_count < max_uses
  `).bind(input.now, input.id, input.scopeHash, input.now).run();
  return changed(result);
}

export async function createEvalCase(
  db: D1Database,
  input: {
    id: string;
    agentId: string;
    revisionId: string | null;
    name: string;
    sourceKind: "package" | "dashboard" | "trace" | "system";
    fixture: unknown;
    fixtureHash: string;
    expectations: unknown;
    securityInvariant: boolean;
    createdBy: string;
  },
): Promise<void> {
  await db.prepare(`
    INSERT INTO agent_eval_cases (
      id, agent_id, revision_id, name, source_kind, fixture_json, fixture_hash,
      expectations_json, security_invariant, created_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    input.id,
    input.agentId,
    input.revisionId,
    input.name,
    input.sourceKind,
    encodeJson(input.fixture),
    input.fixtureHash,
    encodeJson(input.expectations),
    input.securityInvariant ? 1 : 0,
    input.createdBy,
  ).run();
}

export async function recordEvalResult(
  db: D1Database,
  input: {
    id: string;
    evalCaseId: string;
    runId: string | null;
    agentId: string;
    revisionId: string;
    status: "pending" | "passed" | "failed" | "error" | "cancelled";
    scorerId: string;
    scorerVersion: string;
    score: number | null;
    result: unknown | null;
    resultHash: string | null;
    artifactId: string | null;
  },
): Promise<void> {
  await db.prepare(`
    INSERT INTO agent_eval_results (
      id, eval_case_id, run_id, agent_id, revision_id, status, scorer_id,
      scorer_version, score, result_json, result_hash, artifact_id, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      CASE WHEN ? = 'pending' THEN NULL ELSE CURRENT_TIMESTAMP END)
  `).bind(
    input.id,
    input.evalCaseId,
    input.runId,
    input.agentId,
    input.revisionId,
    input.status,
    input.scorerId,
    input.scorerVersion,
    input.score,
    input.result === null ? null : encodeJson(input.result),
    input.resultHash,
    input.artifactId,
    input.status,
  ).run();
}
