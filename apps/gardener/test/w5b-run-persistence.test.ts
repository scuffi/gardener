/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { expectedHarnessBinding } from "../src/harness";
import {
  admitEventAgentRun,
  admitRepositoryEvent,
  createAgent,
  createRun,
  getRun,
  publishAgentDraft,
  saveAgentDraft,
  updateRunState,
  type CreateRunInput,
} from "../src/persistence";
import { hash, migration, newAgentDatabase } from "./persistence-test-db";

interface Fixture {
  sqlite: ReturnType<typeof newAgentDatabase>["sqlite"];
  db: D1Database;
  binding: Required<Pick<CreateRunInput,
    "repositoryId" | "assignmentId" | "assignmentVersion" | "assignmentConfigHash"
    | "repositoryPolicyHash" | "repositoryPolicyVersion">>;
}

async function fixture(): Promise<Fixture> {
  const { sqlite, db } = newAgentDatabase();
  sqlite.exec(migration("0007_team_workspace_foundation.sql"));
  sqlite.prepare("INSERT INTO users (id, display_name) VALUES ('owner-1', 'Owner')").run();
  sqlite.prepare(`INSERT INTO repositories (id, installation_id, owner, name, default_branch)
    VALUES ('repo-1', 'installation-1', 'acme', 'garden', 'main')`).run();
  await createAgent(db, {
    id: "agent-1", slug: "agent-1", name: "Agent 1", description: "", createdBy: "owner-1",
  });
  await saveAgentDraft(db, {
    id: "draft-1", agentId: "agent-1", sourceMd: "# Agent 1\n", sourceHash: hash("source"),
    parsed: {}, validation: { valid: true }, provenance: {}, compilerVersion: "compiler-v1",
    catalogVersion: "catalog-v1", runtimeVersion: "runtime-v1", actorId: "owner-1",
  });
  await publishAgentDraft(db, {
    revisionId: "revision-1", revision: 1, draftId: "draft-1", parsedHash: hash("parsed"),
    compiled: { capabilities: [] }, compiledHash: hash("compiled"), provenance: {},
    provenanceHash: hash("provenance"), publishedBy: "owner-1",
  });
  const assignmentConfigHash = hash("assignment-v1");
  sqlite.prepare(`INSERT INTO agent_repository_assignments
    (id, agent_id, repository_id, enabled, authority_ceiling, version, config_hash,
      created_by_user_id, updated_by_user_id)
    VALUES ('assignment-1', 'agent-1', 'repo-1', 1, 'automatic', 1, ?, 'owner-1', 'owner-1')`)
    .run(assignmentConfigHash);
  await admitRepositoryEvent(db, {
    id: "event-1", provider: "github", deliveryId: "delivery-1", eventKind: "github.issue",
    action: "opened", repositoryId: "repo-1", resourceType: "issue", resourceId: "42",
    actor: {}, resourceAuthor: null, facts: {}, envelope: {}, envelopeHash: hash("envelope"),
    occurredAt: "2026-09-15T08:00:00.000Z",
  });
  return {
    sqlite,
    db,
    binding: {
      repositoryId: "repo-1",
      assignmentId: "assignment-1",
      assignmentVersion: 1,
      assignmentConfigHash,
      repositoryPolicyHash: hash("repository-policy-v1"),
      repositoryPolicyVersion: 1,
    },
  };
}

function input(id: string, kind: CreateRunInput["kind"] = "live"): CreateRunInput {
  return {
    id,
    kind,
    repositoryEventId: kind === "live" ? "event-1" : null,
    agentId: "agent-1",
    agentRevisionId: "revision-1",
    workflowInstanceId: `workflow-${id}`,
    parentRunId: null,
    status: "admitted",
    runSnapshot: { id },
    runSnapshotHash: hash(`run-${id}`),
    policySnapshot: { version: 1 },
    policySnapshotHash: hash(`policy-${id}`),
    capabilitySnapshot: { capabilities: [] },
    capabilitySnapshotHash: hash(`capability-${id}`),
    harnessId: "flue",
    harnessVersion: expectedHarnessBinding("flue").adapterVersion,
    budgets: { turns: 1 },
  };
}

