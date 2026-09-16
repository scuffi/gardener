import { canonicalSha256 } from "@gardener/core";
import { changed, decodeJson, encodeJson } from "./shared";
import { getRun, type RunDto, type RunStatus } from "./runs";
import { FLUE_NATIVE_DRIVER } from "../flue-native-protocol";

export type FlueDispatchState = "pending" | "accepted" | "settled";
export type FlueSettlementOutcome = "completed" | "failed" | "aborted";

interface FlueDispatchRow {
  run_id: string; request_id: string; state: FlueDispatchState; attempt_count: number;
  next_attempt_at: string; claim_token: string | null; claim_expires_at: string | null;
  settlement_outcome: FlueSettlementOutcome | null; settlement_error_json: string | null;
  last_error_json: string | null; settled_at: string | null; created_at: string; updated_at: string;
}

export interface FlueDispatchDto {
  runId: string; requestId: string; state: FlueDispatchState; attemptCount: number;
  nextAttemptAt: string; claimToken: string | null; claimExpiresAt: string | null;
  settlementOutcome: FlueSettlementOutcome | null; settlementError: unknown | null;
  lastError: unknown | null; settledAt: string | null; createdAt: string; updatedAt: string;
}

function dto(row: FlueDispatchRow): FlueDispatchDto {
  return { runId: row.run_id, requestId: row.request_id, state: row.state, attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at, claimToken: row.claim_token, claimExpiresAt: row.claim_expires_at,
    settlementOutcome: row.settlement_outcome, settlementError: decodeJson(row.settlement_error_json),
    lastError: decodeJson(row.last_error_json), settledAt: row.settled_at, createdAt: row.created_at, updatedAt: row.updated_at };
}

export async function putFlueDispatch(db: D1Database, runId: string, requestId: string): Promise<FlueDispatchDto> {
  await db.prepare("INSERT OR IGNORE INTO flue_dispatch_outbox (run_id, request_id) VALUES (?, ?)").bind(runId, requestId).run();
  const found = await getFlueDispatch(db, runId, requestId);
  if (!found || found.runId !== runId || found.requestId !== requestId) throw new Error("Flue dispatch conflict");
  return found;
}

export async function getFlueDispatch(db: D1Database, runId: string, requestId: string): Promise<FlueDispatchDto | null> {
  const row = await db.prepare("SELECT * FROM flue_dispatch_outbox WHERE run_id=? AND request_id=?")
    .bind(runId, requestId).first<FlueDispatchRow>();
  return row ? dto(row) : null;
}

export async function claimDueFlueDispatches(db: D1Database, now: string, limit: number, leaseMs: number): Promise<FlueDispatchDto[]> {
  const { results } = await db.prepare(`SELECT run_id, request_id FROM flue_dispatch_outbox
    WHERE state <> 'settled' AND next_attempt_at <= ? AND (claim_token IS NULL OR claim_expires_at <= ?)
    ORDER BY next_attempt_at, run_id, request_id LIMIT ?`).bind(now, now, Math.max(0, Math.min(100, limit))).all<{run_id:string;request_id:string}>();
  const claimed: FlueDispatchDto[] = [];
  for (const row of results) {
    const token = crypto.randomUUID();
    const expires = new Date(Date.parse(now) + leaseMs).toISOString();
    const result = await db.prepare(`UPDATE flue_dispatch_outbox SET claim_token=?, claim_expires_at=?,
      attempt_count=attempt_count+1, updated_at=? WHERE run_id=? AND request_id=? AND state <> 'settled'
      AND (claim_token IS NULL OR claim_expires_at <= ?)`)
      .bind(token, expires, now, row.run_id, row.request_id, now).run();
    if (changed(result)) {
      const value = await getFlueDispatch(db, row.run_id, row.request_id);
      if (value) claimed.push(value);
    }
  }
  return claimed;
}

export async function markFlueDispatchAccepted(db:D1Database,runId:string,requestId:string,claimToken?:string):Promise<void>{
  const predicate=claimToken===undefined?"claim_token IS NULL":"claim_token = ?";
  const args=claimToken===undefined?[runId,requestId]:[runId,requestId,claimToken];
  const result=await db.prepare(`UPDATE flue_dispatch_outbox SET state='accepted', claim_token=NULL, claim_expires_at=NULL,
    last_error_json=NULL, next_attempt_at=datetime('now','+1 minute'), updated_at=CURRENT_TIMESTAMP
    WHERE run_id=? AND request_id=? AND state IN ('pending','accepted') AND ${predicate}`).bind(...args).run();
  if(!changed(result)){const row=await getFlueDispatch(db,runId,requestId);if(row?.state!=="accepted"&&row?.state!=="settled")throw new Error("Flue accepted update was stale");}
}

