import { canonicalJson, canonicalSha256 } from "@gardener/core";
import { describe, expect, it } from "vitest";
import {
  operationKindValues,
  taskEffectProposalV1Schema,
  type NormalizedEventV1,
  type TaskBundleV1,
  type TaskEffectProposalV1,
  type TaskRunRequestV1,
} from "@gardener/contracts";
import type { RunnerEffectReceiptV1 } from "@gardener/protocol";
import {
  assertReceiptMatchesPlan,
  buildTaskEffectPlan,
  deriveOperationId,
  type CompletedTaskOutcomeV1,
  type TaskEffectPlanCaptureV1,
} from "../src/task-runtime/effect-plan";
import { inspectRepositoryFixtureBundle } from "./fixture-bundle";

const COMMIT = "b".repeat(40);
const ISSUE_PRECONDITIONS = {
  issueNumber: 1,
  expectedIssueState: "open",
  expectedIssueUpdatedAt: "2026-09-17T12:00:00.000Z",
} as const;

const workflow = {
  runId: "35256179260",
  runAttempt: 1,
  workflowRef: "scuffi/demo/.github/workflows/gardener.yml@refs/heads/main",
  jobWorkflowRef: `scuffi/demo/.github/workflows/gardener-task.yml@${"c".repeat(40)}`,
  runnerEnvironment: "github-hosted" as const,
};

const repository = {
  id: "1374842705",
  ownerId: "45369682",
  owner: "scuffi",
  name: "demo",
  fullName: "scuffi/demo",
  visibility: "public" as const,
  commitSha: COMMIT,
  ref: "refs/heads/main",
  defaultBranch: "main",
};

function issueEvent(): NormalizedEventV1 {
  return {
    schemaVersion: "gardener.normalized-event/v1",
    eventId: "event:1",
    occurredAt: "2026-09-17T12:00:00.000Z",
    kind: "github.issue.opened",
    repository,
    workflow: { ...workflow, eventName: "issues" },
    actor: { id: "45369682", login: "scuffi" },
    issue: { id: "999", number: 1, title: "Bug", body: "Broken", state: "open", updatedAt: "2026-09-17T12:00:00.000Z", labels: ["gardener-test"], author: { id: "45369682", login: "scuffi" } },
  };
}

function dispatchEvent(): NormalizedEventV1 {
  return {
    schemaVersion: "gardener.normalized-event/v1",
    eventId: "event:2",
    occurredAt: "2026-09-17T12:00:00.000Z",
    kind: "github.workflow_dispatch",
    repository,
    workflow: { ...workflow, eventName: "workflow_dispatch" },
    actor: { id: "45369682", login: "scuffi" },
    prompt: "Do the scheduled sweep.",
  };
}

async function runRequest(overrides: {
  effects?: readonly string[];
  event?: NormalizedEventV1;
  maxEffectOperations?: number;
  maxEffectBytes?: number;
} = {}): Promise<TaskRunRequestV1> {
  const bundle = structuredClone(inspectRepositoryFixtureBundle()) as TaskBundleV1;
  bundle.effects = [...(overrides.effects ?? operationKindValues)] as TaskBundleV1["effects"];
  bundle.triggers = [{ kind: "github.issue.opened", labelsAll: [] }, { kind: "github.workflow_dispatch" }];
  if (overrides.maxEffectOperations !== undefined) bundle.limits.maxEffectOperations = overrides.maxEffectOperations;
  if (overrides.maxEffectBytes !== undefined) bundle.limits.maxEffectBytes = overrides.maxEffectBytes;
  return {
    schemaVersion: "gardener.task-run-request/v1",
    runId: "run:fixture:1",
    bundle,
    bundleHash: await canonicalSha256(bundle),
    sourcePath: ".gardener/tasks/fixture.issue-triage/TASK.md",
    policySnapshotHash: "d".repeat(64),
    event: overrides.event ?? issueEvent(),
    model: { id: "@cf/test/model" },
    admittedAt: "2026-09-17T12:00:00.000Z",
    deadlineAt: "2026-09-17T12:05:00.000Z",
  };
}

