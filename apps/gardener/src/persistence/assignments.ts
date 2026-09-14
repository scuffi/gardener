import {
  agentRepositoryAssignmentV1Schema,
  assignmentHistoryDetailsSchema,
  type AgentRepositoryAssignmentV1,
  type AssignmentHistoryDetails,
  type PolicyMode,
} from "@gardener/contracts";
import { calculateAssignmentConfigHash, canonicalJson } from "@gardener/core";
import type { PolicyAuditActor } from "../authorization";

interface AssignmentRow {
  id: string; agent_id: string; agent_name: string; repository_id: string; repository_owner: string;
  repository_name: string; enabled: number; authority_ceiling: PolicyMode; version: number; config_hash: string;
  created_at: string; updated_at: string; removed_at: string | null;
}

const selectAssignments = `
  SELECT ar.id, ar.agent_id, a.name agent_name, ar.repository_id, r.owner repository_owner,
    r.name repository_name, ar.enabled, ar.authority_ceiling, ar.version, ar.config_hash,
    ar.created_at, ar.updated_at, ar.removed_at
  FROM agent_repository_assignments ar
  JOIN agents a ON a.id=ar.agent_id JOIN repositories r ON r.id=ar.repository_id`;

function timestamp(value: string): string { return value.includes("T") ? value : `${value.replace(" ", "T")}Z`; }

async function rowDto(row: AssignmentRow): Promise<AgentRepositoryAssignmentV1> {
  const assignment = agentRepositoryAssignmentV1Schema.parse({
    schemaVersion: "v1", id: row.id, version: row.version, configHash: row.config_hash,
    agentId: row.agent_id, agentDisplayName: row.agent_name, repositoryId: row.repository_id,
    repositoryDisplayName: `${row.repository_owner}/${row.repository_name}`, enabled: row.enabled === 1,
    authorityCeiling: row.authority_ceiling, createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at), removedAt: row.removed_at ? timestamp(row.removed_at) : null,
  });
  if (await calculateAssignmentConfigHash(assignment) !== assignment.configHash) throw new Error("assignment_config_hash_invalid");
  return assignment;
}

export async function getAssignmentEpoch(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT value FROM settings WHERE key='assignment_epoch'").first<{ value: string }>();
  const epoch = Number(row?.value);
  if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error("assignment_epoch_invalid");
  return epoch;
}

export async function getAssignment(db: D1Database, id: string): Promise<AgentRepositoryAssignmentV1 | null> {
  const row = await db.prepare(`${selectAssignments} WHERE ar.id=?`).bind(id).first<AssignmentRow>();
  return row ? rowDto(row) : null;
}

export async function findAssignment(db: D1Database, agentId: string, repositoryId: string): Promise<AgentRepositoryAssignmentV1 | null> {
  const row = await db.prepare(`${selectAssignments} WHERE ar.agent_id=? AND ar.repository_id=?`).bind(agentId, repositoryId).first<AssignmentRow>();
  return row ? rowDto(row) : null;
}

export async function listAssignmentsByAgent(db: D1Database, agentId: string): Promise<AgentRepositoryAssignmentV1[]> {
  const rows = await db.prepare(`${selectAssignments} WHERE ar.agent_id=? ORDER BY r.owner,r.name`).bind(agentId).all<AssignmentRow>();
  return Promise.all(rows.results.map(rowDto));
}

export async function listAssignmentsByRepository(db: D1Database, repositoryId: string): Promise<AgentRepositoryAssignmentV1[]> {
  const rows = await db.prepare(`${selectAssignments} WHERE ar.repository_id=? ORDER BY a.name,ar.id`).bind(repositoryId).all<AssignmentRow>();
  return Promise.all(rows.results.map(rowDto));
}

export interface AssignmentWriteInput {
  id: string; agentId: string; repositoryId: string; enabled: boolean; authorityCeiling: PolicyMode;
  removedAt: string | null; expectedEpoch: number; expectedVersion?: number; expectedConfigHash?: string;
  action: AssignmentHistoryDetails["action"]; details: AssignmentHistoryDetails; actor: PolicyAuditActor;
  actorUserId: string; reason?: string | null; overlapFingerprint?: string;
}

