/// <reference types="node" />
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRun } from "../src/persistence/runs";
import { D1HarnessRequestStore } from "../src/persistence/harness-requests";
import { putFlueDispatch } from "../src/persistence/flue-runtime";
import { expectedHarnessBinding, type HarnessRequest } from "../src/harness";
import { newAgentDatabase } from "./persistence-test-db";

const flue = vi.hoisted(() => ({
  abort: vi.fn(async () => undefined),
  dispatch: vi.fn(async () => ({ submissionId: "submission-native", acceptedAt: "2026-01-01T00:00:00.000Z" })),
  getAgentInstance: vi.fn(async () => null as null | { id: string }),
  init: vi.fn(),
}));
vi.mock("@flue/runtime", () => ({ getAgentInstance: flue.getAgentInstance, init: flue.init }));
vi.mock("../src/harness/flue/generic-agent", () => ({ GardenerFlueAgent: function GardenerFlueAgent() {} }));

import {
  abortFlueRun,
  dispatchStoredFlueRequest,
  ensureInitialFlueRequest,
  flueInstanceExists,
} from "../src/flue-native-runtime";

const digest = "a".repeat(64);

async function fixture(driver: "workflow-v1" | "flue-native-v1" = "flue-native-v1") {
  const { sqlite, db } = newAgentDatabase();
  sqlite.exec(`
    INSERT INTO agents(id,slug,name,created_by) VALUES('agent','agent','Agent','owner');
    INSERT INTO agent_revisions(id,agent_id,revision,source_md,source_hash,parsed_json,parsed_hash,
      compiled_json,compiled_hash,provenance_json,provenance_hash,compiler_version,catalog_version,runtime_version,published_by)
    VALUES('revision','agent',1,'source','${digest}','{}','${digest}','{}','${digest}','{}','${digest}','1','1','1','owner');
    INSERT INTO repositories(id,installation_id,owner,name,default_branch,active)
    VALUES('repo','installation','acme','widgets','main',1);
    INSERT INTO repository_events(id,provider,delivery_id,event_kind,action,repository_id,resource_type,
      resource_id,actor_json,facts_json,envelope_json,envelope_hash,admission_status)
    VALUES('event','github','delivery','github.issue','opened','repo','issue','1','{}','{}','{}','${digest}','completed');
  `);
  await createRun(db, {
    id: `run-${driver}`, kind: "manual", repositoryEventId: "event", agentId: "agent", agentRevisionId: "revision",
    workflowInstanceId: driver === "workflow-v1" ? "workflow" : null, runtimeDriver: driver,
    nativeModelId: driver === "flue-native-v1" ? "@cf/test/model" : null,
    nativeProfile: driver === "flue-native-v1" ? "bounded-issue-comment-v4" : null,
    nativeRequestProtocol: driver === "flue-native-v1" ? "gardener-flue-request/v1" : null,
    parentRunId: null, status: "queued", runSnapshot: {}, runSnapshotHash: digest,
    policySnapshot: {}, policySnapshotHash: digest, capabilitySnapshot: {}, capabilitySnapshotHash: digest,
    harnessId: "flue", harnessVersion: expectedHarnessBinding("flue").adapterVersion, budgets: {},
  });
  const request: HarnessRequest = {
    schemaVersion: "gardener.harness.request/v1", requestId: `request-${driver}`, runId: `run-${driver}`,
    snapshot: { agentRevisionId: "revision", agentRevisionHash: digest, promptReference: digest,
      policySnapshotReference: digest, toolCatalogVersion: "1", harness: expectedHarnessBinding("flue") },
    prompt: "bounded", model: { id: "@cf/test/model" }, tools: [],
    budget: { maxTurns: 1, maxToolCalls: 1, maxInputTokens: 1000, maxOutputTokens: 100,
      maxRuntimeMs: 30_000, deadlineAt: "2099-01-01T00:00:00.000Z" },
  };
  const store = new D1HarnessRequestStore(db);
  await store.put(request);
  await putFlueDispatch(db, request.runId, request.requestId);
  return { sqlite, db, request, store };
}

describe("Flue-native direct driver", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    flue.init.mockReturnValue({ dispatch: flue.dispatch, abort: flue.abort });
  });

  it("dispatches one signal with run identity and request idempotency, then reuses its receipt", async () => {
    const f = await fixture();
    try {
      const first = await dispatchStoredFlueRequest({ DB: f.db }, f.request.runId, f.request.requestId);
      const second = await dispatchStoredFlueRequest({ DB: f.db }, f.request.runId, f.request.requestId);
      expect(second).toEqual(first);
      expect(flue.init).toHaveBeenCalledWith(expect.any(Function), { id: f.request.runId, uid: null });
      expect(flue.dispatch).toHaveBeenCalledOnce();
      expect(flue.dispatch).toHaveBeenCalledWith({
        message: { kind: "signal", type: "gardener.run.admitted", body: "{}",
          attributes: { runId: f.request.runId, eventId: "event" } },
        initialData: { request: f.request },
        idempotencyKey: f.request.requestId,
      });
      expect(await f.store.getSubmission(f.request.runId, f.request.requestId)).toEqual(first);
    } finally { f.sqlite.close(); }
  });

  it("fails closed instead of reconstructing a missing admission-owned request", async () => {
    const f = await fixture();
    try {
      f.sqlite.exec("DELETE FROM harness_requests WHERE run_id='run-flue-native-v1'");
      await expect(ensureInitialFlueRequest({ DB: f.db }, f.request.runId))
        .rejects.toThrow(/request is missing or ambiguous/i);
      expect(flue.dispatch).not.toHaveBeenCalled();
    } finally { f.sqlite.close(); }
  });

  it("fails closed instead of recreating a missing admission-owned outbox", async () => {
    const f = await fixture();
    try {
      f.sqlite.exec("DELETE FROM flue_dispatch_outbox WHERE run_id='run-flue-native-v1'");
      await expect(ensureInitialFlueRequest({ DB: f.db }, f.request.runId))
        .rejects.toThrow(/outbox is missing/i);
      expect(flue.dispatch).not.toHaveBeenCalled();
      expect(f.sqlite.prepare("SELECT COUNT(*) count FROM flue_dispatch_outbox WHERE run_id=?")
        .get(f.request.runId)).toEqual({ count: 0 });
    } finally { f.sqlite.close(); }
  });

  it("refuses to resume a historical Workflow driver and uses non-creating instance lookup for cancellation", async () => {
    const f = await fixture("workflow-v1");
    try {
      await expect(dispatchStoredFlueRequest({ DB: f.db }, f.request.runId, f.request.requestId))
        .rejects.toThrow(/Historical run/);
      expect(flue.dispatch).not.toHaveBeenCalled();
      expect(await flueInstanceExists(f.request.runId)).toBe(false);
      flue.getAgentInstance.mockResolvedValueOnce({ id: f.request.runId });
      expect(await flueInstanceExists(f.request.runId)).toBe(true);
      await abortFlueRun(f.request.runId);
      expect(flue.abort).toHaveBeenCalledOnce();
    } finally { f.sqlite.close(); }
  });
});
