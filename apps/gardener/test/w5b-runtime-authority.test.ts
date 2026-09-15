/// <reference types="node" />
import { DatabaseSync } from "node:sqlite";
import type { AgentRepositoryAssignmentV1, Operation, PolicyMode } from "@gardener/contracts";
import {
  calculateAssignmentConfigHash,
  canonicalOperationHash,
  canonicalSha256,
  compileAgentRevision,
  createAgentRunSnapshot,
  createAgentSource,
  emptyRunBudgetUsage,
} from "@gardener/core";
import { describe, expect, it } from "vitest";
import {
  assertLiveAutomaticAuthority,
  instancePolicySnapshot,
  LiveAuthorityReadError,
  WorkspacePolicyReadError,
} from "../src/instance-state";
import { getRepositoryPolicy } from "../src/repository-policy";
import { claimEffectExecution, createEffect } from "../src/persistence/decisions";
import { createRun } from "../src/persistence/runs";
import type { Env } from "../src/env";
import { d1Database, migration } from "./persistence-test-db";

const now = "2026-09-15T08:00:00.000Z";
const repo = { provider: "github", id: "10", installationId: "20", owner: "acme", name: "widgets", defaultBranch: "main" } as const;
const operation: Operation = {
  schemaVersion: "v2", id: "operation-comment", kind: "issue.comment.create", repository: repo,
  issueNumber: 1, expectedIssueState: "open", expectedIssueUpdatedAt: now, body: "A bounded comment",
};
const markdown = `---
schema: gardener.agent/v1
name: Issue gardener
description: Responds to issues
triggers: [github.issue.opened]
capabilities:
  observation: [github.issue.read]
  workspace: []
  effects: [issue.comment.create]
authority-ceiling: automatic
---
Propose a concise response.
`;
const provenance = {
  source: "dashboard" as const,
  authoredBy: { provider: "gardener" as const, principal: { kind: "owner" as const, id: "owner:1" } },
  publishedBy: { provider: "gardener" as const, principal: { kind: "owner" as const, id: "owner:1" } },
  authoredAt: now, publishedAt: now,
};

type Fixture = { sqlite: DatabaseSync; db: D1Database; env: Env; runId: string };

