/// <reference types="node" />
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentProvenanceV1, RepositoryEventV2 } from "@gardener/contracts";
import {
  calculateAssignmentConfigHash,
  canonicalSha256,
  compileAgentRevision,
  createAgentSource,
} from "@gardener/core";
import type { Env } from "../src/env";
import { getAssignment } from "../src/persistence";
import { admitAgentRunsForEvent } from "../src/run-admission";
import { d1Database, migration } from "./persistence-test-db";

const now = "2026-09-15T08:43:42.000Z";
const modelContent = "W5B_PRIVATE_MODEL_CONTENT_MUST_NOT_LEAK";
const provenance: AgentProvenanceV1 = {
  source: "dashboard",
  authoredBy: { provider: "gardener", principal: { kind: "owner", id: "owner" } },
  publishedBy: { provider: "gardener", principal: { kind: "owner", id: "owner" } },
  authoredAt: now,
  publishedAt: now,
};

const event: RepositoryEventV2 = {
  schemaVersion: "v2",
  id: "event-one",
  deliveryId: "delivery-one",
  instanceId: "instance-one",
  occurredAt: now,
  repository: {
    provider: "github",
    id: "101",
    installationId: "201",
    owner: "acme",
    name: "widgets",
    defaultBranch: "main",
  },
  kind: "github.issue",
  action: "opened",
  actor: { id: "301", login: "actor", accountType: "User" },
  resourceAuthor: { id: "302", login: "author", accountType: "User" },
  issue: {
    id: "issue-one",
    number: 1,
    title: "A useful title",
    body: "A useful body",
    state: "open",
    labels: [],
    locked: false,
    updatedAt: now,
    htmlUrl: "https://github.com/acme/widgets/issues/1",
  },
};

function source(name: string): string {
  return `---
schema: gardener.agent/v1
name: ${name}
description: Admission integration fixture
triggers:
  - github.issue.opened
capabilities:
  observation:
    - github.issue.read
  workspace: []
  effects:
    - issue.comment.create
authority-ceiling: automatic
limits:
  max-turns: 4
  max-tool-calls: 10
  max-parallel-tasks: 2
---
${modelContent}
`;
}

interface WorkflowCall {
  id: string;
  params: { runId: string; runSnapshotHash: string };
}

function workflow(failCreates = 0) {
  const calls = { create: [] as WorkflowCall[], get: [] as string[], status: [] as string[], restart: [] as string[] };
  const existing = new Set<string>();
  let failures = failCreates;
  const binding = {
    async create(call: WorkflowCall) {
      calls.create.push(call);
      if (failures-- > 0) throw new Error("workflow temporarily unavailable");
      existing.add(call.id);
    },
    async get(id: string) {
      calls.get.push(id);
      if (!existing.has(id)) throw new Error("instance.not_found");
      return {
        status: async () => {
          calls.status.push(id);
          return { status: "queued" };
        },
        restart: async () => { calls.restart.push(id); },
      };
    },
  };
  return { binding, calls };
}

interface Fixture {
  sqlite: DatabaseSync;
  db: D1Database;
  env: Env;
  workflow: ReturnType<typeof workflow>;
  envelopeHash: string;
}

const open: DatabaseSync[] = [];
afterEach(() => {
  while (open.length) open.pop()!.close();
});

