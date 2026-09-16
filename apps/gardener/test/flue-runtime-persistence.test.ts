/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { createRun, getRun } from "../src/persistence/runs";
import {
  claimDueFlueDispatches,
  claimNativeTerminalInvocation,
  finalizeNativeRun,
  getFlueDispatch,
  putFlueDispatch,
  putNativeRunResult,
  recordFlueSettlement,
  requestRunCancellation,
  RunCancellationConflictError,
} from "../src/persistence/flue-runtime";
import { D1HarnessRequestStore } from "../src/persistence/harness-requests";
import {
  claimEffectExecution,
  createEffect,
  markEffectOutcomeUnknown,
} from "../src/persistence/decisions";
import { canonicalOperationHash, emptyRunBudgetUsage } from "@gardener/core";
import { expectedHarnessBinding, type HarnessRequest } from "../src/harness";
import { newAgentDatabase } from "./persistence-test-db";

const digest = "a".repeat(64);

async function fixture() {
  const { sqlite, db } = newAgentDatabase();
  sqlite.exec(`
    INSERT INTO agents(id,slug,name,created_by) VALUES('agent','agent','Agent','owner');
    INSERT INTO agent_revisions(
      id,agent_id,revision,source_md,source_hash,parsed_json,parsed_hash,compiled_json,compiled_hash,
      provenance_json,provenance_hash,compiler_version,catalog_version,runtime_version,published_by)
    VALUES('revision','agent',1,'source','${digest}','{}','${digest}','{}','${digest}','{}','${digest}','1','1','1','owner');
  `);
  await createRun(db, {
    id: "run-native", kind: "manual", repositoryEventId: null, agentId: "agent", agentRevisionId: "revision",
    workflowInstanceId: null, runtimeDriver: "flue-native-v1", nativeModelId: "@cf/test/model",
    nativeProfile: "bounded-issue-comment-v4", nativeRequestProtocol: "gardener-flue-request/v1",
    parentRunId: null, status: "queued",
    runSnapshot: {}, runSnapshotHash: digest, policySnapshot: {}, policySnapshotHash: digest,
    capabilitySnapshot: {}, capabilitySnapshotHash: digest, harnessId: "flue",
    harnessVersion: expectedHarnessBinding("flue").adapterVersion, budgets: {},
  });
  const request: HarnessRequest = {
    schemaVersion: "gardener.harness.request/v1", requestId: "request-native", runId: "run-native",
    snapshot: { agentRevisionId: "revision", agentRevisionHash: digest, promptReference: digest,
      policySnapshotReference: digest, toolCatalogVersion: "1", harness: expectedHarnessBinding("flue") },
    prompt: "bounded", model: { id: "@cf/test/model" }, tools: [],
    budget: { maxTurns: 1, maxToolCalls: 1, maxInputTokens: 1000, maxOutputTokens: 100,
      maxRuntimeMs: 30_000, deadlineAt: "2099-01-01T00:00:00.000Z" },
  };
  await new D1HarnessRequestStore(db).put(request);
  return { sqlite, db, request };
}

