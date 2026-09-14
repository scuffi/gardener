import { canonicalJson } from "@gardener/core";
import type { PolicyAuditActor } from "../authorization";
import { agentDto, decodeJson, encodeJson, type AgentDto, type AgentRow } from "./shared";

export interface CreateAgentInput {
  id: string;
  slug: string;
  name: string;
  description: string;
  createdBy: string;
}

export interface SaveAgentDraftInput {
  id: string;
  agentId: string;
  sourceMd: string;
  sourceHash: string;
  parsed: unknown;
  validation: unknown;
  provenance: unknown;
  compilerVersion: string;
  catalogVersion: string;
  runtimeVersion: string;
  actorId: string;
  expectedVersion?: number;
  idempotencyKeyHash?: string | null;
}

interface DraftRow {
  id: string;
  agent_id: string;
  source_md: string;
  source_hash: string;
  parsed_json: string;
  validation_json: string;
  provenance_json: string;
  compiler_version: string;
  catalog_version: string;
  runtime_version: string;
  version: number;
  idempotency_key_hash: string | null;
  status: "editing" | "published" | "discarded";
  published_revision_id: string | null;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
}

export interface AgentDraftDto {
  id: string;
  agentId: string;
  sourceMd: string;
  sourceHash: string;
  parsed: unknown;
  validation: unknown;
  provenance: unknown;
  compilerVersion: string;
  catalogVersion: string;
  runtimeVersion: string;
  version: number;
  idempotencyKeyHash: string | null;
  status: DraftRow["status"];
  publishedRevisionId: string | null;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
}

interface RevisionRow {
  id: string;
  agent_id: string;
  revision: number;
  source_md: string;
  source_hash: string;
  parsed_json: string;
  parsed_hash: string;
  compiled_json: string;
  compiled_hash: string;
  provenance_json: string;
  provenance_hash: string;
  compiler_version: string;
  catalog_version: string;
  runtime_version: string;
  published_paused: number;
  published_by: string;
  published_at: string;
}

export interface AgentRevisionDto {
  id: string;
  agentId: string;
  revision: number;
  sourceMd: string;
  sourceHash: string;
  parsed: unknown;
  parsedHash: string;
  compiled: unknown;
  compiledHash: string;
  provenance: unknown;
  provenanceHash: string;
  compilerVersion: string;
  catalogVersion: string;
  runtimeVersion: string;
  publishedPaused: true;
  publishedBy: string;
  publishedAt: string;
}

export interface PublishAgentRevisionInput {
  revisionId: string;
  revision: number;
  draftId: string;
  parsedHash: string;
  compiled: unknown;
  compiledHash: string;
  provenance: unknown;
  provenanceHash: string;
  publishedBy: string;
}