function outcome(request: TaskRunRequestV1, proposedEffects: readonly unknown[]): CompletedTaskOutcomeV1 {
  return {
    schemaVersion: "gardener.task-outcome/v1",
    runId: request.runId,
    taskId: request.bundle.taskId,
    bundleHash: request.bundleHash,
    status: "completed",
    summary: "Done.",
    observations: [],
    proposedEffects: proposedEffects as TaskEffectProposalV1[],
  };
}

const comment = {
  stepName: "comment",
  kind: "issue.comment.create",
  payload: { ...ISSUE_PRECONDITIONS, body: "Thanks." },
  references: {},
  rationale: "Acknowledge.",
} as const;

const branch = {
  stepName: "branch",
  kind: "branch.create",
  payload: { branch: "gardener/fix-1", fromSha: COMMIT, expectedAbsent: true },
  references: {},
  rationale: "Work needs a branch.",
} as const;

describe("ordered effect plan derivation", () => {
  it("binds the run, task, bundle, repository, provenance, and triggering event", async () => {
    const request = await runRequest();
    const plan = await buildTaskEffectPlan({ request, outcome: outcome(request, [comment]) });

    expect(plan).toMatchObject({
      schemaVersion: "gardener.task-effect-plan/v1",
      runId: request.runId,
      taskId: request.bundle.taskId,
      taskName: request.bundle.name,
      bundleHash: request.bundleHash,
      repository: { id: repository.id, fullName: repository.fullName },
      provenance: {
        sourcePath: request.sourcePath,
        commitSha: COMMIT,
        workflowRunId: workflow.runId,
        workflowRunAttempt: 1,
      },
      event: {
        kind: "github.issue.opened",
        eventName: "issues",
        action: "opened",
        resource: { kind: "issue", id: "999", number: 1 },
        commentId: null,
      },
    });
    // Nothing installation-shaped survives into an Actions plan.
    expect(canonicalJson(plan)).not.toContain("installation");
  });

  it("plans an arbitrary trigger with no resource, not just issues", async () => {
    const request = await runRequest({ event: dispatchEvent() });
    const plan = await buildTaskEffectPlan({ request, outcome: outcome(request, [branch]) });
    expect(plan.event).toEqual({
      kind: "github.workflow_dispatch",
      eventName: "workflow_dispatch",
      action: null,
      resource: null,
      commentId: null,
    });
  });

  it("keeps proposal order and derives ids from the run, index, name, and payload", async () => {
    const request = await runRequest();
    const second = { ...comment, payload: { ...comment.payload, body: "And again." } };
    const plan = await buildTaskEffectPlan({
      request,
      outcome: outcome(request, [branch, { ...second, stepName: "comment" }]),
    });

    expect(plan.operations.map((operation) => operation.stepName)).toEqual(["branch", "comment"]);
    expect(plan.operations[0]?.operationId).toBe(await deriveOperationId(request.runId, 0, branch as TaskEffectProposalV1));
    for (const operation of plan.operations) expect(operation.operationId).toMatch(/^op_[a-f0-9]{64}$/);
    expect(new Set(plan.operations.map((operation) => operation.operationId)).size).toBe(2);
  });

  it("derives byte-identical plans from the same outcome and different ids per position", async () => {
    const request = await runRequest();
    const value = outcome(request, [comment]);
    const first = await buildTaskEffectPlan({ request, outcome: value });
    const second = await buildTaskEffectPlan({ request, outcome: value });
    expect(canonicalJson(second)).toBe(canonicalJson(first));

    const moved = await buildTaskEffectPlan({ request, outcome: outcome(request, [branch, comment]) });
    expect(moved.operations[1]?.operationId).not.toBe(first.operations[0]?.operationId);
  });

  it("does not change an operation id when only the rationale is reworded", async () => {
    const request = await runRequest();
    const original = await buildTaskEffectPlan({ request, outcome: outcome(request, [comment]) });
    const reworded = await buildTaskEffectPlan({
      request,
      outcome: outcome(request, [{ ...comment, rationale: "Completely different prose." }]),
    });
    expect(reworded.operations[0]?.operationId).toBe(original.operations[0]?.operationId);
  });

  it("accepts an empty plan and never fabricates an operation", async () => {
    const request = await runRequest();
    const plan = await buildTaskEffectPlan({ request, outcome: outcome(request, []) });
    expect(plan.operations).toEqual([]);
  });

  it("carries forward references and the fields they leave unresolved", async () => {
    const request = await runRequest();
    const plan = await buildTaskEffectPlan({
      request,
      outcome: outcome(request, [
        branch,
        { ...comment, references: { "/body": { step: "branch", output: "branch" } } },
      ]),
    });
    expect(plan.operations[1]?.references).toEqual({ "/body": { step: "branch", output: "branch" } });
  });

  it("refuses a reference to a step that does not run before it", async () => {
    const request = await runRequest();
    await expect(buildTaskEffectPlan({
      request,
      outcome: outcome(request, [
        { ...comment, references: { "/body": { step: "branch", output: "branch" } } },
        branch,
      ]),
    })).rejects.toThrow(/does not run before this step/);
  });

  it("refuses any kind the admitted bundle did not declare", async () => {
    const request = await runRequest({ effects: ["issue.comment.create"] });
    await expect(buildTaskEffectPlan({ request, outcome: outcome(request, [branch]) }))
      .rejects.toThrow(/undeclared effect branch\.create/);
  });

  it("accepts every declared operation kind the model can name", async () => {
    // All 29 kinds parse as proposals; authority is the bundle, not the schema.
    const request = await runRequest();
    for (const kind of operationKindValues) {
      expect(request.bundle.effects).toContain(kind);
    }
    expect(request.bundle.effects).toHaveLength(29);
  });
});

