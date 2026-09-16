/// <reference types="node" />
import { beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalOperationHash } from "@gardener/core";
import { createRun, getRun } from "../src/persistence/runs";
import { createEffect, getEffect } from "../src/persistence/decisions";
import { D1HarnessRequestStore } from "../src/persistence/harness-requests";
import {
  getFlueDispatch,
  putFlueDispatch,
  putNativeRunResult,
  requestRunCancellation,
} from "../src/persistence/flue-runtime";
import { expectedHarnessBinding, type HarnessRequest, type HarnessSubmission } from "../src/harness";
import { newAgentDatabase } from "./persistence-test-db";

const runtime = vi.hoisted(() => ({
  abortFlueRun: vi.fn(async () => undefined),
  dispatchStoredFlueRequest: vi.fn(),
  ensureInitialFlueRequest: vi.fn(),
  flueInstanceExists: vi.fn(async () => false),
}));
const flue = vi.hoisted(() => {
  class AgentRunError extends Error {
    constructor(readonly outcome: "failed" | "aborted") { super(`Flue ${outcome}`); }
  }
  return { read: vi.fn(), init: vi.fn(), AgentRunError };
});
vi.mock("../src/flue-native-runtime", () => runtime);
vi.mock("../src/harness/flue/generic-agent", () => ({ GardenerFlueAgent: function GardenerFlueAgent() {} }));
vi.mock("@flue/runtime", () => ({
  AgentRunError: flue.AgentRunError,
  init: flue.init,
}));

import { reconcileFlueRuntime } from "../src/flue-reconciler";

const digest = "a".repeat(64);
const now = new Date("2098-01-01T00:00:00.000Z");
const operation = {
  schemaVersion: "v2" as const,
  id: `op_${"b".repeat(64)}`,
  kind: "issue.comment.create" as const,
  repository: { provider: "github" as const, id: "123", installationId: "456", owner: "acme", name: "widgets", defaultBranch: "main" },
  issueNumber: 7,
  expectedIssueState: "open" as const,
  expectedIssueUpdatedAt: "2097-01-01T00:00:00.000Z",
  body: "Hello",
};

