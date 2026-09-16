/// <reference types="node" />
import { canonicalOperationHash, canonicalSha256 } from "@gardener/core";
import { describe, expect, it } from "vitest";
import { expectedHarnessBinding, type HarnessRequest, type HarnessSubmission } from "../src/harness";
import {
  activateAgentRevision,
  admitEventAgentRun,
  admitRepositoryEvent,
  claimEffectExecution,
  claimInterruptionResponse,
  claimRepositoryEventAdmission,
  claimRunStep,
  claimRunTask,
  claimWorkspaceCleanup,
  completeRepositoryEventAdmission,
  completeRunStep,
  completeRunTask,
  completeWorkspaceCleanup,
  createAgent,
  D1HarnessRequestStore,
  createEffect,
  createInterruption,
  createRun,
  createRunStep,
  createRunTask,
  createWorkspaceLease,
  getAgent,
  getAgentDraft,
  getWorkspaceLease,
  publishAgentDraft,
  recordEffectOutcome,
  releaseRepositoryEventAdmission,
  saveAgentDraft,
  setAgentEnabled,
  updateRunState,
  type CreateRunInput,
} from "../src/persistence";
import { hash, migration, newAgentDatabase } from "./persistence-test-db";

async function createPublishedAgent(db: D1Database, suffix = "1"): Promise<{ agentId: string; revisionId: string }> {
  const agentId = `agent-${suffix}`;
  const draftId = `draft-${suffix}`;
  const revisionId = `revision-${suffix}`;
  await createAgent(db, {
    id: agentId,
    slug: `agent-${suffix}`,
    name: `Agent ${suffix}`,
    description: "",
    createdBy: "owner-1",
  });
  await saveAgentDraft(db, {
    id: draftId,
    agentId,
    sourceMd: `# Agent ${suffix}\n`,
    sourceHash: hash(`source-${suffix}`),
    parsed: { name: `Agent ${suffix}` },
    validation: { valid: true },
    provenance: { source: "dashboard" },
    compilerVersion: "compiler-v1",
    catalogVersion: "catalog-v1",
    runtimeVersion: "runtime-v1",
    actorId: "owner-1",
  });
  await publishAgentDraft(db, {
    revisionId,
    revision: 1,
    draftId,
    parsedHash: hash(`parsed-${suffix}`),
    compiled: { capabilities: [] },
    compiledHash: hash(`compiled-${suffix}`),
    provenance: { source: "dashboard" },
    provenanceHash: hash(`provenance-${suffix}`),
    publishedBy: "owner-1",
  });
  return { agentId, revisionId };
}

function runInput(
  id: string,
  agentId: string,
  revisionId: string,
  kind: CreateRunInput["kind"],
  eventId: string | null,
): CreateRunInput {
  return {
    id,
    kind,
    repositoryEventId: eventId,
    agentId,
    agentRevisionId: revisionId,
    workflowInstanceId: `workflow-${id}`,
    parentRunId: null,
    status: "admitted",
    runSnapshot: { agentId, revisionId },
    runSnapshotHash: hash(`run-${id}`),
    policySnapshot: { operations: {} },
    policySnapshotHash: hash(`policy-${id}`),
    capabilitySnapshot: { capabilities: [] },
    capabilitySnapshotHash: hash(`caps-${id}`),
    harnessId: "flue",
    harnessVersion: expectedHarnessBinding("flue").adapterVersion,
    budgets: { turns: 20 },
  };
}