const capture = {
  manifest: {
    schemaVersion: "gardener.task-capture-manifest/v1",
    captureId: "capture-1",
    baseSha: COMMIT,
    files: [{ status: "modified", path: "src/a.ts", mode: "100644", sizeBytes: 3, sha256: "e".repeat(64) }],
    totalBytes: 3,
    truncated: false,
  },
  changesSha256: "f".repeat(64),
} satisfies TaskEffectPlanCaptureV1;

/** A commit whose contents the apply job materializes from the capture. */
const deferredCommit = {
  stepName: "commit",
  kind: "commit.create",
  payload: { branch: "gardener/fix-1", expectedHeadSha: COMMIT, message: "Fix it." },
  references: {},
  rationale: "Commit the captured change.",
};

/** A commit that tries to carry its own bytes. There is no such mode. */
const inlineCommit = {
  ...deferredCommit,
  payload: { ...deferredCommit.payload, files: [{ path: "src/a.ts", contentBase64: "AA==" }] },
  rationale: "Commit content the model produced itself.",
};

describe("capture-dependent steps", () => {
  it("lets a model propose a commit whose contents the capture supplies", () => {
    // The proposal layer probes with this kind's deferred pointers, so an
    // omitted `/files` is a well-formed capture-backed commit rather than a
    // malformed payload. Without this the capture path would be unreachable
    // and a commit could not be proposed at all.
    expect(() => taskEffectProposalV1Schema.parse(deferredCommit)).not.toThrow();
  });

  it("refuses a commit whose bytes the model supplied itself", () => {
    // Repository file bytes never enter the model or the Worker, so there is
    // no inline mode to fall back to: `/files` is capture-owned for every
    // `commit.create` and supplying it is an error, not an alternative.
    expect(() => taskEffectProposalV1Schema.parse(inlineCommit))
      .toThrow(/\/files is materialized from the trusted repository capture/);
    expect(() => taskEffectProposalV1Schema.parse({
      ...deferredCommit,
      references: { "/files/0/contentBase64": { step: "earlier", output: "commentUrl" } },
    })).toThrow(/may not be referenced/);
  });

  it("still refuses a payload that is malformed for reasons other than the capture", () => {
    expect(() => taskEffectProposalV1Schema.parse({ ...deferredCommit, payload: { branch: "gardener/x" } }))
      .toThrow(/expectedHeadSha/);
    // Omission is not permission to supply a plan-owned field.
    expect(() => taskEffectProposalV1Schema.parse({
      ...deferredCommit,
      payload: { ...deferredCommit.payload, repository: { id: "1" } },
    })).toThrow(/repository/);
  });

  it("fails the plan when a deferred commit has no admitted capture", async () => {
    const request = await runRequest();
    await expect(buildTaskEffectPlan({ request, outcome: outcome(request, [deferredCommit]) }))
      .rejects.toThrow(/admitted no capture/);
  });

  it("plans a deferred commit once a capture is admitted", async () => {
    const request = await runRequest();
    const plan = await buildTaskEffectPlan({ request, outcome: outcome(request, [deferredCommit]), capture });
    expect(plan.capture).toEqual(capture.manifest);
    expect(plan.changesSha256).toBe(capture.changesSha256);
    expect(plan.operations[0]?.payload).toEqual(deferredCommit.payload);
  });

  it("never plans a commit the model supplied bytes for, capture or not", async () => {
    // Both directions: an inlined file set is refused whether or not a real
    // capture is present, so it can neither bypass the capture nor be laundered
    // through one.
    const request = await runRequest();
    await expect(buildTaskEffectPlan({ request, outcome: outcome(request, [inlineCommit]) }))
      .rejects.toThrow(/may not be supplied by the task/);
    await expect(buildTaskEffectPlan({ request, outcome: outcome(request, [inlineCommit]), capture }))
      .rejects.toThrow(/may not be supplied by the task/);
  });

  it("always treats a commit as capture-dependent", async () => {
    // Deferral is a property of the kind. A commit can never be planned
    // without a capture behind it, so there is no payload shape that makes
    // one capture-free.
    const request = await runRequest();
    await expect(buildTaskEffectPlan({ request, outcome: outcome(request, [deferredCommit]) }))
      .rejects.toThrow(/admitted no capture/);
  });

  it("refuses a capture no step materializes", async () => {
    const request = await runRequest();
    await expect(buildTaskEffectPlan({ request, outcome: outcome(request, [comment]), capture }))
      .rejects.toThrow(/no proposed step materializes/);
  });

  it("refuses a capture taken against a different commit than the run planned", async () => {
    const request = await runRequest();
    await expect(buildTaskEffectPlan({
      request,
      outcome: outcome(request, [deferredCommit]),
      capture: { ...capture, manifest: { ...capture.manifest, baseSha: "a".repeat(40) } },
    })).rejects.toThrow(/capture base must equal the planning commit/);
  });
});