async function fixture(options: { request?: boolean; receipt?: boolean } = { request: true }) {
  const { sqlite, db } = newAgentDatabase();
  sqlite.exec(`
    INSERT INTO agents(id,slug,name,created_by) VALUES('agent','agent','Agent','owner');
    INSERT INTO agent_revisions(id,agent_id,revision,source_md,source_hash,parsed_json,parsed_hash,
      compiled_json,compiled_hash,provenance_json,provenance_hash,compiler_version,catalog_version,runtime_version,published_by)
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
  const store = new D1HarnessRequestStore(db);
  if (options.request !== false) {
    await store.put(request);
    await putFlueDispatch(db, request.runId, request.requestId);
  }
  if (options.receipt) {
    const submission: HarnessSubmission = {
      schemaVersion: "gardener.harness.submission/v1", harness: expectedHarnessBinding("flue"),
      runId: request.runId, requestId: request.requestId, submissionId: "submission-native",
      acceptedAt: "2097-01-01T00:00:00.000Z",
    };
    await store.putSubmission(submission);
  }
  return { sqlite, db, request };
}

describe("Flue-native reconciler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    flue.init.mockReturnValue({ read: flue.read });
    runtime.flueInstanceExists.mockResolvedValue(false);
  });

  it("reports a missing admission-owned request/outbox and never manufactures dispatch state", async () => {
    const f = await fixture({ request: false });
    try {
      runtime.ensureInitialFlueRequest.mockRejectedValue(new Error("Admission-owned native Flue outbox is missing"));
      const result = await reconcileFlueRuntime({ DB: f.db } as any, { now, limit: 20 });
      expect(result).toMatchObject({ integrityFailures: 1, failed: 1 });
      expect(result.failures).toContainEqual({
        runId: "run-native",
        phase: "integrity",
        code: "native_admission_integrity_failed",
      });
      expect(runtime.dispatchStoredFlueRequest).not.toHaveBeenCalled();
      expect(await getFlueDispatch(f.db, "run-native", "request-native")).toBeNull();
    } finally { f.sqlite.close(); }
  });

  it("settles cancellation without creating a Flue instance when no receipt exists", async () => {
    const f = await fixture();
    try {
      await createEffect(f.db, {
        id: `effect_${"e".repeat(64)}`, operationId: operation.id, runId: "run-native",
        taskId: null, stepId: null, interruptionId: null, effectKind: operation.kind,
        operation, operationHash: await canonicalOperationHash(operation), rationale: "Helpful", policyMode: "automatic",
        policySnapshotHash: digest, status: "approved",
      });
      await requestRunCancellation(f.db, {
        runId: "run-native", reason: "Operator request", now: "2097-12-31T00:00:00.000Z",
        audit: { actor: "Owner", actorUserId: null, actorIdentityJson: "{}" },
      });
      const result = await reconcileFlueRuntime({ DB: f.db } as any, { now });
      expect(result.settled).toBe(1);
      expect(runtime.dispatchStoredFlueRequest).not.toHaveBeenCalled();
      expect(runtime.abortFlueRun).not.toHaveBeenCalled();
      expect(await getRun(f.db, "run-native")).toMatchObject({ status: "cancelled" });
      expect(await getEffect(f.db, `effect_${"e".repeat(64)}`)).toMatchObject({
        status: "cancelled",
        error: { code: "cancelled" },
      });
      expect(await getFlueDispatch(f.db, "run-native", "request-native")).toMatchObject({
        state: "settled", settlementOutcome: "aborted",
      });
    } finally { f.sqlite.close(); }
  });

  it("adopts only a proven existing cancelled instance before aborting it", async () => {
    const f = await fixture();
    try {
      await requestRunCancellation(f.db, {
        runId: "run-native", reason: "Operator request", now: "2097-12-31T00:00:00.000Z",
        audit: { actor: "Owner", actorUserId: null, actorIdentityJson: "{}" },
      });
      runtime.flueInstanceExists.mockResolvedValue(true);
      runtime.dispatchStoredFlueRequest.mockResolvedValue({ submissionId: "adopted" });
      const result = await reconcileFlueRuntime({ DB: f.db } as any, { now });
      expect(result.rescheduled).toBe(1);
      expect(runtime.dispatchStoredFlueRequest).toHaveBeenCalledWith(
        expect.objectContaining({ DB: f.db }), "run-native", "request-native", expect.any(String),
      );
      expect(runtime.abortFlueRun).toHaveBeenCalledWith("run-native");
      expect(flue.read).not.toHaveBeenCalled();
    } finally { f.sqlite.close(); }
  });

  it("treats a short local read timeout as observation delay and never aborts active work", async () => {
    const f = await fixture({ request: true, receipt: true });
    try {
      flue.read.mockImplementation(async (_submissionId: string, options: { signal: AbortSignal }) => {
        await new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true }));
      });
      const result = await reconcileFlueRuntime({ DB: f.db } as any, { now });
      expect(result.rescheduled).toBe(1);
      expect(runtime.abortFlueRun).not.toHaveBeenCalled();
      expect(await getFlueDispatch(f.db, "run-native", "request-native")).toMatchObject({ state: "pending", claimToken: null });
    } finally { f.sqlite.close(); }
  });

  it("projects failed settlement and keeps a persisted terminal result visible", async () => {
    const f = await fixture({ request: true, receipt: true });
    try {
      await putNativeRunResult(f.db, "run-native", { outcome: "abstain", summary: "No action" });
      flue.read.mockRejectedValue(new flue.AgentRunError("failed"));
      const result = await reconcileFlueRuntime({ DB: f.db } as any, { now });
      expect(result.settled).toBe(1);
      expect(await getRun(f.db, "run-native")).toMatchObject({
        status: "completed_with_errors",
        result: { outcome: "abstain", summary: "No action" },
        error: { code: "flue_settlement_mismatch" },
      });
      expect(await getFlueDispatch(f.db, "run-native", "request-native")).toMatchObject({
        state: "settled", settlementOutcome: "failed",
      });
    } finally { f.sqlite.close(); }
  });

  it("projects an executing effect to unknown before aborted settlement terminalizes the run", async () => {
    const f = await fixture({ request: true, receipt: true });
    try {
      await putNativeRunResult(f.db, "run-native", { outcome: "issue_comment", summary: "Proposed" });
      await createEffect(f.db, {
        id: `effect_${"c".repeat(64)}`, operationId: operation.id, runId: "run-native",
        taskId: null, stepId: null, interruptionId: null, effectKind: operation.kind,
        operation, operationHash: await canonicalOperationHash(operation), rationale: "Helpful", policyMode: "automatic",
        policySnapshotHash: digest, status: "approved",
      });
      f.sqlite.prepare("UPDATE effects SET status='executing' WHERE run_id='run-native'").run();
      flue.read.mockRejectedValue(new flue.AgentRunError("aborted"));

      const result = await reconcileFlueRuntime({ DB: f.db } as any, { now });

      expect(result.settled).toBe(1);
      expect(await getEffect(f.db, `effect_${"c".repeat(64)}`)).toMatchObject({
        status: "failed",
        error: { code: "gateway_outcome_unknown" },
      });
      expect(await getRun(f.db, "run-native")).toMatchObject({ status: "completed_with_errors" });
      expect(f.sqlite.prepare("SELECT COUNT(*) count FROM inbox_items WHERE kind='effect' AND run_id='run-native'").get())
        .toEqual({ count: 1 });
    } finally { f.sqlite.close(); }
  });

  it("settles a completed submission without overwriting an already-terminal product run", async () => {
    const f = await fixture({ request: true, receipt: true });
    try {
      await putNativeRunResult(f.db, "run-native", { outcome: "abstain", summary: "No action" });
      f.sqlite.prepare("UPDATE agent_runs SET status='completed',completed_at=CURRENT_TIMESTAMP WHERE id='run-native'").run();
      flue.read.mockResolvedValue({ text: "done" });
      const result = await reconcileFlueRuntime({ DB: f.db } as any, { now });
      expect(result.settled).toBe(1);
      expect(await getRun(f.db, "run-native")).toMatchObject({ status: "completed" });
    } finally { f.sqlite.close(); }
  });
});
