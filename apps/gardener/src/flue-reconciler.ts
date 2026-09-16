import { AgentRunError, init } from "@flue/runtime";
import { canonicalSha256 } from "@gardener/core";
import type { Env } from "./env";
import { FLUE_NATIVE_DRIVER } from "./flue-native-protocol";
import { GardenerFlueAgent } from "./harness/flue/generic-agent";
import { settleRunNonterminalEffects } from "./harness/flue/terminal-tool";
import {
  abortFlueRun,
  dispatchStoredFlueRequest,
  ensureInitialFlueRequest,
  flueInstanceExists,
} from "./flue-native-runtime";
import {
  claimDueFlueDispatches,
  D1HarnessRequestStore,
  finalizeNativeRun,
  getRun,
  putInboxItem,
  recordFlueSettlement,
  rescheduleFlueDispatch,
  type FlueDispatchDto,
  type RunDto,
} from "./persistence";

export interface ReconcileFailure {
  runId: string;
  requestId?: string;
  phase: "integrity" | "claim";
  code: "native_admission_integrity_failed" | "native_claim_reconcile_failed";
}

export interface ReconcileSummary {
  integrityFailures: number;
  claimed: number;
  settled: number;
  rescheduled: number;
  failed: number;
  failures: ReconcileFailure[];
}

const terminalRunStatuses = new Set(["completed", "completed_with_errors", "failed", "cancelled"]);

/** Bounded model-free convergence for D1/Flue dispatch and settlement gaps. */
export async function reconcileFlueRuntime(
  env: Env,
  options: { now: Date; limit?: number },
): Promise<ReconcileSummary> {
  const limit = Math.max(1, Math.min(20, options.limit ?? 20));
  const summary: ReconcileSummary = {
    integrityFailures: 0,
    claimed: 0,
    settled: 0,
    rescheduled: 0,
    failed: 0,
    failures: [],
  };

  const { results: missing } = await env.DB.prepare(`
    SELECT id FROM agent_runs r
    WHERE runtime_driver=?
      AND status IN ('admitted','queued','running','waiting')
      AND NOT EXISTS (SELECT 1 FROM flue_dispatch_outbox o WHERE o.run_id=r.id)
    ORDER BY created_at, id LIMIT ?
  `).bind(FLUE_NATIVE_DRIVER, limit).all<{ id: string }>();
  for (const row of missing) {
    try {
      await ensureInitialFlueRequest(env, row.id);
    } catch {
      // Atomic admission makes this corruption, not a recoverable dispatch gap.
      summary.integrityFailures += 1;
      summary.failed += 1;
      summary.failures.push({
        runId: row.id,
        phase: "integrity",
        code: "native_admission_integrity_failed",
      });
    }
  }

  const claims = await claimDueFlueDispatches(env.DB, options.now.toISOString(), limit, 60_000);
  summary.claimed = claims.length;
  let cursor = 0;
  const workers = Array.from({ length: Math.min(5, claims.length) }, async () => {
    while (cursor < claims.length) {
      const item = claims[cursor++]!;
      try {
        await reconcileClaim(env, item, options.now, summary);
      } catch {
        summary.failures.push({
          runId: item.runId,
          requestId: item.requestId,
          phase: "claim",
          code: "native_claim_reconcile_failed",
        });
        try {
          await reschedule(env, item, options.now);
          summary.rescheduled += 1;
        } catch {
          // A lost/stale claim is safe: its current owner or the next Cron sweep converges it.
          summary.failed += 1;
        }
      }
    }
  });
  await Promise.all(workers);
  return summary;
}

async function reconcileClaim(
  env: Env,
  item: FlueDispatchDto,
  now: Date,
  summary: ReconcileSummary,
): Promise<void> {
  if (!item.claimToken) throw new Error("Outbox claim is missing");
  const run = await getRun(env.DB, item.runId);
  if (!run || run.runtimeDriver !== FLUE_NATIVE_DRIVER) throw new Error("Outbox run binding is invalid");
  const store = new D1HarnessRequestStore(env.DB);
  const request = await store.get(item.runId, item.requestId);
  if (!request) throw new Error("Outbox request is missing");
  let receipt = await store.getSubmission(item.runId, item.requestId);

  if (run.cancelRequestedAt) {
    if (!receipt) {
      // Never create cancelled work. A keyed replay is permitted only to adopt
      // a lost receipt from a conversation proven to exist already.
      if (!await flueInstanceExists(run.id)) {
        await settleRunNonterminalEffects(env, run.id, request.budget.deadlineAt);
        if (!terminalRunStatuses.has(run.status)) {
          await finalizeNativeRun(env.DB, {
            runId: run.id,
            status: "cancelled",
            usage: run.usage,
            error: { code: "cancelled", message: "Cancellation requested" },
          });
        }
        await recordFlueSettlement(env.DB, item.runId, item.requestId, item.claimToken, "aborted");
        summary.settled += 1;
        return;
      }
      receipt = await dispatchStoredFlueRequest(env, item.runId, item.requestId, item.claimToken);
      try { await abortFlueRun(run.id); } catch { /* next accepted-row sweep retries abort */ }
      summary.rescheduled += 1;
      return;
    }
    await abortFlueRun(run.id);
  }

  if (!receipt) {
    const instanceExists = await flueInstanceExists(run.id);
    if (!instanceExists && Date.parse(request.budget.deadlineAt) <= now.getTime()) {
      const error = { code: "native_deadline_expired", message: "The native run expired before Flue accepted it" };
      await settleRunNonterminalEffects(env, run.id, request.budget.deadlineAt);
      if (!terminalRunStatuses.has(run.status)) {
        await finalizeNativeRun(env.DB, { runId: run.id, status: "failed", usage: run.usage, error });
        await putRunFailureInbox(env, run.id, error);
      }
      await recordFlueSettlement(env.DB, item.runId, item.requestId, item.claimToken, "failed", { code: error.code });
      summary.settled += 1;
      return;
    }
    await dispatchStoredFlueRequest(env, item.runId, item.requestId, item.claimToken);
    summary.rescheduled += 1;
    return;
  }

  const signal = AbortSignal.timeout(1_000);
  try {
    await init(GardenerFlueAgent, { id: item.runId }).read(receipt.submissionId, { signal });
    await projectCompletedSettlement(env, item.runId, request.budget.deadlineAt);
    await recordFlueSettlement(env.DB, item.runId, item.requestId, item.claimToken, "completed");
    summary.settled += 1;
  } catch (error) {
    if (signal.aborted && !(error instanceof AgentRunError)) {
      await reschedule(env, item, now);
      summary.rescheduled += 1;
      return;
    }
    if (!(error instanceof AgentRunError)) throw error;
    await projectAbnormalSettlement(env, item.runId, error.outcome, request.budget.deadlineAt);
    await recordFlueSettlement(
      env.DB,
      item.runId,
      item.requestId,
      item.claimToken,
      error.outcome === "aborted" ? "aborted" : "failed",
      { code: error.outcome === "aborted" ? "flue_aborted" : "flue_failed" },
    );
    summary.settled += 1;
  }
}