async function fixture(options: { failCreates?: number; completePolicy?: boolean } = {}): Promise<Fixture> {
  const sqlite = new DatabaseSync(":memory:");
  open.push(sqlite);
  sqlite.exec(migration());
  sqlite.exec("INSERT INTO gardener_schema(singleton,version)VALUES(1,4)");
  sqlite.exec(migration("0005_agent_runtime_admission.sql"));
  sqlite.exec(migration("0006_flue_harness_requests.sql"));
  sqlite.exec(`
    UPDATE settings SET value='false' WHERE key='global_paused';
    UPDATE operation_policies SET mode='automatic' WHERE operation_kind='issue.comment.create';
    INSERT INTO repositories(id,installation_id,owner,name,default_branch,active)
      VALUES('101','201','acme','widgets','main',1),
            ('102','201','acme','tools','main',1);
  `);
  sqlite.exec(migration("0007_team_workspace_foundation.sql"));
  sqlite.exec(`
    INSERT INTO users(id,display_name) VALUES('owner','Owner');
    INSERT INTO repository_events(
      id,provider,delivery_id,event_kind,action,repository_id,resource_type,resource_id,
      actor_json,resource_author_json,facts_json,envelope_json,envelope_hash,occurred_at)
    VALUES('event-one','github','delivery-one','github.issue','opened','101','issue','issue-one',
      '{}','{}','{}','{}','${"e".repeat(64)}','${now}');
  `);
  if (options.completePolicy === false) {
    sqlite.exec("DELETE FROM repository_operation_policies WHERE repository_id='101'; DELETE FROM repository_capability_policies WHERE repository_id='101'");
  }
  const db = d1Database(sqlite);
  const flow = workflow(options.failCreates);
  const envelopeHash = await canonicalSha256(event);
  const env = { DB: db, AGENT_RUN_WORKFLOW: flow.binding } as unknown as Env;
  return { sqlite, db, env, workflow: flow, envelopeHash };
}