interface PreparedPlan { input: AssignmentWriteInput; existing: AgentRepositoryAssignmentV1 | null; version: number; hash: string; now: string }

function sameConfiguration(existing: AgentRepositoryAssignmentV1, input: AssignmentWriteInput): boolean {
  return existing.enabled === input.enabled && existing.authorityCeiling === input.authorityCeiling &&
    ((existing.removedAt === null) === (input.removedAt === null));
}

async function preparePlan(db: D1Database, input: AssignmentWriteInput): Promise<PreparedPlan | AgentRepositoryAssignmentV1> {
  const existing = await findAssignment(db, input.agentId, input.repositoryId);
  if (existing && sameConfiguration(existing, input)) return existing;
  const now = new Date().toISOString(); const version = existing ? existing.version + 1 : 1;
  const candidate = {
    schemaVersion: "v1" as const, id: existing?.id ?? input.id, version, configHash: "0".repeat(64),
    agentId: input.agentId, ...(existing?.agentDisplayName ? { agentDisplayName: existing.agentDisplayName } : {}),
    repositoryId: input.repositoryId, ...(existing?.repositoryDisplayName ? { repositoryDisplayName: existing.repositoryDisplayName } : {}),
    enabled: input.enabled, authorityCeiling: input.authorityCeiling, createdAt: existing?.createdAt ?? now,
    updatedAt: now, removedAt: input.removedAt,
  };
  return { input, existing, version, hash: await calculateAssignmentConfigHash(candidate), now };
}

/**
 * Applies a materialized assignment set in one transaction. The first statement constraint-aborts unless every
 * epoch/row/non-row precondition still holds, so no stale write can consume an epoch.
 */