async function fixture(frozenMode: PolicyMode = "automatic"): Promise<Fixture> {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(migration());
  sqlite.exec(migration("0005_agent_runtime_admission.sql"));
  sqlite.exec(migration("0006_flue_harness_requests.sql"));
  sqlite.exec("UPDATE operation_policies SET mode='automatic' WHERE operation_kind='issue.comment.create'; INSERT INTO repositories(id,installation_id,owner,name,default_branch,active) VALUES('10','20','acme','widgets','main',1)");
  sqlite.exec(migration("0007_team_workspace_foundation.sql"));
  sqlite.prepare("INSERT INTO settings(key,value) VALUES('global_paused','false') ON CONFLICT(key) DO UPDATE SET value='false'").run();
  const db = d1Database(sqlite);
  const compiled = await compileAgentRevision(createAgentSource(markdown), {
    agentId: "agent-one", revision: 1, revisionId: "revision-one", provenance,
    compilerVersion: "1", capabilityCatalogVersion: "1", runtimeVersion: "1", now: () => new Date(now),
  });
  const compiledJson = JSON.stringify(compiled.compiled);
  sqlite.prepare("INSERT INTO users(id,display_name) VALUES('owner','Owner')").run();
  sqlite.prepare("INSERT INTO agents(id,slug,name,enabled,created_by) VALUES('agent-one','one','One',0,'owner')").run();
  sqlite.prepare(`INSERT INTO agent_revisions(id,agent_id,revision,source_md,source_hash,parsed_json,parsed_hash,compiled_json,compiled_hash,provenance_json,provenance_hash,compiler_version,catalog_version,runtime_version,published_by)
    VALUES('revision-one','agent-one',1,'source',?,?,?,?,?,?,?, '1','1','1','owner')`)
    .run(compiled.revision.sourceHash, "{}", "a".repeat(64), compiledJson, await canonicalSha256(compiled.compiled), JSON.stringify(provenance), "b".repeat(64));
  sqlite.prepare("INSERT INTO agent_activations(agent_id,revision_id,activated_by) VALUES('agent-one','revision-one','owner')").run();
  const assignment: AgentRepositoryAssignmentV1 = {
    schemaVersion: "v1", id: "assignment-one", version: 1, configHash: "0".repeat(64), agentId: "agent-one",
    repositoryId: repo.id, enabled: true, authorityCeiling: "automatic", createdAt: now, updatedAt: now, removedAt: null,
  };
  assignment.configHash = await calculateAssignmentConfigHash(assignment);
  sqlite.prepare("INSERT INTO agent_repository_assignments(id,agent_id,repository_id,version,config_hash,enabled,authority_ceiling,created_by_user_id,updated_by_user_id) VALUES(?,?,?,?,?,1,'automatic','owner','owner')")
    .run(assignment.id, assignment.agentId, assignment.repositoryId, assignment.version, assignment.configHash);
  sqlite.prepare("INSERT INTO repository_events(id,provider,delivery_id,event_kind,action,repository_id,resource_type,resource_id,actor_json,facts_json,envelope_json,envelope_hash,admission_status) VALUES('event-one','github','delivery-one','github.issue','opened','10','issue','1','{}','{}','{}',?,'completed')").run("c".repeat(64));
  const workspace = await instancePolicySnapshot(db);
  const repository = (await getRepositoryPolicy(db, repo.id))!;
  if (frozenMode !== "automatic") {
    workspace.operationModes["issue.comment.create"] = frozenMode;
    workspace.policyHash = await (await import("@gardener/core")).calculateWorkspacePolicyHash(workspace);
  }
  const runId = frozenMode === "automatic" ? "run-live" : "run-frozen-approval";
  const snapshot = await createAgentRunSnapshot(compiled.compiled, workspace, repository.policy, assignment, {
    runId, harness: { id: "flue", version: "2.0.3" }, versions: { runtime: "1", capabilityCatalog: "1", compiler: "1" }, now: () => new Date(now),
  });
  await createRun(db, {
    id: runId, kind: "live", repositoryEventId: "event-one", agentId: "agent-one", agentRevisionId: "revision-one",
    workflowInstanceId: runId, parentRunId: null, status: "running", runSnapshot: snapshot, runSnapshotHash: snapshot.snapshotHash,
    policySnapshot: workspace, policySnapshotHash: workspace.policyHash, capabilitySnapshot: snapshot.effectiveCapabilities,
    capabilitySnapshotHash: await canonicalSha256(snapshot.effectiveCapabilities), harnessId: "flue", harnessVersion: "2.0.3",
    budgets: compiled.compiled.spec.limits, repositoryId: repo.id, assignmentId: assignment.id, assignmentVersion: 1,
    assignmentConfigHash: assignment.configHash, repositoryPolicyHash: repository.policyHash, repositoryPolicyVersion: repository.policyVersion,
  });
  return { sqlite, db, env: { DB: db } as Env, runId };
}

async function authority(f: Fixture, input: Operation = operation): Promise<void> {
  await assertLiveAutomaticAuthority(f.env, f.runId, input);
}

async function updateAssignment(f: Fixture, changes: Partial<Pick<AgentRepositoryAssignmentV1, "agentId" | "repositoryId" | "enabled" | "authorityCeiling" | "removedAt">>): Promise<void> {
  const row = f.sqlite.prepare("SELECT agent_id agentId,repository_id repositoryId,version,enabled,authority_ceiling authorityCeiling,removed_at removedAt FROM agent_repository_assignments WHERE id='assignment-one'").get() as any;
  const next: AgentRepositoryAssignmentV1 = {
    schemaVersion: "v1", id: "assignment-one", version: row.version + 1, configHash: "0".repeat(64),
    agentId: changes.agentId ?? row.agentId, repositoryId: changes.repositoryId ?? row.repositoryId,
    enabled: changes.enabled ?? row.enabled === 1, authorityCeiling: changes.authorityCeiling ?? row.authorityCeiling,
    createdAt: now, updatedAt: now, removedAt: changes.removedAt === undefined ? row.removedAt : changes.removedAt,
  };
  next.configHash = await calculateAssignmentConfigHash(next);
  f.sqlite.prepare("UPDATE agent_repository_assignments SET agent_id=?,repository_id=?,version=?,config_hash=?,enabled=?,authority_ceiling=?,removed_at=? WHERE id='assignment-one'")
    .run(next.agentId, next.repositoryId, next.version, next.configHash, next.enabled ? 1 : 0, next.authorityCeiling, next.removedAt);
}