describe("Flue-native persistence", () => {
  it("fences due outbox claims and records one settlement without copying the receipt", async () => {
    const f = await fixture();
    try {
      await putFlueDispatch(f.db, f.request.runId, f.request.requestId);
      const claimed = await claimDueFlueDispatches(f.db, "2098-01-01T00:00:00.000Z", 20, 60_000);
      expect(claimed).toHaveLength(1);
      expect(await claimDueFlueDispatches(f.db, "2098-01-01T00:00:30.000Z", 20, 60_000)).toEqual([]);
      const adopted = await claimDueFlueDispatches(f.db, "2098-01-01T00:01:01.000Z", 20, 60_000);
      expect(adopted).toHaveLength(1);
      expect(adopted[0]!.claimToken).not.toBe(claimed[0]!.claimToken);
      await expect(recordFlueSettlement(f.db, f.request.runId, f.request.requestId, claimed[0]!.claimToken!, "failed"))
        .rejects.toThrow(/stale/);
      await recordFlueSettlement(f.db, f.request.runId, f.request.requestId, adopted[0]!.claimToken!, "completed");
      expect(await getFlueDispatch(f.db, f.request.runId, f.request.requestId)).toMatchObject({
        state: "settled", settlementOutcome: "completed", attemptCount: 2,
      });
      const columns = (f.sqlite.prepare("PRAGMA table_info(flue_dispatch_outbox)").all() as Array<{ name: string }>).map(x => x.name);
      expect(columns).not.toEqual(expect.arrayContaining(["submission_id", "submission_json", "submission_hash", "accepted_at"]));
    } finally { f.sqlite.close(); }
  });

  it("keeps result, cancellation, driver, and terminal projection immutable", async () => {
    const f = await fixture();
    try {
      await putNativeRunResult(f.db, "run-native", { outcome: "abstain", summary: "No action" });
      await expect(putNativeRunResult(f.db, "run-native", { outcome: "abstain", summary: "Changed" }))
        .rejects.toThrow(/conflict/);
      const cancelled = await requestRunCancellation(f.db, {
        runId: "run-native",
        reason: "Operator request",
        now: "2026-01-01T00:00:00.000Z",
        audit: { actor: "Owner", actorUserId: null, actorIdentityJson: "{}" },
      });
      expect(cancelled).toMatchObject({ cancelReason: "Operator request", cancelRequestedAt: "2026-01-01T00:00:00.000Z" });
      expect(f.sqlite.prepare("SELECT action,detail_json FROM audit_records WHERE action='agent_run.cancel_requested'").all())
        .toEqual([{ action: "agent_run.cancel_requested", detail_json: JSON.stringify({ reason: "Operator request" }) }]);
      await expect(f.db.prepare("UPDATE agent_runs SET cancel_reason='changed' WHERE id='run-native'").run())
        .rejects.toThrow(/monotonic/);
      await expect(f.db.prepare("UPDATE agent_runs SET runtime_driver='workflow-v1' WHERE id='run-native'").run())
        .rejects.toThrow(/immutable/);
      await expect(f.db.prepare("UPDATE agent_runs SET native_model_id='@cf/changed/model' WHERE id='run-native'").run())
        .rejects.toThrow(/immutable/);
      await expect(f.db.prepare("UPDATE agent_runs SET native_profile='bounded-issue-comment-v5' WHERE id='run-native'").run())
        .rejects.toThrow(/immutable/);
      const usage = emptyRunBudgetUsage();
      await finalizeNativeRun(f.db, { runId: "run-native", status: "cancelled", usage, error: { code: "cancelled" } });
      await expect(finalizeNativeRun(f.db, { runId: "run-native", status: "failed", usage, error: { code: "failed" } }))
        .resolves.toMatchObject({ status: "cancelled" });
    } finally { f.sqlite.close(); }
  });

  it("claims exactly one terminal invocation and permits its durable replay", async () => {
    const f = await fixture();
    try {
      await expect(claimNativeTerminalInvocation(f.db, "run-native", "call-1")).resolves.toBe(true);
      await expect(claimNativeTerminalInvocation(f.db, "run-native", "call-1")).resolves.toBe(true);
      await expect(claimNativeTerminalInvocation(f.db, "run-native", "call-2")).resolves.toBe(false);
      expect(await getRun(f.db, "run-native")).toMatchObject({
        terminalClaimHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
    } finally { f.sqlite.close(); }
  });

  it("repairs a missing cancellation audit on replay without changing intent", async () => {
    const f = await fixture();
    const first = {
      runId: "run-native",
      reason: "Original reason",
      now: "2026-01-01T00:00:00.000Z",
      audit: { actor: "Owner", actorUserId: null, actorIdentityJson: "{}" },
    };
    try {
      await requestRunCancellation(f.db, first);
      f.sqlite.exec("DELETE FROM audit_records WHERE action='agent_run.cancel_requested'");
      await requestRunCancellation(f.db, { ...first, reason: "Ignored replay reason" });
      expect(await getRun(f.db, "run-native")).toMatchObject({ cancelReason: "Original reason" });
      expect(f.sqlite.prepare("SELECT detail_json FROM audit_records WHERE action='agent_run.cancel_requested'").all())
        .toEqual([{ detail_json: JSON.stringify({ reason: "Original reason" }) }]);
    } finally { f.sqlite.close(); }
  });

  it("fences cancellation against terminal finalization in both orders", async () => {
    const usage = emptyRunBudgetUsage();
    const cancelFirst = await fixture();
    try {
      await requestRunCancellation(cancelFirst.db, {
        runId: "run-native", reason: "Stop", audit: { actor: "Owner", actorUserId: null, actorIdentityJson: "{}" },
      });
      await expect(putNativeRunResult(cancelFirst.db, "run-native", { outcome: "abstain" }))
        .rejects.toThrow(/cancellation denies/i);
      await finalizeNativeRun(cancelFirst.db, { runId: "run-native", status: "completed", usage });
      expect(await getRun(cancelFirst.db, "run-native")).toMatchObject({ status: "cancelled", result: null });
    } finally { cancelFirst.sqlite.close(); }

    const finalizeFirst = await fixture();
    try {
      await finalizeNativeRun(finalizeFirst.db, { runId: "run-native", status: "failed", usage, error: { code: "failed" } });
      await expect(requestRunCancellation(finalizeFirst.db, {
        runId: "run-native", reason: "Too late", audit: { actor: "Owner", actorUserId: null, actorIdentityJson: "{}" },
      })).rejects.toBeInstanceOf(RunCancellationConflictError);
      expect(await getRun(finalizeFirst.db, "run-native")).toMatchObject({ status: "failed", cancelRequestedAt: null });
      expect(finalizeFirst.sqlite.prepare("SELECT COUNT(*) count FROM audit_records WHERE action='agent_run.cancel_requested'").get())
        .toEqual({ count: 0 });
    } finally { finalizeFirst.sqlite.close(); }
  });

  it("fences native effect creation and claims after cancellation", async () => {
    const operation = {
      schemaVersion: "v2" as const,
      id: "operation-native",
      kind: "issue.comment.create" as const,
      repository: { provider: "github" as const, id: "101", installationId: "201", owner: "acme", name: "widgets", defaultBranch: "main" },
      issueNumber: 1,
      expectedIssueState: "open" as const,
      expectedIssueUpdatedAt: "2026-01-01T00:00:00.000Z",
      body: "Hello",
    };
    const operationHash = await canonicalOperationHash(operation);
    const effectInput = {
      id: "effect-native",
      operationId: operation.id,
      runId: "run-native",
      taskId: null,
      stepId: null,
      interruptionId: null,
      effectKind: operation.kind,
      operation,
      operationHash,
      rationale: "Respond",
      policyMode: "automatic" as const,
      policySnapshotHash: digest,
      status: "approved" as const,
      requireActiveUncancelledNativeRun: true,
    };

    const cancelledBeforeCreate = await fixture();
    try {
      await putNativeRunResult(cancelledBeforeCreate.db, "run-native", { outcome: "issue_comment" });
      await requestRunCancellation(cancelledBeforeCreate.db, {
        runId: "run-native", reason: "Stop", audit: { actor: "Owner", actorUserId: null, actorIdentityJson: "{}" },
      });
      await expect(createEffect(cancelledBeforeCreate.db, effectInput)).rejects.toThrow(/creation failed/i);
    } finally { cancelledBeforeCreate.sqlite.close(); }

    const cancelledBeforeClaim = await fixture();
    try {
      await createEffect(cancelledBeforeClaim.db, effectInput);
      await requestRunCancellation(cancelledBeforeClaim.db, {
        runId: "run-native", reason: "Stop", audit: { actor: "Owner", actorUserId: null, actorIdentityJson: "{}" },
      });
      await expect(claimEffectExecution(cancelledBeforeClaim.db, { effectId: "effect-native", operationHash }))
        .resolves.toBe(false);
      expect(cancelledBeforeClaim.sqlite.prepare("SELECT status FROM effects WHERE id='effect-native'").get())
        .toEqual({ status: "approved" });
      await expect(finalizeNativeRun(cancelledBeforeClaim.db, {
        runId: "run-native", status: "cancelled", usage: emptyRunBudgetUsage(), error: { code: "cancelled" },
      })).rejects.toThrow(/nonterminal effect/i);
      expect(await getRun(cancelledBeforeClaim.db, "run-native")).toMatchObject({ status: "queued" });
    } finally { cancelledBeforeClaim.sqlite.close(); }
  });

  it("atomically projects an exhausted ambiguous effect and its Inbox item", async () => {
    const f = await fixture();
    try {
      f.sqlite.prepare(`INSERT INTO effects(
        id,operation_id,run_id,effect_kind,operation_json,operation_hash,rationale,policy_mode,
        policy_snapshot_hash,status)
        VALUES('effect','operation','run-native','issue.comment.create','{}',?,'unknown','automatic',?,'executing')`)
        .run(digest, digest);
      await markEffectOutcomeUnknown(f.db, { effectId: "effect", operationHash: digest, runId: "run-native" });
      await markEffectOutcomeUnknown(f.db, { effectId: "effect", operationHash: digest, runId: "run-native" });
      expect(f.sqlite.prepare("SELECT status,error_json FROM effects WHERE id='effect'").get()).toEqual({
        status: "failed",
        error_json: JSON.stringify({
          code: "gateway_outcome_unknown",
          message: "The exact Gateway operation may have been applied, but no bound receipt proves its outcome",
          retryable: false,
        }),
      });
      expect(f.sqlite.prepare("SELECT kind,entity_id,status FROM inbox_items WHERE entity_id='effect'").all())
        .toEqual([{ kind: "effect", entity_id: "effect", status: "open" }]);
    } finally { f.sqlite.close(); }
  });

  it("keeps an already-executed provider effect authoritative after cancellation", async () => {
    const f = await fixture();
    try {
      f.sqlite.prepare(`INSERT INTO effects(
        id,operation_id,run_id,effect_kind,operation_json,operation_hash,rationale,policy_mode,
        policy_snapshot_hash,status,receipt_json,receipt_hash,executed_at)
        VALUES('effect','operation','run-native','issue.comment.create','{}',?,'done','automatic',?,'executed','{}',?,CURRENT_TIMESTAMP)`)
        .run(digest, digest, digest);
      await requestRunCancellation(f.db, {
        runId: "run-native", reason: "Stop", audit: { actor: "Owner", actorUserId: null, actorIdentityJson: "{}" },
      });
      await finalizeNativeRun(f.db, {
        runId: "run-native", status: "completed", usage: emptyRunBudgetUsage(), error: null,
      });
      expect(await getRun(f.db, "run-native")).toMatchObject({ status: "completed", cancelReason: "Stop" });
    } finally { f.sqlite.close(); }
  });
});