describe("plan limits", () => {
  it("fails planning when the task's own operation ceiling is exceeded", async () => {
    const request = await runRequest({ maxEffectOperations: 1 });
    await expect(buildTaskEffectPlan({ request, outcome: outcome(request, [branch, comment]) }))
      .rejects.toThrow(/allows at most 1/);
    expect((await buildTaskEffectPlan({ request, outcome: outcome(request, [comment]) })).limits)
      .toEqual({ maxEffectOperations: 1 });
  });

  it("fails planning when the task's own byte ceiling is exceeded", async () => {
    const request = await runRequest({ maxEffectBytes: 1_024 });
    await expect(buildTaskEffectPlan({
      request,
      outcome: outcome(request, [{ ...comment, payload: { ...comment.payload, body: "x".repeat(2_048) } }]),
    })).rejects.toThrow(/allows at most 1024/);
  });

  it("imposes no ceiling of its own when the task declares none", async () => {
    const request = await runRequest();
    const many = Array.from({ length: 40 }, (_, index) => ({
      ...comment,
      stepName: `comment-${index}`,
      payload: { ...comment.payload, body: `Note ${index}.` },
    }));
    const plan = await buildTaskEffectPlan({ request, outcome: outcome(request, many) });
    expect(plan.operations).toHaveLength(40);
    expect(plan.limits).toEqual({});
  });
});