function admissionInput(base: CreateRunInput, admissionId = "admission-1") {
  return { ...base, admissionId, admissionKey: hash("admission-key") };
}

describe("W5B run binding persistence", () => {
  it("deduplicates admission without rebinding after assignment and policy changes", async () => {
    const { sqlite, db, binding } = await fixture();
    try {
      const first = await admitEventAgentRun(db, admissionInput({ ...input("run-1"), ...binding }));
      const identical = await admitEventAgentRun(db, admissionInput(
        { ...input("run-1"), ...binding }, "admission-duplicate",
      ));
      expect(first.created).toBe(true);
      expect(identical).toEqual({ run: first.run, created: false });

      const assignmentConfigHash = hash("assignment-v2");
      sqlite.prepare(`UPDATE agent_repository_assignments
        SET version = 2, config_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 'assignment-1'`)
        .run(assignmentConfigHash);
      const changed = await admitEventAgentRun(db, admissionInput({
        ...input("ignored-new-run-id"),
        ...binding,
        assignmentVersion: 2,
        assignmentConfigHash,
        repositoryPolicyHash: hash("repository-policy-v2"),
        repositoryPolicyVersion: 2,
      }, "admission-after-change"));
      expect(changed).toEqual({ run: first.run, created: false });
      expect(await getRun(db, "run-1")).toEqual(first.run);
    } finally {
      sqlite.close();
    }
  });

  it("rejects partial, policy-only, and unbound live bindings before database mutation", async () => {
    const { sqlite, db } = await fixture();
    try {
      await expect(createRun(db, { ...input("partial", "manual"), repositoryPolicyHash: hash("policy-only") }))
        .rejects.toThrow("Run binding must include all six binding fields");
      await expect(admitEventAgentRun(db, admissionInput(input("unbound-live"))))
        .rejects.toThrow("Live runs require a complete binding");
      expect(sqlite.prepare("SELECT COUNT(*) AS count FROM agent_runs").get()).toEqual({ count: 0 });
      expect(sqlite.prepare("SELECT COUNT(*) AS count FROM event_agent_admissions").get()).toEqual({ count: 0 });
    } finally {
      sqlite.close();
    }
  });

  it("rolls back admission when the complete assignment tuple does not exist", async () => {
    const { sqlite, db, binding } = await fixture();
    try {
      await expect(admitEventAgentRun(db, admissionInput({
        ...input("bad-tuple"), ...binding, assignmentVersion: 99,
      }))).rejects.toThrow(/bindings must be exact/);
      expect(sqlite.prepare("SELECT COUNT(*) AS count FROM agent_runs").get()).toEqual({ count: 0 });
      expect(sqlite.prepare("SELECT COUNT(*) AS count FROM event_agent_admissions").get()).toEqual({ count: 0 });
    } finally {
      sqlite.close();
    }
  });

  it("maps all six fields and preserves the immutable binding through state updates", async () => {
    const { sqlite, db, binding } = await fixture();
    try {
      const created = await admitEventAgentRun(db, admissionInput({ ...input("bound-state"), ...binding }));
      expect(created.run).toMatchObject(binding);
      const running = await updateRunState(db, {
        runId: "bound-state", expectedStatus: "admitted", status: "running", usage: { turns: 0 }, error: null,
      });
      expect(running).toMatchObject({ ...binding, status: "running" });
      expect(await getRun(db, "bound-state")).toMatchObject(binding);
    } finally {
      sqlite.close();
    }
  });

  it("uses complete binding identity for deterministic createRun dedupe", async () => {
    const { sqlite, db, binding } = await fixture();
    try {
      const boundManual = { ...input("manual-bound", "manual"), ...binding };
      expect((await createRun(db, boundManual)).created).toBe(true);
      expect((await createRun(db, boundManual)).created).toBe(false);
      await expect(createRun(db, input("manual-bound", "manual"))).rejects.toThrow("Run dedupe conflict");
      await expect(createRun(db, {
        ...boundManual, repositoryPolicyHash: hash("different-policy"),
      })).rejects.toThrow("Run dedupe conflict");
    } finally {
      sqlite.close();
    }
  });
});