describe("Agent persistence", () => {
  it("publishes immutable paused revisions while activation and enablement remain separate", async () => {
    const { sqlite, db } = newAgentDatabase();
    try {
      await createAgent(db, {
        id: "agent-1",
        slug: "maintainer",
        name: "Maintainer",
        description: "Gardens the repository",
        createdBy: "owner-1",
      });
      let agent = await getAgent(db, "agent-1");
      expect(agent).toMatchObject({ enabled: false, activeRevisionId: null, revisionCounter: 0 });

      await saveAgentDraft(db, {
        id: "draft-1",
        agentId: "agent-1",
        sourceMd: "# Maintainer\n",
        sourceHash: hash("source-a"),
        parsed: { name: "Maintainer" },
        validation: { valid: true },
        provenance: { author: "owner-1" },
        compilerVersion: "compiler-v1",
        catalogVersion: "catalog-v1",
        runtimeVersion: "runtime-v1",
        actorId: "owner-1",
      });
      const revision = await publishAgentDraft(db, {
        revisionId: "revision-1",
        revision: 1,
        draftId: "draft-1",
        parsedHash: hash("parsed-a"),
        compiled: { requestedCapabilities: [] },
        compiledHash: hash("compiled-a"),
        provenance: { author: "owner-1" },
        provenanceHash: hash("provenance-a"),
        publishedBy: "owner-1",
      });
      expect(revision).toMatchObject({ revision: 1, publishedPaused: true });
      agent = await getAgent(db, "agent-1");
      expect(agent).toMatchObject({ enabled: false, activeRevisionId: null, revisionCounter: 1 });

      await expect(setAgentEnabled(db, {
        historyId: "enable-before-activation",
        agentId: "agent-1",
        enabled: true,
        actorId: "owner-1",
        reason: null,
      })).rejects.toThrow("Agent enablement change failed");
      agent = await getAgent(db, "agent-1");
      expect(agent).toMatchObject({ enabled: false, activeRevisionId: null });

      await activateAgentRevision(db, {
        historyId: "activation-1",
        agentId: "agent-1",
        revisionId: "revision-1",
        actorId: "owner-1",
        reason: "reviewed",
      });
      agent = await getAgent(db, "agent-1");
      expect(agent).toMatchObject({ enabled: false, activeRevisionId: "revision-1" });
      await setAgentEnabled(db, {
        historyId: "enable-1",
        agentId: "agent-1",
        enabled: true,
        actorId: "owner-1",
        reason: null,
      });
      agent = await getAgent(db, "agent-1");
      expect(agent).toMatchObject({ enabled: true, activeRevisionId: "revision-1" });

      await expect(saveAgentDraft(db, {
        id: "draft-1",
        agentId: "agent-1",
        sourceMd: "changed",
        sourceHash: hash("source-b"),
        parsed: {},
        validation: {},
        provenance: {},
        compilerVersion: "compiler-v1",
        catalogVersion: "catalog-v1",
        runtimeVersion: "runtime-v1",
        actorId: "owner-1",
      })).rejects.toThrow("Only an editing draft can be changed");
      expect((await getAgentDraft(db, "draft-1"))?.status).toBe("published");
      expect(() => sqlite.prepare("UPDATE agent_revisions SET source_md = 'tampered' WHERE id = 'revision-1'").run())
        .toThrow(/agent revisions are immutable/);
    } finally {
      sqlite.close();
    }
  });

  it("enforces optimistic draft versions and authoring idempotency hashes", async () => {
    const { sqlite, db } = newAgentDatabase();
    const input = (sourceMd: string, sourceHash: string, expectedVersion: number, key: string) => ({
      id: "draft-versioned", agentId: "agent-draft", sourceMd, sourceHash,
      parsed: {}, validation: {}, provenance: {}, compilerVersion: "compiler-v1",
      catalogVersion: "catalog-v1", runtimeVersion: "runtime-v1", actorId: "owner-1",
      expectedVersion, idempotencyKeyHash: hash(key),
    });
    try {
      await createAgent(db, { id: "agent-draft", slug: "agent-draft", name: "Draft", description: "", createdBy: "owner-1" });
      const first = await saveAgentDraft(db, input("source one", hash("draft-one"), 0, "key-one"));
      expect(first).toMatchObject({ version: 1, idempotencyKeyHash: hash("key-one") });
      await expect(saveAgentDraft(db, input("stale", hash("draft-stale"), 0, "key-two")))
        .rejects.toThrow("Only an editing draft can be changed");
      expect(await getAgentDraft(db, "draft-versioned")).toMatchObject({ version: 1, sourceHash: hash("draft-one") });
      const second = await saveAgentDraft(db, input("source two", hash("draft-two"), 1, "key-two"));
      expect(second).toMatchObject({ version: 2, sourceHash: hash("draft-two"), idempotencyKeyHash: hash("key-two") });
    } finally {
      sqlite.close();
    }
  });

  it("deduplicates event/Agent live admission without imposing a global run lock", async () => {
    const { sqlite, db } = newAgentDatabase();
    try {
      sqlite.prepare("INSERT INTO users (id, display_name) VALUES ('owner-1', 'Owner')").run();
      sqlite.prepare(`
        INSERT INTO repositories (id, installation_id, owner, name, default_branch)
        VALUES ('repo-1', 'install-1', 'acme', 'garden', 'main')
      `).run();
      const { agentId, revisionId } = await createPublishedAgent(db);
      const assignmentConfigHash = hash("assignment-config-v1");
      sqlite.prepare(`
        INSERT INTO agent_repository_assignments
          (id, agent_id, repository_id, enabled, authority_ceiling, version, config_hash, created_by_user_id, updated_by_user_id)
        VALUES ('assignment-1', ?, 'repo-1', 1, 'automatic', 1, ?, 'owner-1', 'owner-1')
      `).run(agentId, assignmentConfigHash);
      const binding = {
        repositoryId: "repo-1",
        assignmentId: "assignment-1",
        assignmentVersion: 1,
        assignmentConfigHash,
        repositoryPolicyHash: hash("repository-policy-v1"),
        repositoryPolicyVersion: 1,
      };
      const eventInput = {
        id: "event-1",
        provider: "github",
        deliveryId: "delivery-1",
        eventKind: "github.issue",
        action: "opened",
        repositoryId: "repo-1",
        resourceType: "issue",
        resourceId: "42",
        actor: { id: "user-1" },
        resourceAuthor: { id: "user-2" },
        facts: { number: 42 },
        envelope: { schemaVersion: 2 },
        envelopeHash: hash("event-envelope"),
        occurredAt: "2026-09-09T10:00:00.000Z",
      };
      expect((await admitRepositoryEvent(db, eventInput)).admitted).toBe(true);
      expect(await claimRepositoryEventAdmission(db, {
        eventId: "event-1", token: "lease-a", now: "2026-09-09T10:00:01.000Z", leaseExpiresAt: "2026-09-09T10:05:01.000Z",
      })).toBe(true);
      expect(await claimRepositoryEventAdmission(db, {
        eventId: "event-1", token: "lease-b", now: "2026-09-09T10:00:02.000Z", leaseExpiresAt: "2026-09-09T10:05:02.000Z",
      })).toBe(false);
      expect(await releaseRepositoryEventAdmission(db, { eventId: "event-1", token: "wrong" })).toBe(false);
      expect(await releaseRepositoryEventAdmission(db, { eventId: "event-1", token: "lease-a" })).toBe(true);
      expect(await claimRepositoryEventAdmission(db, {
        eventId: "event-1", token: "lease-c", now: "2026-09-09T10:00:03.000Z", leaseExpiresAt: "2026-09-09T10:05:03.000Z",
      })).toBe(true);
      expect(await completeRepositoryEventAdmission(db, { eventId: "event-1", token: "lease-c", now: "2026-09-09T10:00:04.000Z" })).toBe(true);
      expect(await claimRepositoryEventAdmission(db, {
        eventId: "event-1", token: "lease-d", now: "2026-09-09T10:10:00.000Z", leaseExpiresAt: "2026-09-09T10:15:00.000Z",
      })).toBe(false);
      expect((await admitRepositoryEvent(db, { ...eventInput, id: "event-duplicate" })).admitted).toBe(false);
      await expect(admitRepositoryEvent(db, {
        ...eventInput,
        id: "event-conflict",
        envelopeHash: hash("different-envelope"),
      })).rejects.toThrow("Repository event dedupe conflict");

      const first = await admitEventAgentRun(db, {
        ...runInput("run-live-1", agentId, revisionId, "live", "event-1"),
        ...binding,
        admissionId: "admission-1",
        admissionKey: hash("admission-1"),
      });
      const duplicate = await admitEventAgentRun(db, {
        ...runInput("run-live-1", agentId, revisionId, "live", "event-1"),
        ...binding,
        admissionId: "admission-duplicate",
        admissionKey: hash("admission-1"),
      });
      expect(first.created).toBe(true);
      expect(duplicate.created).toBe(false);
      expect(duplicate.run.id).toBe("run-live-1");
      await expect(admitEventAgentRun(db, {
        ...runInput("run-live-1", agentId, revisionId, "live", "event-1"),
        ...binding,
        admissionId: "admission-conflict",
        admissionKey: hash("different-admission"),
      })).rejects.toThrow("Event Agent admission conflict");

      const manualA = await createRun(db, runInput("manual-a", agentId, revisionId, "manual", null));
      const manualB = await createRun(db, runInput("manual-b", agentId, revisionId, "manual", null));
      expect([manualA.created, manualB.created]).toEqual([true, true]);
      await updateRunState(db, { runId: "manual-b", expectedStatus: "admitted", status: "running", usage: {}, error: null });
      const terminal = await updateRunState(db, { runId: "manual-b", expectedStatus: "running", status: "completed", usage: { turns: 1 }, error: null });
      expect(terminal.status).toBe("completed");
      await expect(updateRunState(db, { runId: "manual-b", expectedStatus: "completed", status: "running", usage: {}, error: null }))
        .rejects.toThrow("Invalid or stale run transition");
      expect((await updateRunState(db, { runId: "manual-b", expectedStatus: "running", status: "completed", usage: {}, error: null })).status).toBe("completed");

      const [taskA, taskB] = await Promise.all([
        createRunTask(db, {
          id: "task-a",
          runId: "manual-a",
          parentTaskId: null,
          stableKey: "parallel/a",
          kind: "investigate",
          parallelGroup: "fanout-1",
          depth: 0,
          assignedAgentId: null,
          assignedRevisionId: null,
          input: { path: "src/a" },
          inputHash: hash("task-a"),
          budgets: { turns: 5 },
        }),
        createRunTask(db, {
          id: "task-b",
          runId: "manual-a",
          parentTaskId: null,
          stableKey: "parallel/b",
          kind: "investigate",
          parallelGroup: "fanout-1",
          depth: 0,
          assignedAgentId: null,
          assignedRevisionId: null,
          input: { path: "src/b" },
          inputHash: hash("task-b"),
          budgets: { turns: 5 },
        }),
      ]);
      expect([taskA.created, taskB.created]).toEqual([true, true]);
      expect(sqlite.prepare("SELECT COUNT(*) AS count FROM run_tasks WHERE parallel_group = 'fanout-1'").get()).toEqual({ count: 2 });
      expect(await claimRunTask(db, taskA.task.id, hash("task-a"))).toBe(true);
      expect(await completeRunTask(db, {
        taskId: taskA.task.id,
        inputHash: hash("task-a"),
        result: { finding: "done" },
        resultHash: hash("task-a-result"),
        usage: { turns: 1 },
      })).toBe(true);

      const step = await createRunStep(db, {
        id: "step-b",
        runId: "manual-a",
        taskId: taskB.task.id,
        stableKey: "parallel/b/model-1",
        kind: "model",
        input: { prompt: "inspect" },
        inputHash: hash("step-b-input"),
        maxAttempts: 2,
      });
      expect(await claimRunStep(db, {
        stepId: step.step.id,
        inputHash: hash("step-b-input"),
        now: "2026-09-09T12:00:00.000Z",
      })).toBe(true);
      expect(await completeRunStep(db, {
        stepId: step.step.id,
        inputHash: hash("step-b-input"),
        result: { answer: "ok" },
        resultHash: hash("step-b-result"),
        artifactRefs: [],
      })).toBe(true);
    } finally {
      sqlite.close();
    }
  });

  it("stores immutable Flue requests for durable submission reads", async () => {
    const { sqlite, db } = newAgentDatabase();
    try {
      const { agentId, revisionId } = await createPublishedAgent(db);
      await createRun(db, runInput("flue-run", agentId, revisionId, "manual", null));
      const request: HarnessRequest = {
        schemaVersion: "gardener.harness.request/v1",
        requestId: "flue-request-1",
        runId: "flue-run",
        snapshot: {
          agentRevisionId: revisionId,
          agentRevisionHash: "a".repeat(64),
          promptReference: "prompt:1",
          policySnapshotReference: "policy:1",
          toolCatalogVersion: "tools:1",
          harness: expectedHarnessBinding("flue"),
        },
        prompt: "Return one bounded proposal.",
        model: { id: "@cf/test/model" },
        tools: [],
        budget: { maxTurns: 1, maxToolCalls: 0, maxInputTokens: 1_000, maxOutputTokens: 500, maxRuntimeMs: 30_000, deadlineAt: "2099-01-01T00:00:00.000Z" },
      };
      const store = new D1HarnessRequestStore(db);

      await store.put(request);
      await store.put(request);
      await expect(store.get(request.runId, request.requestId)).resolves.toEqual(request);
      await expect(store.put({ ...request, prompt: "Conflicting prompt" })).rejects.toThrow(/immutable harness request conflict/i);
      expect(() => sqlite.prepare("UPDATE harness_requests SET request_json = ? WHERE run_id = ? AND request_id = ?")
        .run(JSON.stringify({ ...request, prompt: "Tampered" }), request.runId, request.requestId)).toThrow(/harness requests are immutable/i);

      const submission: HarnessSubmission = {
        schemaVersion: "gardener.harness.submission/v1",
        harness: expectedHarnessBinding("flue"),
        runId: request.runId,
        requestId: request.requestId,
        submissionId: "flue-submission-1",
        acceptedAt: "2026-09-11T10:00:00.000Z",
      };
      await store.putSubmission(submission);
      await store.putSubmission(submission);
      await expect(store.getSubmission(request.runId, request.requestId)).resolves.toEqual(submission);
      await expect(store.putSubmission({ ...submission, submissionId: "flue-submission-conflict" }))
        .rejects.toThrow(/immutable harness submission conflict/i);
      expect(() => sqlite.prepare("UPDATE harness_submissions SET submission_json = ? WHERE run_id = ? AND request_id = ?")
        .run(JSON.stringify({ ...submission, submissionId: "tampered" }), request.runId, request.requestId)).toThrow(/harness submissions are immutable/i);
    } finally {
      sqlite.close();
    }
  });

  it("claims an exact interruption response once and expires stale requests", async () => {
    const { sqlite, db } = newAgentDatabase();
    try {
      const { agentId, revisionId } = await createPublishedAgent(db);
      await createRun(db, runInput("manual-1", agentId, revisionId, "manual", null));
      await createInterruption(db, {
        id: "interrupt-1",
        runId: "manual-1",
        taskId: null,
        stepId: null,
        kind: "capability",
        eligibleResponders: ["owner-1"],
        eligibleRespondersHash: hash("responders-1"),
        requestPayload: { capability: "workspace.exec.container" },
        requestPayloadHash: hash("request-1"),
        nonceHash: hash("nonce-1"),
        expiresAt: "2026-09-10T00:00:00.000Z",
      });
      expect((await claimInterruptionResponse(db, {
        id: "interrupt-1",
        nonceHash: hash("wrong-nonce"),
        responderId: "owner-1",
        decision: "responded",
        responsePayload: { decision: "allow-this-run" },
        responsePayloadHash: hash("response-1"),
        now: "2026-09-09T12:00:00.000Z",
      })).outcome).toBe("invalid");
      expect((await claimInterruptionResponse(db, {
        id: "interrupt-1",
        nonceHash: hash("nonce-1"),
        responderId: "intruder",
        decision: "responded",
        responsePayload: { decision: "allow-this-run" },
        responsePayloadHash: hash("response-1"),
        now: "2026-09-09T12:00:00.000Z",
      })).outcome).toBe("ineligible");

      const response = {
        id: "interrupt-1",
        nonceHash: hash("nonce-1"),
        responderId: "owner-1",
        decision: "responded" as const,
        responsePayload: { decision: "allow-this-run" },
        responsePayloadHash: hash("response-1"),
        now: "2026-09-09T12:00:00.000Z",
      };
      expect((await claimInterruptionResponse(db, response)).outcome).toBe("accepted");
      expect((await claimInterruptionResponse(db, response)).outcome).toBe("replayed");
      expect(await claimInterruptionResponse(db, {
        ...response,
        nonceHash: hash("wrong-after-response"),
      })).toEqual({ outcome: "invalid", interruption: null });
      expect((await claimInterruptionResponse(db, {
        ...response,
        responsePayload: { decision: "deny" },
        responsePayloadHash: hash("response-conflict"),
      })).outcome).toBe("conflict");

      await createInterruption(db, {
        id: "interrupt-expired",
        runId: "manual-1",
        taskId: null,
        stepId: null,
        kind: "clarification",
        eligibleResponders: ["owner-1"],
        eligibleRespondersHash: hash("responders-2"),
        requestPayload: { question: "Proceed?" },
        requestPayloadHash: hash("request-2"),
        nonceHash: hash("nonce-2"),
        expiresAt: "2026-09-08T00:00:00.000Z",
      });
      expect((await claimInterruptionResponse(db, {
        ...response,
        id: "interrupt-expired",
        nonceHash: hash("nonce-2"),
      })).outcome).toBe("expired");
    } finally {
      sqlite.close();
    }
  });

  it("binds effect receipts to the exact operation hash", async () => {
    const { sqlite, db } = newAgentDatabase();
    try {
      const { agentId, revisionId } = await createPublishedAgent(db);
      await createRun(db, runInput("manual-effect", agentId, revisionId, "manual", null));
      const operation = {
        schemaVersion: "v2" as const,
        id: "operation-1",
        kind: "issue.comment.create" as const,
        repository: { provider: "github" as const, id: "123", installationId: "456", owner: "owner", name: "repo", defaultBranch: "main" },
        issueNumber: 1,
        expectedIssueState: "open" as const,
        expectedIssueUpdatedAt: "2026-09-09T11:00:00.000Z",
        body: "Hello",
      };
      const operationHash = await canonicalOperationHash(operation);
      await createEffect(db, {
        id: "effect-1",
        operationId: "operation-1",
        runId: "manual-effect",
        taskId: null,
        stepId: null,
        interruptionId: null,
        effectKind: "issue.comment.create",
        operation,
        operationHash,
        rationale: "Respond",
        policyMode: "automatic",
        policySnapshotHash: hash("policy-manual-effect"),
        status: "approved",
      });
      expect(await claimEffectExecution(db, {
        effectId: "effect-1",
        operationHash: hash("wrong-operation"),
      })).toBe(false);
      expect(await claimEffectExecution(db, {
        effectId: "effect-1",
        operationHash,
      })).toBe(true);
      expect(await claimEffectExecution(db, {
        effectId: "effect-1",
        operationHash,
      })).toBe(true);
      const receipt = {
        schemaVersion: "v2" as const,
        operationId: operation.id,
        operationHash,
        kind: operation.kind,
        status: "succeeded" as const,
        attempt: 1,
        attemptedAt: "2026-09-09T12:00:00.000Z",
        completedAt: "2026-09-09T12:00:01.000Z",
      };
      await expect(recordEffectOutcome(db, {
        effectId: "effect-1",
        operationHash: hash("wrong-operation"),
        receipt,
      })).rejects.toThrow("stale or invalid");
      const recorded = await recordEffectOutcome(db, {
        effectId: "effect-1",
        operationHash,
        receipt,
      });
      expect(recorded.effect.status).toBe("executed");
      expect(sqlite.prepare("SELECT status, operation_hash, receipt_hash FROM effects WHERE id = 'effect-1'").get()).toEqual({
        status: "executed",
        operation_hash: operationHash,
        receipt_hash: await canonicalSha256(receipt),
      });
    } finally {
      sqlite.close();
    }
  });

  it("claims due workspace cleanup once and permits takeover only after claim expiry", async () => {
    const { sqlite, db } = newAgentDatabase();
    try {
      const { agentId, revisionId } = await createPublishedAgent(db);
      await createRun(db, runInput("manual-workspace", agentId, revisionId, "manual", null));
      await createWorkspaceLease(db, {
        id: "workspace-1",
        runId: "manual-workspace",
        taskId: null,
        workspaceKey: "manual-workspace/main",
        backend: "shell",
        state: "active",
        leaseTokenHash: hash("lease-1"),
        leaseExpiresAt: "2026-09-09T11:00:00.000Z",
        cleanupAfter: "2026-09-09T11:00:00.000Z",
      });
      expect((await claimWorkspaceCleanup(db, {
        id: "workspace-1",
        workerId: "invalid-cleaner",
        claimTokenHash: hash("invalid-cleaner"),
        now: "2026-09-09T12:00:00.000Z",
        claimExpiresAt: "2026-09-09T11:59:00.000Z",
      })).claimed).toBe(false);

      const first = await claimWorkspaceCleanup(db, {
        id: "workspace-1",
        workerId: "cleanup-a",
        claimTokenHash: hash("cleanup-a"),
        now: "2026-09-09T12:00:00.000Z",
        claimExpiresAt: "2026-09-09T12:05:00.000Z",
      });
      expect(first.claimed).toBe(true);
      expect((await claimWorkspaceCleanup(db, {
        id: "workspace-1",
        workerId: "cleanup-b",
        claimTokenHash: hash("cleanup-b"),
        now: "2026-09-09T12:01:00.000Z",
        claimExpiresAt: "2026-09-09T12:06:00.000Z",
      })).claimed).toBe(false);
      expect((await claimWorkspaceCleanup(db, {
        id: "workspace-1",
        workerId: "cleanup-b",
        claimTokenHash: hash("cleanup-b"),
        now: "2026-09-09T12:06:00.000Z",
        claimExpiresAt: "2026-09-09T12:11:00.000Z",
      })).claimed).toBe(true);

      expect(await completeWorkspaceCleanup(db, {
        id: "workspace-1",
        claimTokenHash: hash("cleanup-a"),
        now: "2026-09-09T12:07:00.000Z",
        completedAt: "2026-09-09T12:07:00.000Z",
        error: null,
      })).toBe(false);
      expect(await completeWorkspaceCleanup(db, {
        id: "workspace-1",
        claimTokenHash: hash("cleanup-b"),
        now: "2026-09-09T12:07:00.000Z",
        completedAt: "2026-09-09T12:07:00.000Z",
        error: null,
      })).toBe(true);
      expect(await getWorkspaceLease(db, "workspace-1")).toMatchObject({
        state: "released",
        cleanupState: "completed",
        cleanupAttempts: 2,
      });
    } finally {
      sqlite.close();
    }
  });
});