async function addAgent(
  f: Fixture,
  suffix: string,
  options: {
    agentEnabled?: boolean;
    assignmentEnabled?: boolean;
    removedAt?: string | null;
    repositoryId?: string;
    authorityCeiling?: "disabled" | "approval" | "automatic";
    corruptCompiled?: "json" | "hash";
    corruptAssignmentHash?: boolean;
  } = {},
): Promise<void> {
  const agentId = `agent-${suffix}`;
  const revisionId = `revision-${suffix}`;
  const assignmentId = `assignment-${suffix}`;
  const compiledResult = await compileAgentRevision(createAgentSource(source(`Agent ${suffix}`)), {
    agentId,
    revision: 1,
    revisionId,
    provenance,
    compilerVersion: "1.0.0",
    capabilityCatalogVersion: "2026-09-09.1",
    runtimeVersion: "1.0.0",
    now: () => new Date(now),
  });
  const compiledJson = options.corruptCompiled === "json" ? "{}" : JSON.stringify(compiledResult.compiled);
  const compiledHash = options.corruptCompiled === "hash" ? "f".repeat(64) : await canonicalSha256(compiledResult.compiled);
  f.sqlite.prepare("INSERT INTO agents(id,slug,name,enabled,created_by)VALUES(?,?,?,?,?)")
    .run(agentId, agentId, `Agent ${suffix}`, options.agentEnabled === false ? 0 : 1, "owner");
  f.sqlite.prepare(`INSERT INTO agent_revisions(
    id,agent_id,revision,source_md,source_hash,parsed_json,parsed_hash,compiled_json,compiled_hash,
    provenance_json,provenance_hash,compiler_version,catalog_version,runtime_version,published_by,published_at)
    VALUES(?,?,1,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      revisionId, agentId, source(`Agent ${suffix}`), "a".repeat(64), "{}", "b".repeat(64), compiledJson,
      compiledHash, JSON.stringify(provenance), "c".repeat(64), "1.0.0", "2026-09-09.1", "1.0.0", "owner", now,
    );
  f.sqlite.prepare("INSERT INTO agent_activations(agent_id,revision_id,activated_by)VALUES(?,?,?)")
    .run(agentId, revisionId, "owner");
  const assignment = {
    schemaVersion: "v1" as const,
    id: assignmentId,
    agentId,
    repositoryId: options.repositoryId ?? "101",
    enabled: options.assignmentEnabled ?? true,
    authorityCeiling: options.authorityCeiling ?? "automatic",
    version: 1,
    configHash: "0".repeat(64),
    createdAt: now,
    updatedAt: now,
    removedAt: options.removedAt ?? null,
  };
  assignment.configHash = options.corruptAssignmentHash
    ? "d".repeat(64)
    : await calculateAssignmentConfigHash(assignment);
  f.sqlite.prepare(`INSERT INTO agent_repository_assignments(
    id,agent_id,repository_id,enabled,authority_ceiling,version,config_hash,
    created_by_user_id,updated_by_user_id,created_at,updated_at,removed_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      assignment.id, assignment.agentId, assignment.repositoryId, assignment.enabled ? 1 : 0,
      assignment.authorityCeiling, assignment.version, assignment.configHash, "owner", "owner", now, now,
      assignment.removedAt,
    );
}

async function admit(f: Fixture) {
  return admitAgentRunsForEvent(f.env, event, f.envelopeHash);
}

function count(sqlite: DatabaseSync, table: string): number {
  return (sqlite.prepare(`SELECT COUNT(*) count FROM ${table}`).get() as { count: number }).count;
}

describe("W5B admission and retry integration", () => {
  it("admits an exact enabled assignment with all six frozen bindings even when agents.enabled is false", async () => {
    const f = await fixture();
    await addAgent(f, "one", { agentEnabled: false });
    const result = await admit(f);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ agentId: "agent-one", revisionId: "revision-one", created: true });
    const row = f.sqlite.prepare(`SELECT repository_id,assignment_id,assignment_version,assignment_config_hash,
      repository_policy_hash,repository_policy_version FROM agent_runs`).get() as Record<string, unknown>;
    expect(row).toEqual({
      repository_id: "101",
      assignment_id: "assignment-one",
      assignment_version: 1,
      assignment_config_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      repository_policy_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      repository_policy_version: 1,
    });
    expect(f.workflow.calls.create).toHaveLength(1);
    expect(JSON.stringify(f.workflow.calls)).not.toContain(modelContent);
  });

  it.each([
    ["disabled", { assignmentEnabled: false }],
    ["removed", { removedAt: now }],
    ["wrong repository", { repositoryId: "102" }],
  ])("does not admit a %s assignment", async (_name, options) => {
    const f = await fixture();
    await addAgent(f, "one", options);
    expect(await admit(f)).toEqual([]);
    expect(count(f.sqlite, "agent_runs")).toBe(0);
    expect(count(f.sqlite, "audit_records")).toBe(0);
    expect(f.workflow.calls.create).toEqual([]);
  });

  it("admits two independently assigned Agents as two runs", async () => {
    const f = await fixture();
    await addAgent(f, "one");
    await addAgent(f, "two");
    expect(await admit(f)).toHaveLength(2);
    expect(count(f.sqlite, "agent_runs")).toBe(2);
    expect(f.workflow.calls.create).toHaveLength(2);
  });

  it.each(["missing", "partial"])("latches a %s repository policy and permanently dedupes its audit", async (kind) => {
    const f = await fixture({ completePolicy: kind !== "missing" });
    if (kind === "partial") f.sqlite.exec("DELETE FROM repository_operation_policies WHERE repository_id='101' AND operation_kind='issue.close'");
    await addAgent(f, "one");
    await addAgent(f, "two");
    expect(await admit(f)).toEqual([]);
    expect(await admit(f)).toEqual([]);
    expect(f.sqlite.prepare("SELECT action,detail_json FROM audit_records").all()).toEqual([
      { action: "repository.policy_unconfigured", detail_json: null },
    ]);
    expect(f.workflow.calls.create).toEqual([]);
  });

  it.each([
    ["repository_operation_policy_invalid", "PRAGMA ignore_check_constraints=ON; UPDATE repository_operation_policies SET mode='corrupt' WHERE repository_id='101' AND operation_kind='issue.close'"],
    ["repository_capability_policy_invalid", "PRAGMA ignore_check_constraints=ON; UPDATE repository_capability_policies SET constraints_json='corrupt' WHERE repository_id='101' AND capability_kind='github.issue.read'"],
    ["repository_policy_version_invalid", "UPDATE repository_operation_policies SET policy_version=2 WHERE repository_id='101' AND operation_kind='issue.close'"],
  ])("latches deterministic %s corruption with a stable non-reflective audit", async (code, mutation) => {
    const f = await fixture();
    await addAgent(f, "one");
    await addAgent(f, "two");
    f.sqlite.exec(mutation);
    expect(await admit(f)).toEqual([]);
    expect(f.sqlite.prepare("SELECT action,detail_json FROM audit_records").all()).toEqual([
      { action: "policy.invalid", detail_json: JSON.stringify({ code }) },
    ]);
    expect(f.workflow.calls.create).toEqual([]);
  });

  it("fails envelope, compiled revision, and assignment corruption closed without reflective audit detail", async () => {
    const envelopeFixture = await fixture();
    await addAgent(envelopeFixture, "one");
    await expect(admitAgentRunsForEvent(envelopeFixture.env, event, "0".repeat(64))).rejects.toThrow(/envelope hash/i);
    expect(count(envelopeFixture.sqlite, "agent_runs")).toBe(0);

    const f = await fixture();
    await addAgent(f, "bad-json", { corruptCompiled: "json" });
    await addAgent(f, "bad-hash", { corruptCompiled: "hash" });
    await addAgent(f, "bad-assignment", { corruptAssignmentHash: true });
    await addAgent(f, "good");
    expect(await admit(f)).toHaveLength(1);
    const audits = f.sqlite.prepare("SELECT action,detail_json FROM audit_records ORDER BY id").all() as Array<{ action: string; detail_json: string | null }>;
    expect(audits.map((item) => item.action)).toEqual([
      "assignment.invalid", "agent_revision.hash_mismatch", "agent_revision.invalid", "agent_run.admitted",
    ]);
    expect(audits.map((item) => item.detail_json).join(" ")).not.toContain(modelContent);
    expect(audits.filter((item) => item.action !== "agent_run.admitted" && item.detail_json !== null)
      .every((item) => /^\{"code":"[a-z_]+"\}$/.test(item.detail_json!))).toBe(true);
  });

  it("redelivery reconciles the same run and preserves its original binding after assignment and policy bumps", async () => {
    const f = await fixture();
    await addAgent(f, "one");
    const first = await admit(f);
    const original = f.sqlite.prepare("SELECT * FROM agent_runs").get() as Record<string, unknown>;
    expect(await admit(f)).toEqual([{ ...first[0], created: false }]);
    expect(f.workflow.calls.create).toHaveLength(1);

    const assignment = await getAssignment(f.db, "assignment-one");
    expect(assignment).not.toBeNull();
    const changed = { ...assignment!, version: 2, authorityCeiling: "approval" as const };
    const changedHash = await calculateAssignmentConfigHash(changed);
    f.sqlite.prepare("UPDATE agent_repository_assignments SET version=2,authority_ceiling='approval',config_hash=?,updated_at=? WHERE id='assignment-one'")
      .run(changedHash, now);
    f.sqlite.exec("UPDATE settings SET value='2' WHERE key='policy_version'");
    expect(await admit(f)).toEqual([{ ...first[0], created: false }]);
    expect(f.sqlite.prepare("SELECT * FROM agent_runs").get()).toEqual(original);
    expect(f.workflow.calls.create).toHaveLength(1);
    expect(f.workflow.calls.get).toHaveLength(2);
  });

  it.each(["workspace", "repository", "assignment"])("does not create a bounded run when %s authority requires approval", async (layer) => {
    const f = await fixture();
    if (layer === "workspace") f.sqlite.exec("UPDATE operation_policies SET mode='approval' WHERE operation_kind='issue.comment.create'");
    if (layer === "repository") f.sqlite.exec("UPDATE repository_operation_policies SET mode='approval' WHERE repository_id='101' AND operation_kind='issue.comment.create'");
    await addAgent(f, "one", { authorityCeiling: layer === "assignment" ? "approval" : "automatic" });
    expect(await admit(f)).toEqual([]);
    expect(count(f.sqlite, "agent_runs")).toBe(0);
    expect(f.workflow.calls.create).toEqual([]);
  });

  it("propagates Workflow failure, then redelivery reconciles the persisted run without duplication", async () => {
    const f = await fixture({ failCreates: 1 });
    await addAgent(f, "one");
    await expect(admit(f)).rejects.toThrow("workflow temporarily unavailable");
    expect(count(f.sqlite, "agent_runs")).toBe(1);
    expect(count(f.sqlite, "event_agent_admissions")).toBe(1);
    expect(f.sqlite.prepare("SELECT status FROM agent_runs").get()).toEqual({ status: "queued" });
    expect(f.workflow.calls).toMatchObject({ create: [expect.any(Object)], get: [], status: [] });
    const retried = await admit(f);
    expect(retried).toMatchObject([{ created: false, agentId: "agent-one", revisionId: "revision-one" }]);
    expect(count(f.sqlite, "agent_runs")).toBe(1);
    expect(count(f.sqlite, "event_agent_admissions")).toBe(1);
    expect(f.workflow.calls.create).toHaveLength(2);
    expect(f.workflow.calls.create.map((call) => call.id)).toEqual([retried[0]!.runId, retried[0]!.runId]);
    expect(f.workflow.calls.get).toEqual([retried[0]!.runId]);
    expect(f.workflow.calls.status).toEqual([]);
    expect(f.workflow.calls.restart).toEqual([]);
  });

  it("propagates non-not-found Workflow get errors and every status error", async () => {
    const f = await fixture();
    await addAgent(f, "one");
    await admit(f);
    const unexpectedCreate = async () => { throw new Error("create must not be called"); };
    f.env.AGENT_RUN_WORKFLOW = {
      create: unexpectedCreate,
      get: async () => { throw new Error("workflow provider unavailable"); },
    } as unknown as Workflow;
    await expect(admit(f)).rejects.toThrow("workflow provider unavailable");

    f.env.AGENT_RUN_WORKFLOW = {
      create: unexpectedCreate,
      get: async () => ({
        status: async () => { throw new Error("workflow status unavailable"); },
        restart: async () => undefined,
      }),
    } as unknown as Workflow;
    await expect(admit(f)).rejects.toThrow("workflow status unavailable");
    expect(count(f.sqlite, "agent_runs")).toBe(1);
    expect(count(f.sqlite, "event_agent_admissions")).toBe(1);
  });

  it("rolls back run and admission when an assignment-version race aborts the insert", async () => {
    const f = await fixture();
    await addAgent(f, "one");
    f.sqlite.exec(`CREATE TRIGGER simulate_assignment_version_race BEFORE INSERT ON agent_runs BEGIN
      UPDATE agent_repository_assignments SET version=version+1,config_hash='${"9".repeat(64)}'
        WHERE id='assignment-one';
      SELECT RAISE(ABORT,'simulated assignment version race');
    END`);
    await expect(admit(f)).rejects.toThrow(/assignment version race/);
    expect(count(f.sqlite, "agent_runs")).toBe(0);
    expect(count(f.sqlite, "event_agent_admissions")).toBe(0);
    expect((f.sqlite.prepare("SELECT version FROM agent_repository_assignments").get() as { version: number }).version).toBe(1);
    expect(f.workflow.calls.create).toEqual([]);
  });

  it.each(["global", "repository"])("skips %s pauses before touching policy", async (scope) => {
    const f = await fixture();
    await addAgent(f, "one");
    f.sqlite.exec("DELETE FROM settings WHERE key='policy_version'");
    if (scope === "global") f.sqlite.exec("UPDATE settings SET value='true' WHERE key='global_paused'");
    else f.sqlite.exec("INSERT INTO settings(key,value)VALUES('repository_paused:101','true')");
    expect(await admit(f)).toEqual([]);
    expect(count(f.sqlite, "agent_runs")).toBe(0);
    expect(count(f.sqlite, "audit_records")).toBe(0);
  });
});