describe("receipt admission", () => {
  async function planAndReceipt(steps: readonly unknown[]): Promise<{
    plan: Awaited<ReturnType<typeof buildTaskEffectPlan>>;
    receipt: RunnerEffectReceiptV1;
  }> {
    const request = await runRequest();
    const plan = await buildTaskEffectPlan({ request, outcome: outcome(request, steps) });
    const receipt: RunnerEffectReceiptV1 = {
      schemaVersion: "gardener.runner.effect-receipt/v1",
      planRunId: request.runId,
      bundleHash: plan.bundleHash,
      artifactSha256: "a".repeat(64),
      plannedOperations: plan.operations.length,
      status: "applied",
      stoppedAtStep: null,
      operations: plan.operations.map((operation) => ({
        stepName: operation.stepName,
        outputs: operation.kind === "branch.create"
          ? {
              branch: "gardener/fix-1",
              ref: "refs/heads/gardener/fix-1",
              commitSha: "b".repeat(40),
              branchUrl: "https://github.com/scuffi/demo/tree/gardener/fix-1",
            }
          : {
              issueNumber: 1,
              commentId: "99",
              commentUrl: "https://github.com/scuffi/demo/issues/1#issuecomment-99",
            },
        receipt: {
          schemaVersion: "v2",
          operationId: operation.operationId,
          operationHash: "9".repeat(64),
          kind: operation.kind,
          status: "succeeded",
          attempt: 1,
          attemptedAt: "2026-09-17T12:01:00.000Z",
          completedAt: "2026-09-17T12:01:01.000Z",
        },
      })),
    };
    return { plan, receipt };
  }

  it("admits a receipt that answers the exact plan", async () => {
    const { plan, receipt } = await planAndReceipt([branch, comment]);
    expect(() => assertReceiptMatchesPlan(plan, receipt)).not.toThrow();
  });

  it("admits a stopped prefix but refuses a reordered or renamed one", async () => {
    const { plan, receipt } = await planAndReceipt([branch, comment]);
    const stopped: RunnerEffectReceiptV1 = {
      ...receipt,
      status: "stopped",
      stoppedAtStep: "branch",
      operations: [{
        stepName: "branch",
        outputs: {},
        receipt: {
          ...receipt.operations[0]!.receipt,
          status: "failed",
          error: { code: "conflict", message: "branch exists", retryable: false },
        },
      }],
    };
    expect(() => assertReceiptMatchesPlan(plan, stopped)).not.toThrow();

    expect(() => assertReceiptMatchesPlan(plan, {
      ...receipt,
      operations: [receipt.operations[1]!, receipt.operations[0]!],
    })).toThrow(/step 1 is comment but the plan ordered branch/);
  });

  it("refuses a mismatched planned count, bundle, or operation id", async () => {
    const { plan, receipt } = await planAndReceipt([comment]);
    expect(() => assertReceiptMatchesPlan(plan, { ...receipt, plannedOperations: 2 }))
      .toThrow(/reports 2 planned operations but the plan ordered 1/);
    expect(() => assertReceiptMatchesPlan(plan, { ...receipt, bundleHash: "0".repeat(64) }))
      .toThrow(/bundle hash/);
    expect(() => assertReceiptMatchesPlan(plan, { ...receipt, changesSha256: "1".repeat(64) }))
      .toThrow(/changes digest/);
    expect(() => assertReceiptMatchesPlan(plan, {
      ...receipt,
      operations: [{
        stepName: "comment",
        outputs: {},
        receipt: { ...receipt.operations[0]!.receipt, operationId: "op_forged" },
      }],
    })).toThrow(/operation ID the plan did not derive/);
  });
});
