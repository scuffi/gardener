import { canonicalSha256 } from "@gardener/core";
import { describe, expect, it } from "vitest";
import {
  taskEffectProposalV1Schema,
  type NormalizedEventV1,
  type TaskBundleV1,
  type TaskEffectProposalV1,
  type TaskRunRequestV1,
  type TaskRunStarterV1,
} from "@gardener/contracts";
import { runnerEffectReceiptV1Schema, type RunnerEffectReceiptV1 } from "@gardener/protocol";
import {
  admitProposal,
  assertMonotonicReceipt,
  assertProposalFitsLedger,
  assertReceiptMatchesPlan,
  buildTaskEffectPlan,
  type CompletedTaskOutcomeV1,
  type ProposalLedgerStorage,
} from "../src/task-runtime/effect-plan";
import { createTaskHarnessRequest } from "../src/task-runtime/harness-adapter";
import { proposalAuthorityRefusal } from "../src/task-runtime/proposal-authority";
import { inspectRepositoryFixtureBundle } from "./fixture-bundle";

const COMMIT = "b".repeat(40);
const NOW = "2026-10-21T12:00:00.000Z";
const CURRENT_PIN = `scuffi/gardener/.github/workflows/gardener-task.yml@${"c".repeat(40)}`;
/** 0.1.17's task workflow: carries effectScope, but its apply cannot parse `messages`. */
const PIN_0_1_17 = "scuffi/gardener/.github/workflows/gardener-task.yml@5c9c136ffd6b2e545f398dc413a60e04b66da406";
const TRUSTED: TaskRunStarterV1 = { trusted: true, reason: "maintainer_author" };
const OUTSIDER: TaskRunStarterV1 = { trusted: false, reason: "author_not_maintainer" };

function issueEvent(jobWorkflowRef: string): NormalizedEventV1 {
  return {
    schemaVersion: "gardener.normalized-event/v1",
    eventId: "event:1",
    occurredAt: NOW,
    kind: "github.issue.opened",
    repository: {
      id: "1374842705", ownerId: "45369682", owner: "scuffi", name: "demo", fullName: "scuffi/demo",
      visibility: "public", commitSha: COMMIT, ref: "refs/heads/main", defaultBranch: "main",
    },
    workflow: {
      runId: "35256179260", runAttempt: 1, eventName: "issues",
      workflowRef: "scuffi/demo/.github/workflows/gardener.yml@refs/heads/main",
      jobWorkflowRef, runnerEnvironment: "github-hosted",
    },
    actor: { id: "2", login: "outsider" },
    issue: {
      id: "999", number: 1, title: "Bug", body: "Broken", state: "open", updatedAt: NOW,
      labels: [], author: { id: "2", login: "outsider" }, authorAssociation: "NONE",
    },
  };
}

async function runRequest(options: {
  starter?: TaskRunStarterV1;
  effects?: TaskBundleV1["effects"];
  jobWorkflowRef?: string;
} = {}): Promise<TaskRunRequestV1> {
  const bundle = structuredClone(inspectRepositoryFixtureBundle()) as TaskBundleV1;
  bundle.effects = options.effects ?? ["issue.comment.create", "message.send"];
  bundle.triggers = [{ kind: "github.issue.opened", labelsAll: [], mentions: [], authors: "any" }, { kind: "github.workflow_dispatch" }];
  return {
    schemaVersion: "gardener.task-run-request/v1",
    runId: "run:messages:1",
    bundle,
    bundleHash: await canonicalSha256(bundle),
    sourcePath: ".gardener/tasks/triage/TASK.md",
    policySnapshotHash: "d".repeat(64),
    event: issueEvent(options.jobWorkflowRef ?? CURRENT_PIN),
    model: { id: "@cf/test/model" },
    admittedAt: NOW,
    deadlineAt: "2026-10-21T12:05:00.000Z",
    starter: options.starter ?? TRUSTED,
  };
}

const notify = (number = 1, stepName = "notify", kind = "issue"): TaskEffectProposalV1 => taskEffectProposalV1Schema.parse({
  stepName,
  kind: "message.send",
  payload: { subject: { kind, number, expectedUpdatedAt: NOW }, summary: "Crash on start for every user." },
  rationale: "High priority.",
});
const comment = (stepName = "comment"): TaskEffectProposalV1 => taskEffectProposalV1Schema.parse({
  stepName,
  kind: "issue.comment.create",
  payload: { issueNumber: 1, expectedIssueState: "open", expectedIssueUpdatedAt: NOW, body: "Thanks." },
  rationale: "Reply.",
});