export async function writeAssignmentsAtomic(db: D1Database, inputs: readonly AssignmentWriteInput[]): Promise<AgentRepositoryAssignmentV1[] | null> {
  if (inputs.length === 0) return [];
  const expectedEpoch = inputs[0]!.expectedEpoch;
  if (inputs.some((input) => input.expectedEpoch !== expectedEpoch)) throw new Error("assignment batch requires one expected epoch");
  const prepared = await Promise.all(inputs.map((input) => preparePlan(db, input)));
  const noops: AgentRepositoryAssignmentV1[] = []; const plans: PreparedPlan[] = [];
  for (const item of prepared) "configHash" in item ? noops.push(item) : plans.push(item);
  if (noops.length) {
    if (await getAssignmentEpoch(db) !== expectedEpoch) return null;
    for (const row of noops) {
      const input=inputs.find((candidate)=>candidate.agentId===row.agentId&&candidate.repositoryId===row.repositoryId)!;
      if ((input.expectedVersion !== undefined && input.expectedVersion !== row.version) ||
          (input.expectedConfigHash !== undefined && input.expectedConfigHash !== row.configHash)) return null;
    }
  }
  if (plans.length === 0) return noops;

  const guardParts = ["value=?"]; const guardBindings: Array<string | number> = [String(expectedEpoch)];
  for (const plan of plans) {
    if (plan.input.action === "added" || plan.input.action === "enabled") {
      guardParts.push("EXISTS(SELECT 1 FROM repositories WHERE id=? AND active=1)");
      guardBindings.push(plan.input.repositoryId);
    }
    if (plan.existing) {
      guardParts.push("EXISTS(SELECT 1 FROM agent_repository_assignments WHERE id=? AND agent_id=? AND repository_id=? AND version=? AND config_hash=?)");
      guardBindings.push(plan.existing.id, plan.input.agentId, plan.input.repositoryId, plan.input.expectedVersion ?? -1, plan.input.expectedConfigHash ?? "");
    } else {
      guardParts.push("NOT EXISTS(SELECT 1 FROM agent_repository_assignments WHERE agent_id=? AND repository_id=?)");
      guardBindings.push(plan.input.agentId, plan.input.repositoryId);
    }
  }
  const statements: D1PreparedStatement[] = [
    db.prepare(`UPDATE settings SET value=CASE WHEN ${guardParts.join(" AND ")} THEN value ELSE NULL END WHERE key='assignment_epoch'`).bind(...guardBindings),
    db.prepare("UPDATE settings SET value=CAST(value AS INTEGER)+1,updated_at=CURRENT_TIMESTAMP WHERE key='assignment_epoch'")
  ];
  for (const plan of plans) {
    const { input, existing, version, hash, now } = plan;
    if (!existing) {
      statements.push(db.prepare(`INSERT INTO agent_repository_assignments
        (id,agent_id,repository_id,enabled,authority_ceiling,version,config_hash,created_by_user_id,updated_by_user_id,created_at,updated_at,removed_at)
        VALUES(?,?,?,?,?,1,?,?,?,?,?,?)`).bind(input.id,input.agentId,input.repositoryId,input.enabled?1:0,input.authorityCeiling,hash,input.actorUserId,input.actorUserId,now,now,input.removedAt));
    } else {
      statements.push(db.prepare(`UPDATE agent_repository_assignments SET enabled=?,authority_ceiling=?,version=version+1,
        config_hash=?,updated_by_user_id=?,updated_at=?,removed_at=? WHERE id=? AND version=? AND config_hash=?`).bind(
        input.enabled?1:0,input.authorityCeiling,hash,input.actorUserId,now,input.removedAt,existing.id,input.expectedVersion ?? -1,input.expectedConfigHash ?? ""));
    }
    statements.push(db.prepare("UPDATE settings SET value=CASE WHEN changes()=1 THEN value ELSE NULL END WHERE key='assignment_epoch'"));
    const details = assignmentHistoryDetailsSchema.parse(input.details);
    const id = existing?.id ?? input.id;
    statements.push(
      db.prepare(`INSERT INTO agent_repository_assignment_history
        (id,assignment_id,assignment_version,config_hash,enabled,authority_ceiling,action,details_json,actor_user_id,reason)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).bind(`assignment_history_${crypto.randomUUID().replaceAll("-","")}`,id,version,hash,input.enabled?1:0,input.authorityCeiling,input.action,canonicalJson(details),input.actorUserId,input.reason??(input.overlapFingerprint?`overlap-confirmed:${input.overlapFingerprint}`:null)),
      db.prepare(`INSERT INTO audit_records(actor,actor_user_id,actor_identity_json,action,resource_type,resource_id,detail_json)
        VALUES(?,?,?,'assignment.updated','agent_repository_assignment',?,?)`).bind(input.actor.actor,input.actor.actorUserId,input.actor.actorIdentityJson,id,canonicalJson({details,...(input.overlapFingerprint?{overlapFingerprint:input.overlapFingerprint}:{})})),
    );
  }
  try {
    const results = await db.batch(statements);
    if ((results[0]?.meta.changes ?? 0) !== 1 || (results[1]?.meta.changes ?? 0) !== 1) throw new Error("assignment batch guard invariant failed");
  } catch (error) {
    const currentEpoch = await getAssignmentEpoch(db);
    const [currentRows,activeRepositories] = await Promise.all([
      Promise.all(plans.map((plan) => findAssignment(db, plan.input.agentId, plan.input.repositoryId))),
      Promise.all(plans.map((plan) => plan.input.action === "added" || plan.input.action === "enabled"
        ? db.prepare("SELECT 1 present FROM repositories WHERE id=? AND active=1").bind(plan.input.repositoryId).first<{present:number}>()
        : Promise.resolve({present:1}))),
    ]);
    const stale = currentEpoch !== expectedEpoch || activeRepositories.some((row)=>!row) || currentRows.some((row,index) => {
      const plan=plans[index]!;
      return plan.existing ? !row || row.version !== plan.input.expectedVersion || row.configHash !== plan.input.expectedConfigHash : row !== null;
    });
    if (stale) return null;
    throw error;
  }
  const changed = await Promise.all(plans.map((plan) => getAssignment(db, plan.existing?.id ?? plan.input.id)));
  if (changed.some((row) => !row)) throw new Error("assignment batch committed without expected rows");
  return [...noops, ...changed as AgentRepositoryAssignmentV1[]];
}

export async function writeAssignment(db: D1Database, input: AssignmentWriteInput): Promise<AgentRepositoryAssignmentV1 | null> {
  const rows = await writeAssignmentsAtomic(db, [input]); return rows?.[0] ?? null;
}