describe("v7 bounded runtime live authority", () => {
  it("passes the baseline without consulting agents.enabled", async () => {
    const f = await fixture(); try { await expect(authority(f)).resolves.toBeUndefined(); } finally { f.sqlite.close(); }
  });

  it.each([
    ["repository pause", "INSERT INTO settings(key,value) VALUES('repository_paused:10','true')", /Repository is paused/],
    ["global pause", "UPDATE settings SET value='true' WHERE key='global_paused'", /globally paused/],
    ["inactive repository", "UPDATE repositories SET active=0 WHERE id='10'", /no longer authorizes/],
  ])("fails closed for %s", async (_name, sql, message) => {
    const f = await fixture(); try { f.sqlite.exec(sql); await expect(authority(f)).rejects.toThrow(message); } finally { f.sqlite.close(); }
  });

  it("rejects an active revision move", async () => {
    const f = await fixture(); try {
      f.sqlite.prepare("INSERT INTO agent_revisions SELECT 'revision-two',agent_id,2,source_md,source_hash,parsed_json,parsed_hash,compiled_json,compiled_hash,provenance_json,provenance_hash,compiler_version,catalog_version,runtime_version,published_paused,published_by,published_at FROM agent_revisions WHERE id='revision-one'").run();
      f.sqlite.prepare("UPDATE agent_activations SET revision_id='revision-two' WHERE agent_id='agent-one'").run();
      await expect(authority(f)).rejects.toThrow(/active Agent revision/);
    } finally { f.sqlite.close(); }
  });

  it.each([
    ["disabled", { enabled: false }],
    ["removed", { removedAt: now }],
    ["narrowed", { authorityCeiling: "approval" as const }],
  ])("rejects an assignment that is %s", async (_name, changes) => {
    const f = await fixture(); try { await updateAssignment(f, changes); await expect(authority(f)).rejects.toThrow(); } finally { f.sqlite.close(); }
  });

  it("rejects an assignment re-pointed to another Agent", async () => {
    const f = await fixture(); try {
      f.sqlite.prepare("INSERT INTO agents(id,slug,name,created_by) VALUES('agent-two','two','Two','owner')").run();
      await updateAssignment(f, { agentId: "agent-two" });
      await expect(authority(f)).rejects.toThrow(/bound assignment/);
    } finally { f.sqlite.close(); }
  });

  it.each([
    ["workspace", "UPDATE operation_policies SET mode='approval' WHERE operation_kind='issue.comment.create'"],
    ["repository", "UPDATE repository_operation_policies SET mode='approval' WHERE repository_id='10' AND operation_kind='issue.comment.create'"],
  ])("applies immediate %s narrowing", async (_name, sql) => {
    const f = await fixture(); try { f.sqlite.exec(sql); await expect(authority(f)).rejects.toThrow(/narrowed below automatic/); } finally { f.sqlite.close(); }
  });

  it("never upgrades a frozen approval when all live layers are automatic", async () => {
    const f = await fixture("approval"); try { await expect(authority(f)).rejects.toThrow(/snapshot does not authorize/); } finally { f.sqlite.close(); }
  });

  it("rejects missing or partial repository policy", async () => {
    for (const sql of [
      "DELETE FROM repository_operation_policies WHERE repository_id='10'",
      "DELETE FROM repository_operation_policies WHERE repository_id='10' AND operation_kind='issue.comment.create'",
    ]) {
      const f = await fixture(); try { f.sqlite.exec(sql); await expect(authority(f)).rejects.toThrow(/not completely configured/); } finally { f.sqlite.close(); }
    }
  });

  it("rejects operation repository mismatch and null run bindings", async () => {
    const mismatch = await fixture(); try {
      await expect(authority(mismatch, { ...operation, repository: { ...repo, id: "11" } })).rejects.toThrow(/binding integrity/);
    } finally { mismatch.sqlite.close(); }
    const unbound = await fixture(); try {
      unbound.sqlite.prepare("UPDATE agent_runs SET assignment_id=NULL,assignment_version=NULL,assignment_config_hash=NULL,repository_id=NULL,repository_policy_hash=NULL,repository_policy_version=NULL WHERE id=?").run(unbound.runId);
      await expect(authority(unbound)).rejects.toThrow(/binding integrity/);
    } finally { unbound.sqlite.close(); }
  });

  it("allows unrelated automatic policy version/hash changes without upgrading authority", async () => {
    const f = await fixture(); try {
      f.sqlite.exec("UPDATE operation_policies SET mode='automatic' WHERE operation_kind='issue.close'; UPDATE repository_operation_policies SET mode='automatic' WHERE repository_id='10' AND operation_kind='issue.close'; UPDATE settings SET value=CAST(value AS INTEGER)+1 WHERE key='policy_version'");
      await expect(authority(f)).resolves.toBeUndefined();
    } finally { f.sqlite.close(); }
  });

  it("rejects tampered snapshot and frozen layer hashes", async () => {
    for (const sql of [
      "UPDATE agent_runs SET run_snapshot_hash='dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd' WHERE id='run-live'",
      "UPDATE agent_runs SET repository_policy_hash='eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' WHERE id='run-live'",
      "UPDATE agent_runs SET policy_snapshot_hash='ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff' WHERE id='run-live'",
    ]) {
      const f = await fixture(); try { f.sqlite.exec(sql); await expect(authority(f)).rejects.toThrow(/integrity/); } finally { f.sqlite.close(); }
    }
  });

  it("leaves an effect claim retryable across transient authority reads", async () => {
    const f = await fixture(); try {
      const operationHash = await canonicalOperationHash(operation);
      await createEffect(f.db, {
        id: "effect-live", operationId: operation.id, runId: f.runId, taskId: null, stepId: null,
        interruptionId: null, effectKind: operation.kind, operation, operationHash, rationale: "test",
        policyMode: "automatic", policySnapshotHash: (await instancePolicySnapshot(f.db)).policyHash, status: "approved",
      });
      f.sqlite.prepare("DELETE FROM settings WHERE key='policy_version'").run();
      await expect(authority(f)).rejects.toBeInstanceOf(LiveAuthorityReadError);
      expect((f.sqlite.prepare("SELECT status FROM effects WHERE id='effect-live'").get() as any).status).toBe("approved");
      f.sqlite.prepare("INSERT INTO settings(key,value) VALUES('policy_version','1')").run();
      await authority(f);
      expect(await claimEffectExecution(f.db, { effectId: "effect-live", operationHash })).toBe(true);
      f.sqlite.prepare("DELETE FROM settings WHERE key='policy_version'").run();
      await expect(authority(f)).rejects.toBeInstanceOf(LiveAuthorityReadError);
      // Existing lease/idempotency semantics deliberately re-acquire executing,
      // so the post-claim re-read cannot permanently strand the effect.
      expect(await claimEffectExecution(f.db, { effectId: "effect-live", operationHash })).toBe(true);
    } finally { f.sqlite.close(); }
  });

  it("preserves transient live-read causes under a stable class and code", async () => {
    const f = await fixture(); try {
      f.sqlite.prepare("DELETE FROM settings WHERE key='policy_version'").run();
      try { await authority(f); throw new Error("expected failure"); } catch (error) {
        expect(error).toBeInstanceOf(LiveAuthorityReadError);
        expect((error as LiveAuthorityReadError).code).toBe("live_authority_read_failed");
        expect((error as LiveAuthorityReadError).cause).toBeInstanceOf(WorkspacePolicyReadError);
        expect(((error as LiveAuthorityReadError).cause as WorkspacePolicyReadError).code).toBe("policy_version_invalid");
      }
    } finally { f.sqlite.close(); }
  });
});