async function projectCompletedSettlement(env: Env, runId: string, deadlineAt: string): Promise<void> {
  await settleRunNonterminalEffects(env, runId, deadlineAt);
  const run = await getRun(env.DB, runId);
  if (!run || terminalRunStatuses.has(run.status)) return;
  if (!run.result) {
    const error = {
      code: "flue_completed_without_terminal_output",
      message: "Flue completed without the trusted terminal output",
    };
    await finalizeNativeRun(env.DB, { runId, status: "failed", usage: run.usage, error });
    await putRunFailureInbox(env, runId, error);
    return;
  }
  const effect = await latestEffectStatus(env, runId);
  const hasErrors = effect !== null && effect !== "executed";
  await finalizeNativeRun(env.DB, {
    runId,
    status: hasErrors ? "completed_with_errors" : "completed",
    usage: run.usage,
    error: hasErrors
      ? { code: "effect_not_executed", message: "The exact effect did not execute successfully" }
      : null,
  });
}

async function projectAbnormalSettlement(
  env: Env,
  runId: string,
  outcome: "failed" | "aborted",
  deadlineAt: string,
): Promise<void> {
  await settleRunNonterminalEffects(env, runId, deadlineAt);
  const run = await getRun(env.DB, runId);
  if (!run) throw new Error("Native run disappeared during settlement");
  if (terminalRunStatuses.has(run.status)) {
    if ((run.status === "completed" || run.status === "completed_with_errors") && outcome !== "aborted") {
      await putRunFailureInbox(env, runId, {
        code: "flue_settlement_mismatch",
        message: "Flue settlement disagreed with an already-terminal product result",
      });
    }
    return;
  }
  if (run.cancelRequestedAt && await latestEffectStatus(env, runId) !== "executed") {
    await finalizeNativeRun(env.DB, {
      runId,
      status: "cancelled",
      usage: run.usage,
      error: { code: "cancelled", message: "Cancellation requested" },
    });
    return;
  }
  if (run.result) {
    const error = {
      code: "flue_settlement_mismatch",
      message: "The trusted product result was retained after abnormal Flue settlement",
    };
    await finalizeNativeRun(env.DB, { runId, status: "completed_with_errors", usage: run.usage, error });
    await putRunFailureInbox(env, runId, error);
    return;
  }
  const error = {
    code: outcome === "aborted" ? "flue_aborted" : "flue_failed",
    message: outcome === "aborted" ? "Flue submission aborted unexpectedly" : "Flue submission failed",
  };
  await finalizeNativeRun(env.DB, { runId, status: "failed", usage: run.usage, error });
  await putRunFailureInbox(env, runId, error);
}

async function latestEffectStatus(env: Env, runId: string): Promise<string | null> {
  const effect = await env.DB.prepare("SELECT status FROM effects WHERE run_id=? ORDER BY created_at DESC LIMIT 1")
    .bind(runId).first<{ status: string }>();
  return effect?.status ?? null;
}

async function putRunFailureInbox(
  env: Env,
  runId: string,
  error: { code: string; message: string },
): Promise<void> {
  const hash = await canonicalSha256({ runId, error });
  await putInboxItem(env.DB, {
    id: `inbox_${hash}`,
    kind: "failed_run",
    runId,
    entityType: "agent_run",
    entityId: runId,
    priority: "high",
    title: "Agent run needs attention",
    summary: error.message,
    payload: error,
    payloadHash: hash,
    eligibleResponders: [],
  });
}

async function reschedule(env: Env, item: FlueDispatchDto, now: Date): Promise<void> {
  if (!item.claimToken) throw new Error("Outbox claim is missing");
  const delay = Math.min(3_600_000, 1_000 * 2 ** Math.min(12, item.attemptCount));
  await rescheduleFlueDispatch(
    env.DB,
    item.runId,
    item.requestId,
    item.claimToken,
    { code: "flue_reconcile_retry", message: "Flue runtime reconciliation will retry" },
    new Date(now.getTime() + delay).toISOString(),
  );
}