export async function rescheduleFlueDispatch(db:D1Database,runId:string,requestId:string,claimToken:string,error:unknown,nextAttemptAt:string):Promise<void>{
  const result=await db.prepare(`UPDATE flue_dispatch_outbox SET claim_token=NULL,claim_expires_at=NULL,last_error_json=?,
    next_attempt_at=?,updated_at=CURRENT_TIMESTAMP WHERE run_id=? AND request_id=? AND state<>'settled' AND claim_token=?`)
    .bind(encodeJson(error),nextAttemptAt,runId,requestId,claimToken).run();
  if(!changed(result))throw new Error("Flue reschedule claim was stale");
}

export async function recordFlueSettlement(db:D1Database,runId:string,requestId:string,claimToken:string,outcome:FlueSettlementOutcome,error?:unknown):Promise<void>{
  const result=await db.prepare(`UPDATE flue_dispatch_outbox SET state='settled',settlement_outcome=?,settlement_error_json=?,
    settled_at=CURRENT_TIMESTAMP,claim_token=NULL,claim_expires_at=NULL,updated_at=CURRENT_TIMESTAMP
    WHERE run_id=? AND request_id=? AND state<>'settled' AND claim_token=?`)
    .bind(outcome,error===undefined?null:encodeJson(error),runId,requestId,claimToken).run();
  if(!changed(result)){const row=await getFlueDispatch(db,runId,requestId);if(row?.state!=="settled"||row.settlementOutcome!==outcome)throw new Error("Flue settlement claim was stale");}
}

export class RunCancellationConflictError extends Error {
  constructor() {
    super("Terminal run cannot be cancelled");
    this.name = "RunCancellationConflictError";
  }
}

export interface RunCancellationAuditActor {
  actor: string;
  actorUserId: string | null;
  actorIdentityJson: string;
}

const terminal = new Set<RunStatus>(["completed", "completed_with_errors", "failed", "cancelled"]);

/** Atomically persists cancellation intent and its deduplicated audit record. */
export async function requestRunCancellation(
  db: D1Database,
  input: {
    runId: string;
    reason: string;
    audit: RunCancellationAuditActor;
    now?: string;
  },
): Promise<RunDto> {
  if (input.reason.length > 2_000) throw new Error("Cancellation reason is too long");
  const now = input.now ?? new Date().toISOString();
  await db.batch([
    db.prepare(`UPDATE agent_runs SET cancel_requested_at=?, cancel_reason=?
      WHERE id=? AND runtime_driver='flue-native-v1' AND cancel_requested_at IS NULL
        AND status IN ('admitted','queued','running','waiting')`)
      .bind(now, input.reason || null, input.runId),
    db.prepare(`INSERT OR IGNORE INTO audit_records(
        actor, actor_user_id, actor_identity_json, action, resource_type, resource_id, detail_json)
      SELECT ?, ?, ?, 'agent_run.cancel_requested', 'agent_run', id,
        json_object('reason', COALESCE(cancel_reason, ''))
      FROM agent_runs
      WHERE id=? AND runtime_driver='flue-native-v1' AND cancel_requested_at IS NOT NULL`)
      .bind(input.audit.actor, input.audit.actorUserId, input.audit.actorIdentityJson, input.runId),
  ]);
  const run = await getRun(db, input.runId);
  if (!run || run.runtimeDriver !== FLUE_NATIVE_DRIVER) throw new Error("Native run not found");
  if (run.cancelRequestedAt) return run;
  if (terminal.has(run.status)) throw new RunCancellationConflictError();
  throw new Error("Run cancellation request was stale");
}

