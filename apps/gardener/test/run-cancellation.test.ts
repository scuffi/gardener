/// <reference types="node" />
import { describe, expect, it, vi } from "vitest";
import { createRun, getRun } from "../src/persistence/runs";
import { expectedHarnessBinding } from "../src/harness";
import type { Env } from "../src/env";
import { newAgentDatabase } from "./persistence-test-db";

const native = vi.hoisted(() => ({
  abortFlueRun: vi.fn(async () => undefined),
  flueInstanceExists: vi.fn(async () => true),
  dispatchStoredFlueRequest: vi.fn(),
  ensureInitialFlueRequest: vi.fn(),
}));
vi.mock("../src/flue-native-runtime", () => native);
vi.mock("../src/database", () => ({ ensureDatabase: async () => undefined }));
vi.mock("../src/flue-reconciler", () => ({ reconcileFlueRuntime: vi.fn() }));
vi.mock("../src/mcp", () => ({ createGardenerMcpOAuthProvider: vi.fn() }));

import { app } from "../src/app";

const digest = "a".repeat(64);

async function fixture() {
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
  const env = {
    DB: db, LOCAL_DEV_BYPASS: "true", GARDENER_WORKSPACE_ID: "workspace-1",
    AI: {}, AI_MODEL: "@cf/test/model", GITHUB_GATEWAY: {},
    ASSETS: { fetch: async () => new Response("not found", { status: 404 }) },
  } as unknown as Env;
  return { sqlite, db, env };
}

function cancelRequest(body: unknown = { reason: "Operator request" }): Request {
  return new Request("http://gardener.test/api/runs/run-native/cancel", {
    method: "POST",
    headers: { origin: "http://gardener.test", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("native run cancellation API", () => {
  it("persists immutable cancellation intent before best-effort abort and is idempotent", async () => {
    const f = await fixture();
    try {
      vi.clearAllMocks();
      native.flueInstanceExists.mockResolvedValue(true);
      native.abortFlueRun.mockImplementation(async () => {
        expect(await getRun(f.db, "run-native")).toMatchObject({ cancelReason: "Operator request" });
        throw new Error("temporary abort RPC failure");
      });
      let response = await app.fetch(cancelRequest(), f.env);
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({ accepted: true, runId: "run-native" });
      expect(await getRun(f.db, "run-native")).toMatchObject({ cancelReason: "Operator request" });
      expect(native.abortFlueRun).toHaveBeenCalledOnce();

      response = await app.fetch(cancelRequest({ reason: "changed" }), f.env);
      expect(response.status).toBe(202);
      expect((await getRun(f.db, "run-native"))?.cancelReason).toBe("Operator request");
      expect(native.abortFlueRun).toHaveBeenCalledTimes(2);
      expect(f.sqlite.prepare("SELECT action,detail_json FROM audit_records WHERE action='agent_run.cancel_requested'").all())
        .toEqual([{ action: "agent_run.cancel_requested", detail_json: JSON.stringify({ reason: "Operator request" }) }]);
    } finally { f.sqlite.close(); }
  });

  it("rejects a terminal run without attaching cancellation or audit state", async () => {
    const f = await fixture();
    try {
      vi.clearAllMocks();
      f.sqlite.exec("UPDATE agent_runs SET status='failed',completed_at=CURRENT_TIMESTAMP WHERE id='run-native'");
      const response = await app.fetch(cancelRequest(), f.env);
      expect(response.status).toBe(409);
      expect(await getRun(f.db, "run-native")).toMatchObject({ status: "failed", cancelRequestedAt: null });
      expect(f.sqlite.prepare("SELECT COUNT(*) count FROM audit_records WHERE action='agent_run.cancel_requested'").get())
        .toEqual({ count: 0 });
      expect(native.abortFlueRun).not.toHaveBeenCalled();
    } finally { f.sqlite.close(); }
  });

  it("requires authentication and same-origin mutation protection", async () => {
    const f = await fixture();
    try {
      f.env.LOCAL_DEV_BYPASS = "false";
      expect((await app.fetch(cancelRequest(), f.env)).status).toBe(401);
      f.env.LOCAL_DEV_BYPASS = "true";
      const request = cancelRequest();
      request.headers.set("origin", "https://attacker.example");
      expect((await app.fetch(request, f.env)).status).toBe(403);
    } finally { f.sqlite.close(); }
  });
});