function draftDto(row: DraftRow): AgentDraftDto {
  return {
    id: row.id,
    agentId: row.agent_id,
    sourceMd: row.source_md,
    sourceHash: row.source_hash,
    parsed: decodeJson(row.parsed_json),
    validation: decodeJson(row.validation_json),
    provenance: decodeJson(row.provenance_json),
    compilerVersion: row.compiler_version,
    catalogVersion: row.catalog_version,
    runtimeVersion: row.runtime_version,
    version: row.version,
    idempotencyKeyHash: row.idempotency_key_hash,
    status: row.status,
    publishedRevisionId: row.published_revision_id,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function revisionDto(row: RevisionRow): AgentRevisionDto {
  return {
    id: row.id,
    agentId: row.agent_id,
    revision: row.revision,
    sourceMd: row.source_md,
    sourceHash: row.source_hash,
    parsed: decodeJson(row.parsed_json),
    parsedHash: row.parsed_hash,
    compiled: decodeJson(row.compiled_json),
    compiledHash: row.compiled_hash,
    provenance: decodeJson(row.provenance_json),
    provenanceHash: row.provenance_hash,
    compilerVersion: row.compiler_version,
    catalogVersion: row.catalog_version,
    runtimeVersion: row.runtime_version,
    publishedPaused: true,
    publishedBy: row.published_by,
    publishedAt: row.published_at,
  };
}

const agentSelect = `
  SELECT a.id, a.slug, a.name, a.description, a.enabled, a.revision_counter,
    aa.revision_id AS active_revision_id, a.created_by, a.created_at, a.updated_at
  FROM agents a LEFT JOIN agent_activations aa ON aa.agent_id = a.id
`;

export async function createAgent(db: D1Database, input: CreateAgentInput): Promise<AgentDto> {
  await db.prepare(`
    INSERT INTO agents (id, slug, name, description, enabled, created_by)
    VALUES (?, ?, ?, ?, 0, ?)
  `).bind(input.id, input.slug, input.name, input.description, input.createdBy).run();
  const agent = await getAgent(db, input.id);
  if (!agent) throw new Error("Agent creation failed");
  return agent;
}

export async function getAgent(db: D1Database, agentId: string): Promise<AgentDto | null> {
  const row = await db.prepare(`${agentSelect} WHERE a.id = ?`).bind(agentId).first<AgentRow>();
  return row ? agentDto(row) : null;
}

export async function listAgents(db: D1Database): Promise<AgentDto[]> {
  const { results } = await db.prepare(`${agentSelect} ORDER BY a.created_at DESC, a.id`).all<AgentRow>();
  return results.map(agentDto);
}

export async function saveAgentDraft(db: D1Database, input: SaveAgentDraftInput): Promise<AgentDraftDto> {
  await db.prepare(`
    INSERT INTO agent_drafts (
      id, agent_id, source_md, source_hash, parsed_json, validation_json,
      provenance_json, compiler_version, catalog_version, runtime_version,
      idempotency_key_hash, status, created_by, updated_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'editing', ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      source_md = excluded.source_md,
      source_hash = excluded.source_hash,
      parsed_json = excluded.parsed_json,
      validation_json = excluded.validation_json,
      provenance_json = excluded.provenance_json,
      compiler_version = excluded.compiler_version,
      catalog_version = excluded.catalog_version,
      runtime_version = excluded.runtime_version,
      version = agent_drafts.version + 1,
      idempotency_key_hash = excluded.idempotency_key_hash,
      updated_by = excluded.updated_by,
      updated_at = CURRENT_TIMESTAMP
    WHERE agent_drafts.agent_id = excluded.agent_id AND agent_drafts.status = 'editing'
      AND (? IS NULL OR agent_drafts.version = ?)
  `).bind(
    input.id,
    input.agentId,
    input.sourceMd,
    input.sourceHash,
    encodeJson(input.parsed),
    encodeJson(input.validation),
    encodeJson(input.provenance),
    input.compilerVersion,
    input.catalogVersion,
    input.runtimeVersion,
    input.idempotencyKeyHash ?? null,
    input.actorId,
    input.actorId,
    input.expectedVersion ?? null,
    input.expectedVersion ?? null,
  ).run();
  const draft = await getAgentDraft(db, input.id);
  const expectedResultVersion = input.expectedVersion === undefined ? undefined : input.expectedVersion === 0 ? 1 : input.expectedVersion + 1;
  if (!draft || draft.status !== "editing" || draft.sourceHash !== input.sourceHash || (expectedResultVersion !== undefined && draft.version !== expectedResultVersion)) {
    throw new Error("Only an editing draft can be changed");
  }
  return draft;
}

export async function getAgentDraft(db: D1Database, draftId: string): Promise<AgentDraftDto | null> {
  const row = await db.prepare("SELECT * FROM agent_drafts WHERE id = ?").bind(draftId).first<DraftRow>();
  return row ? draftDto(row) : null;
}

export async function getAgentRevision(db: D1Database, revisionId: string): Promise<AgentRevisionDto | null> {
  const row = await db.prepare("SELECT * FROM agent_revisions WHERE id = ?").bind(revisionId).first<RevisionRow>();
  return row ? revisionDto(row) : null;
}

export async function publishAgentDraft(db: D1Database, input: PublishAgentRevisionInput): Promise<AgentRevisionDto> {
  const insert = db.prepare(`
    INSERT INTO agent_revisions (
      id, agent_id, revision, source_md, source_hash, parsed_json, parsed_hash,
      compiled_json, compiled_hash, provenance_json, provenance_hash,
      compiler_version, catalog_version, runtime_version, published_paused, published_by
    )
    SELECT ?, d.agent_id, ?, d.source_md, d.source_hash,
      d.parsed_json, ?, ?, ?, ?, ?, d.compiler_version,
      d.catalog_version, d.runtime_version, 1, ?
    FROM agent_drafts d JOIN agents a ON a.id = d.agent_id
    WHERE d.id = ? AND d.status = 'editing' AND a.revision_counter = ? - 1
  `).bind(
    input.revisionId,
    input.revision,
    input.parsedHash,
    encodeJson(input.compiled),
    input.compiledHash,
    encodeJson(input.provenance),
    input.provenanceHash,
    input.publishedBy,
    input.draftId,
    input.revision,
  );
  const increment = db.prepare(`
    UPDATE agents SET revision_counter = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = (SELECT agent_id FROM agent_drafts WHERE id = ? AND status = 'editing')
      AND revision_counter = ? - 1
  `).bind(input.revision, input.draftId, input.revision);
  const closeDraft = db.prepare(`
    UPDATE agent_drafts SET status = 'published', published_revision_id = ?,
      updated_by = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'editing'
      AND EXISTS (
        SELECT 1 FROM agent_revisions r
        WHERE r.id = ? AND r.agent_id = agent_drafts.agent_id AND r.revision = ?
      )
  `).bind(input.revisionId, input.publishedBy, input.draftId, input.revisionId, input.revision);

  await db.batch([insert, increment, closeDraft]);
  const revision = await getAgentRevision(db, input.revisionId);
  if (!revision) throw new Error("Draft was not publishable");
  return revision;
}

export async function activateAgentRevision(
  db: D1Database,
  input: { historyId: string; agentId: string; revisionId: string; actorId: string; reason: string | null },
): Promise<AgentDto> {
  await db.batch([
    db.prepare(`
      INSERT INTO agent_activation_history
        (id, agent_id, previous_revision_id, revision_id, action, actor_id, reason)
      SELECT ?, ?, (SELECT revision_id FROM agent_activations WHERE agent_id = ?),
        r.id, 'activate', ?, ?
      FROM agent_revisions r WHERE r.id = ? AND r.agent_id = ?
    `).bind(input.historyId, input.agentId, input.agentId, input.actorId, input.reason, input.revisionId, input.agentId),
    db.prepare(`
      INSERT INTO agent_activations (agent_id, revision_id, activated_by)
      SELECT agent_id, id, ? FROM agent_revisions WHERE id = ? AND agent_id = ?
      ON CONFLICT(agent_id) DO UPDATE SET revision_id = excluded.revision_id,
        activated_by = excluded.activated_by, activated_at = CURRENT_TIMESTAMP
    `).bind(input.actorId, input.revisionId, input.agentId),
  ]);
  const agent = await getAgent(db, input.agentId);
  if (!agent || agent.activeRevisionId !== input.revisionId) throw new Error("Agent revision activation failed");
  return agent;
}

/** Guard-first optimistic activation sharing the assignment epoch used by overlap confirmation. */
export async function activateAgentRevisionGuarded(
  db: D1Database,
  input: { historyId: string; agentId: string; revisionId: string; expectedRevisionId: string | null; expectedEpoch: number; actorId: string; reason: string | null; actor: PolicyAuditActor; overlapFingerprint?: string },
): Promise<AgentDto | null> {
  const pointerGuard = input.expectedRevisionId === null
    ? "NOT EXISTS(SELECT 1 FROM agent_activations WHERE agent_id=?)"
    : "EXISTS(SELECT 1 FROM agent_activations WHERE agent_id=? AND revision_id=?)";
  const pointerBindings = input.expectedRevisionId === null ? [input.agentId] : [input.agentId,input.expectedRevisionId];
  const guard = db.prepare(`UPDATE settings SET value=CASE WHEN value=? AND ${pointerGuard}
      AND EXISTS(SELECT 1 FROM agent_revisions WHERE id=? AND agent_id=? AND published_paused=1)
      AND NOT EXISTS(
        SELECT 1 FROM agent_repository_assignments ar LEFT JOIN repositories r ON r.id=ar.repository_id
        WHERE ar.agent_id=? AND ar.enabled=1 AND ar.removed_at IS NULL AND COALESCE(r.active,0)<>1
      ) THEN value ELSE NULL END WHERE key='assignment_epoch'`)
    .bind(String(input.expectedEpoch),...pointerBindings,input.revisionId,input.agentId,input.agentId);
  const activation = input.expectedRevisionId === null
    ? db.prepare("INSERT INTO agent_activations(agent_id,revision_id,activated_by) SELECT agent_id,id,? FROM agent_revisions WHERE id=? AND agent_id=? AND published_paused=1").bind(input.actorId,input.revisionId,input.agentId)
    : db.prepare(`UPDATE agent_activations SET revision_id=?,activated_by=?,activated_at=CURRENT_TIMESTAMP
        WHERE agent_id=? AND revision_id=? AND EXISTS(SELECT 1 FROM agent_revisions WHERE id=? AND agent_id=? AND published_paused=1)`).bind(input.revisionId,input.actorId,input.agentId,input.expectedRevisionId,input.revisionId,input.agentId);
  const detail=canonicalJson({previousRevisionId:input.expectedRevisionId,revisionId:input.revisionId,...(input.overlapFingerprint?{overlapFingerprint:input.overlapFingerprint}:{})});
  try {
    const results=await db.batch([
      guard,
      db.prepare("UPDATE settings SET value=CAST(value AS INTEGER)+1,updated_at=CURRENT_TIMESTAMP WHERE key='assignment_epoch'"),
      activation,
      db.prepare("UPDATE settings SET value=CASE WHEN changes()=1 THEN value ELSE NULL END WHERE key='assignment_epoch'"),
      db.prepare(`INSERT INTO agent_activation_history(id,agent_id,previous_revision_id,revision_id,action,actor_id,reason)
        VALUES(?,?,?,?,'activate',?,?)`).bind(input.historyId,input.agentId,input.expectedRevisionId,input.revisionId,input.actorId,input.reason??(input.overlapFingerprint?`overlap-confirmed:${input.overlapFingerprint}`:null)),
      db.prepare(`INSERT INTO audit_records(actor,actor_user_id,actor_identity_json,action,resource_type,resource_id,detail_json)
        VALUES(?,?,?,'agent.revision.activated','agent_revision',?,?)`).bind(input.actor.actor,input.actor.actorUserId,input.actor.actorIdentityJson,input.revisionId,detail),
    ]);
    if ((results[0]?.meta.changes??0)!==1||(results[1]?.meta.changes??0)!==1||(results[2]?.meta.changes??0)!==1) throw new Error("activation guard invariant failed");
  } catch (error) {
    const [agent,epochRow,inactive,candidate]=await Promise.all([getAgent(db,input.agentId),db.prepare("SELECT value FROM settings WHERE key='assignment_epoch'").first<{value:string}>(),db.prepare(`SELECT 1 present FROM agent_repository_assignments ar LEFT JOIN repositories r ON r.id=ar.repository_id
      WHERE ar.agent_id=? AND ar.enabled=1 AND ar.removed_at IS NULL AND COALESCE(r.active,0)<>1 LIMIT 1`).bind(input.agentId).first<{present:number}>(),db.prepare("SELECT 1 present FROM agent_revisions WHERE id=? AND agent_id=? AND published_paused=1").bind(input.revisionId,input.agentId).first<{present:number}>()]);
    if (Number(epochRow?.value)!==input.expectedEpoch||agent?.activeRevisionId!==input.expectedRevisionId||inactive||!candidate) return null;
    throw error;
  }
  const agent=await getAgent(db,input.agentId); return agent?.activeRevisionId===input.revisionId?agent:null;
}

export async function deactivateAgent(
  db: D1Database,
  input: { historyId: string; agentId: string; actorId: string; reason: string | null },
): Promise<AgentDto> {
  await db.batch([
    db.prepare(`
      INSERT INTO agent_activation_history
        (id, agent_id, previous_revision_id, revision_id, action, actor_id, reason)
      SELECT ?, agent_id, revision_id, NULL, 'deactivate', ?, ?
      FROM agent_activations WHERE agent_id = ?
    `).bind(input.historyId, input.actorId, input.reason, input.agentId),
    db.prepare("DELETE FROM agent_activations WHERE agent_id = ?").bind(input.agentId),
  ]);
  const agent = await getAgent(db, input.agentId);
  if (!agent || agent.activeRevisionId !== null) throw new Error("Agent deactivation failed");
  return agent;
}

export async function setAgentEnabled(
  db: D1Database,
  input: { historyId: string; agentId: string; enabled: boolean; actorId: string; reason: string | null },
): Promise<AgentDto> {
  await db.batch([
    db.prepare(`
      UPDATE agents SET enabled = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND (? = 0 OR EXISTS (SELECT 1 FROM agent_activations WHERE agent_id = agents.id))
    `).bind(input.enabled ? 1 : 0, input.agentId, input.enabled ? 1 : 0),
    db.prepare(`
      INSERT INTO agent_enablement_history (id, agent_id, enabled, actor_id, reason)
      SELECT ?, id, ?, ?, ? FROM agents WHERE id = ? AND enabled = ?
    `).bind(input.historyId, input.enabled ? 1 : 0, input.actorId, input.reason, input.agentId, input.enabled ? 1 : 0),
  ]);
  const agent = await getAgent(db, input.agentId);
  if (!agent || agent.enabled !== input.enabled) throw new Error("Agent enablement change failed");
  return agent;
}

export async function getCapabilityPolicies(db: D1Database): Promise<Array<{ capabilityKind: string; mode: string; constraints: unknown }>> {
  const { results } = await db.prepare(`
    SELECT capability_kind, mode, constraints_json
    FROM instance_capability_policies ORDER BY capability_kind
  `).all<{ capability_kind: string; mode: string; constraints_json: string }>();
  return results.map((row) => ({
    capabilityKind: row.capability_kind,
    mode: row.mode,
    constraints: decodeJson(row.constraints_json),
  }));
}