/** One durable Flue tool call may own the terminal protocol for a run. */
export async function claimNativeTerminalInvocation(
  db: D1Database,
  runId: string,
  claimId: string,
): Promise<boolean> {
  if (!claimId) throw new Error("Native terminal claim is missing");
  const claimHash = await canonicalSha256({
    schemaVersion: "gardener.native.terminal-claim/v1",
    runId,
    invocationId: claimId,
  });
  const result = await db.prepare(`UPDATE agent_runs SET terminal_claim_hash=?
    WHERE id=? AND runtime_driver='flue-native-v1' AND terminal_claim_hash IS NULL
      AND cancel_requested_at IS NULL AND status IN ('admitted','queued','running','waiting')`)
    .bind(claimHash, runId).run();
  if (changed(result)) return true;
  const run = await getRun(db, runId);
  if (!run || run.runtimeDriver !== FLUE_NATIVE_DRIVER) throw new Error("Native run not found");
  return run.terminalClaimHash === claimHash;
}

export async function putNativeRunResult(db:D1Database,runId:string,result:unknown,resultHash?:string):Promise<RunDto>{
  const json=encodeJson(result);const canonicalHash=await canonicalSha256(result);const hash=resultHash??canonicalHash;
  if(hash!==canonicalHash)throw new Error("Native run result hash is invalid");
  await db.prepare(`UPDATE agent_runs SET result_json=?,result_hash=? WHERE id=? AND runtime_driver='flue-native-v1'
    AND result_json IS NULL AND cancel_requested_at IS NULL`)
    .bind(json,hash,runId).run();
  const run=await getRun(db,runId);if(!run||run.runtimeDriver!==FLUE_NATIVE_DRIVER)throw new Error("Native run not found");
  if(run.cancelRequestedAt&&run.result===null)throw new Error("Run cancellation denies terminal output");
  if(run.resultHash!==hash||encodeJson(run.result)!==json)throw new Error("Immutable native run result conflict");
  return run;
}

export async function finalizeNativeRun(db:D1Database,input:{runId:string;status:Extract<RunStatus,"completed"|"completed_with_errors"|"failed"|"cancelled">;usage:unknown;error?:unknown|null}):Promise<RunDto>{
  const current=await getRun(db,input.runId);if(!current||current.runtimeDriver!==FLUE_NATIVE_DRIVER)throw new Error("Native run not found");
  if(terminal.has(current.status)){
    if(current.status==="cancelled"&&current.cancelRequestedAt&&input.status!=="cancelled")return current;
    const exact=current.status===input.status&&encodeJson(current.usage)===encodeJson(input.usage)
      &&encodeJson(current.error)===encodeJson(input.error??null);
    if(!exact)throw new Error("Native run terminal projection conflict");
    return current;
  }
  let status=input.status;let error=input.error??null;
  if(current.cancelRequestedAt&&status!=="cancelled"){
    const executed=await db.prepare("SELECT 1 ok FROM effects WHERE run_id=? AND status='executed' LIMIT 1")
      .bind(input.runId).first<{ok:number}>();
    if(!executed){status="cancelled";error={code:"cancelled",message:"Cancellation requested"};}
  }
  const mustFenceCancellation=status!=="cancelled";
  const result=await db.prepare(`UPDATE agent_runs SET status=?,usage_json=?,error_json=?,completed_at=CURRENT_TIMESTAMP
    WHERE id=? AND runtime_driver='flue-native-v1' AND status IN ('admitted','queued','running','waiting')
      AND NOT EXISTS (
        SELECT 1 FROM effects WHERE effects.run_id=agent_runs.id AND effects.status IN ('approved','executing'))
      AND (?=0 OR cancel_requested_at IS NULL OR EXISTS(
        SELECT 1 FROM effects WHERE effects.run_id=agent_runs.id AND effects.status='executed'))`)
    .bind(status,encodeJson(input.usage),error==null?null:encodeJson(error),input.runId,mustFenceCancellation?1:0).run();
  if(!changed(result)){
    const activeEffect=await db.prepare("SELECT 1 ok FROM effects WHERE run_id=? AND status IN ('approved','executing') LIMIT 1")
      .bind(input.runId).first<{ok:number}>();
    if(activeEffect)throw new Error("Native run finalization is blocked by a nonterminal effect");
    const latest=await getRun(db,input.runId);
    if(latest?.cancelRequestedAt&&status!=="cancelled")return finalizeNativeRun(db,{...input,status:"cancelled",error:{code:"cancelled",message:"Cancellation requested"}});
    throw new Error("Native run finalization was stale");
  }
  const run=await getRun(db,input.runId);if(!run||run.status!==status)throw new Error("Native run finalization failed");return run;
}