function outcome(request: TaskRunRequestV1, proposedEffects: readonly TaskEffectProposalV1[]): CompletedTaskOutcomeV1 {
  return {
    schemaVersion: "gardener.task-outcome/v1",
    runId: request.runId,
    taskId: request.bundle.taskId,
    bundleHash: request.bundleHash,
    status: "completed",
    summary: "Done.",
    observations: [],
    proposedEffects: [...proposedEffects],
  };
}

function memoryStorage(): ProposalLedgerStorage {
  const values = new Map<string, unknown>();
  return {
    get: async <T>(key: string) => values.get(key) as T | undefined,
    put: async <T>(key: string, value: T) => { values.set(key, value); },
    list: async <T>(options: { prefix: string }) => new Map([...values].filter(([key]) => key.startsWith(options.prefix))) as Map<string, T>,
  };
}

describe("message.send proposals", () => {
  it("are refused unless the task declares message.send", async () => {
    const request = await runRequest({ effects: ["issue.comment.create"] });
    expect(proposalAuthorityRefusal(request, notify(), [])).toBe("Task did not declare the message.send effect");
    expect(proposalAuthorityRefusal(await runRequest(), notify(), [])).toBeUndefined();
  });

  it("are refused after the first in a run", async () => {
    const request = await runRequest();
    expect(proposalAuthorityRefusal(request, notify(1, "again"), [comment(), notify()]))
      .toBe("A run sends at most one message, and step notify already sends one");
    // Refusals reach the model as tool results, so they must not use proposal voice either.
    expect(proposalAuthorityRefusal(request, notify(1, "again"), [comment(), notify()])).not.toMatch(/\bpropos/i);
    expect(proposalAuthorityRefusal(request, comment("later"), [notify()])).toBeUndefined();
  });

  it("are confined to the trigger for an untrusted starter, and not otherwise", async () => {
    const outsider = await runRequest({ starter: OUTSIDER });
    expect(proposalAuthorityRefusal(outsider, notify(1), [])).toBeUndefined();
    expect(proposalAuthorityRefusal(outsider, notify(2), []))
      .toBe("message.send may be only about issue #1, which triggered this run: this run is confined to what triggered it (confined because the author who started it is not a maintainer)");
    expect(proposalAuthorityRefusal(outsider, notify(1, "notify", "discussion"), [])).toMatch(/may be only about issue #1/);
    expect(proposalAuthorityRefusal(await runRequest({ starter: TRUSTED }), notify(2), [])).toBeUndefined();
  });

  it("are refused, with upgrade advice, for a task workflow whose apply predates messages", async () => {
    const request = await runRequest({ jobWorkflowRef: PIN_0_1_17 });
    expect(proposalAuthorityRefusal(request, notify(), [])).toBe(
      "message.send is not supported by this run's task workflow (release 5c9c136ffd6b), whose apply step predates it. "
        + "Run gardener upgrade --workspace <name> with the current Gardener CLI to move the repository to a release that supports it, then rerun.",
    );
    // Operations on the same pin are unaffected.
    expect(proposalAuthorityRefusal(request, comment(), [])).toBeUndefined();
  });

  it("can't be referenced by a later step: a message publishes nothing", async () => {
    const storage = memoryStorage();
    const message = notify();
    await admitProposal(storage, { proposal: message, digest: "d1", maxToolCalls: 10, recordedToolCalls: async () => 0 });
    const referencing = taskEffectProposalV1Schema.parse({
      ...comment("after"),
      payload: { expectedIssueState: "open", expectedIssueUpdatedAt: NOW, body: "Thanks." },
      references: { "/issueNumber": { step: "notify", output: "issueNumber" } },
    });
    await expect(assertProposalFitsLedger(storage, referencing)).rejects.toThrow(/unknown step "notify"/);
    await expect(assertProposalFitsLedger(storage, comment("after"))).resolves.toBeUndefined();
  });
});

describe("messages in the built plan", () => {
  it("go to messages, never to operations, and are absent when none was proposed", async () => {
    const request = await runRequest();
    const plan = await buildTaskEffectPlan({ request, outcome: outcome(request, [comment(), notify()]) });
    expect(plan.operations.map((operation) => operation.kind)).toEqual(["issue.comment.create"]);
    expect(plan.messages).toEqual([{
      channel: "default",
      subject: { kind: "issue", issueNumber: 1, expectedIssueUpdatedAt: NOW },
      summary: "Crash on start for every user.",
    }]);
    const without = await buildTaskEffectPlan({ request, outcome: outcome(request, [comment()]) });
    expect(without).not.toHaveProperty("messages");
    // The operation's id doesn't depend on whether a message came first or not at all.
    const after = await buildTaskEffectPlan({ request, outcome: outcome(request, [comment(), notify()]) });
    expect(after.operations[0]!.operationId).toBe(without.operations[0]!.operationId);
  });

  it("build a plan whose only effect is a message", async () => {
    const request = await runRequest({ effects: ["message.send"] });
    const plan = await buildTaskEffectPlan({ request, outcome: outcome(request, [notify()]) });
    expect(plan.operations).toEqual([]);
    expect(plan.messages).toHaveLength(1);
  });

  it("re-check declaration, the one-message rule, scope and the pin", async () => {
    const undeclared = await runRequest({ effects: ["issue.comment.create"] });
    await expect(buildTaskEffectPlan({ request: undeclared, outcome: outcome(undeclared, [notify()]) }))
      .rejects.toThrow("A step uses the undeclared effect message.send");
    const request = await runRequest();
    await expect(buildTaskEffectPlan({ request, outcome: outcome(request, [notify(), notify(1, "again")]) }))
      .rejects.toThrow(/at most one message/);
    const outsider = await runRequest({ starter: OUTSIDER });
    await expect(buildTaskEffectPlan({ request: outsider, outcome: outcome(outsider, [notify(2)]) }))
      .rejects.toThrow(/may be only about issue #1/);
    const old = await runRequest({ jobWorkflowRef: PIN_0_1_17 });
    await expect(buildTaskEffectPlan({ request: old, outcome: outcome(old, [notify()]) }))
      .rejects.toThrow(/apply step predates it/);
  });
});

describe("message.send in the prompt", () => {
  it("states its payload schema and rules, and lists no outputs for it", async () => {
    const prompt = (await createTaskHarnessRequest(await runRequest())).prompt;
    expect(prompt).toContain("  message.send: {");
    expect(prompt).toMatch(/message\.send: \{.*"expectedUpdatedAt".*provider\.api\.read/);
    expect(prompt).toContain("message.send posts one short message");
    expect(prompt).not.toMatch(/^ {2}message\.send: [a-z]/m);
  });

  it("says the step limit counts only repository changes, and the message comes in addition", async () => {
    const limited = async (effects: TaskBundleV1["effects"]) => {
      const request = await runRequest({ effects });
      request.bundle.limits = { ...request.bundle.limits, maxEffectOperations: 1 };
      request.bundleHash = await canonicalSha256(request.bundle);
      return (await createTaskHarnessRequest(request)).prompt;
    };
    expect(await limited(["issue.comment.create", "message.send"]))
      .toContain("This task may add at most 1 steps that change the repository, and one message.send in addition.");
    const without = await limited(["issue.comment.create"]);
    expect(without).toContain("This task may add at most 1 steps.");
    expect(without).not.toContain("message.send in addition");
  });
});

describe("message receipts at the runtime", () => {
  const sent = { channel: "default", subject: { kind: "issue", number: 1 }, transport: "slack-webhook", status: "sent", attemptedAt: NOW };
  const failed = { ...sent, status: "failed", reason: "send_failed" };
  const skipped = { channel: "default", subject: { kind: "issue", number: 1 }, status: "skipped", reason: "destination_unset", attemptedAt: NOW };
  const conflicted = { ...sent, status: "conflicted", reason: "subject_changed" };
  const receipt = (messages?: unknown[]): RunnerEffectReceiptV1 => runnerEffectReceiptV1Schema.parse({
    schemaVersion: "gardener.runner.effect-receipt/v1",
    planRunId: "run:messages:1",
    bundleHash: "e".repeat(64),
    artifactSha256: "f".repeat(64),
    plannedOperations: 0,
    status: "applied",
    stoppedAtStep: null,
    operations: [],
    ...(messages === undefined ? {} : { messages }),
  });

  it("must answer the plan's own message", async () => {
    const request = await runRequest({ effects: ["message.send"] });
    const plan = await buildTaskEffectPlan({ request, outcome: outcome(request, [notify()]) });
    const bound = (value: RunnerEffectReceiptV1) => ({ ...value, bundleHash: plan.bundleHash });
    expect(() => assertReceiptMatchesPlan(plan, bound(receipt([sent])))).not.toThrow();
    expect(() => assertReceiptMatchesPlan(plan, bound(receipt([{ ...sent, subject: { kind: "issue", number: 2 } }]))))
      .toThrow("Effect receipt records a message for another channel or subject than the plan's");
    expect(() => assertReceiptMatchesPlan(plan, bound(receipt([{ ...sent, subject: { kind: "discussion", number: 1 } }])))).toThrow(/another channel or subject/);
    // Apply names an issue subject by its checked link, which may be a pull request's.
    expect(() => assertReceiptMatchesPlan(plan, bound(receipt([{ ...sent, subject: { kind: "pull_request", number: 1 } }])))).not.toThrow();
    const pullPlan = await buildTaskEffectPlan({ request, outcome: outcome(request, [notify(1, "notify", "pull_request")]) });
    expect(() => assertReceiptMatchesPlan(pullPlan, { ...receipt([sent]), bundleHash: pullPlan.bundleHash }))
      .toThrow(/another channel or subject/);
    const withoutMessage = await buildTaskEffectPlan({ request: await runRequest(), outcome: outcome(await runRequest(), [comment()]) });
    const oneStep = runnerEffectReceiptV1Schema.parse({
      ...receipt([sent]),
      bundleHash: withoutMessage.bundleHash,
      plannedOperations: 1,
      operations: [{
        stepName: "comment",
        receipt: {
          schemaVersion: "v2", operationId: withoutMessage.operations[0]!.operationId, operationHash: "a".repeat(64),
          kind: "issue.comment.create", status: "succeeded", attempt: 1, attemptedAt: NOW, completedAt: NOW,
        },
        outputs: { commentId: "1", commentUrl: "https://github.com/scuffi/demo/issues/1#issuecomment-1", issueNumber: 1 },
      }],
    });
    expect(() => assertReceiptMatchesPlan(withoutMessage, oneStep)).toThrow("Effect receipt records a message the plan does not send");
  });

  it("let an applied receipt settle its message once, and retry only a failed one", () => {
    const step = {
      stepName: "comment",
      receipt: {
        schemaVersion: "v2", operationId: "op_1", operationHash: "a".repeat(64),
        kind: "issue.comment.create", status: "succeeded", attempt: 1, attemptedAt: NOW, completedAt: NOW,
      },
    };
    const withStep = (messages?: unknown[]) => runnerEffectReceiptV1Schema.parse({
      ...receipt([sent]), plannedOperations: 1, operations: [step], messages,
    });
    expect(() => assertMonotonicReceipt(withStep(), withStep([sent]))).not.toThrow();
    expect(() => assertMonotonicReceipt(withStep([sent]), withStep())).toThrow("The effect receipt's message is already settled");
    expect(() => assertMonotonicReceipt(withStep([failed]), withStep())).toThrow("Effect receipt dropped its message");
    expect(() => assertMonotonicReceipt(withStep(), runnerEffectReceiptV1Schema.parse({
      ...withStep([sent]), operations: [{ ...step, receipt: { ...step.receipt, operationHash: "b".repeat(64) } }],
    }))).toThrow("An applied effect receipt is terminal");
    expect(() => assertMonotonicReceipt(receipt([failed]), receipt([sent]))).not.toThrow();
    expect(() => assertMonotonicReceipt(receipt([failed]), receipt([failed]))).not.toThrow();
    for (const settled of [sent, skipped, conflicted]) {
      expect(() => assertMonotonicReceipt(receipt([settled]), receipt([failed]))).toThrow("The effect receipt's message is already settled");
    }
  });
});
