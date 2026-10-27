import { canonicalSha256 } from "@gardener/core";
import { describe, expect, it } from "vitest";
import {
  taskEffectPlanV1Schema,
  taskEffectProposalV1Schema,
  taskStepIssues,
  type NormalizedEventV1,
  type TaskBundleV1,
  type TaskEffectProposalV1,
  type TaskRunRequestV1,
  type TaskRunStarterV1,
} from "@gardener/contracts";
import { runnerEffectReceiptV1Schema, type RunnerEffectReceiptV1, type RunnerTaskRunReceiptV1 } from "@gardener/protocol";
import {
  assertMonotonicReceipt,
  assertReceiptMatchesPlan,
  assertTaskRunTransition,
  buildTaskEffectPlan,
  type CompletedTaskOutcomeV1,
} from "../src/task-runtime/effect-plan";
import { proposalAuthorityRefusal, taskRunProposalRefusal, taskRunTargetRefusal } from "../src/task-runtime/proposal-authority";
import { inspectRepositoryFixtureBundle } from "./fixture-bundle";

const COMMIT = "b".repeat(40);
const NOW = "2026-10-27T12:00:00.000Z";
const CURRENT_PIN = `scuffi/gardener/.github/workflows/gardener-task.yml@${"c".repeat(40)}`;
/** 0.1.19's task workflow (also 0.1.20's): carries messages, but its apply cannot parse `taskRuns`. */
const PIN_0_1_19 = "scuffi/gardener/.github/workflows/gardener-task.yml@0d02b66f47cc8802ba14a243dd827bf5555b3469";
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
      workflowRef: "scuffi/demo/.github/workflows/gardener-triage.yml@refs/heads/main",
      jobWorkflowRef, runnerEnvironment: "github-hosted",
    },
    actor: { id: "2", login: "outsider" },
    issue: {
      id: "999", number: 7, title: "Bug", body: "Broken", state: "open", updatedAt: NOW,
      labels: [], author: { id: "2", login: "outsider" }, authorAssociation: "NONE",
    },
  };
}

async function runRequest(options: {
  jobWorkflowRef?: string;
  lineage?: TaskRunRequestV1["lineage"];
  effects?: TaskBundleV1["effects"];
} = {}): Promise<TaskRunRequestV1> {
  const bundle = structuredClone(inspectRepositoryFixtureBundle()) as TaskBundleV1;
  bundle.taskId = "triage";
  bundle.effects = options.effects ?? ["issue.comment.create", "issue.label.add", "pull_request.open", "task.run"];
  bundle.effectOptions = { "task.run": { tasks: ["fix", "fix-ready"] } };
  bundle.triggers = [{ kind: "github.issue.opened", labelsAll: [], mentions: [], authors: "any" }, { kind: "github.workflow_dispatch" }];
  return {
    schemaVersion: "gardener.task-run-request/v1",
    runId: "run:triage:1",
    bundle,
    bundleHash: await canonicalSha256(bundle),
    sourcePath: ".gardener/tasks/triage/TASK.md",
    policySnapshotHash: "d".repeat(64),
    event: issueEvent(options.jobWorkflowRef ?? CURRENT_PIN),
    model: { id: "@cf/test/model" },
    admittedAt: NOW,
    deadlineAt: "2026-10-27T12:05:00.000Z",
    starter: OUTSIDER,
    ...(options.lineage === undefined ? {} : { lineage: options.lineage }),
  };
}

const start = (payload: Record<string, unknown>, references: Record<string, unknown> = {}, stepName = "start-fix"): TaskEffectProposalV1 =>
  taskEffectProposalV1Schema.parse({ stepName, kind: "task.run", payload, references, rationale: "High impact, low cost." });
const label = (stepName = "label"): TaskEffectProposalV1 => taskEffectProposalV1Schema.parse({
  stepName,
  kind: "issue.label.add",
  payload: { issueNumber: 7, expectedIssueState: "open", expectedIssueUpdatedAt: NOW, label: "bug" },
  rationale: "Bug.",
});
const openPr = (stepName = "open-pr"): TaskEffectProposalV1 => taskEffectProposalV1Schema.parse({
  stepName,
  kind: "pull_request.open",
  payload: { head: "gardener/issue-7", base: "main", expectedHeadSha: COMMIT, expectedBaseSha: COMMIT, title: "Fix #7", body: "Fixes #7." },
  rationale: "Open it.",
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

describe("task.run proposals", () => {
  it("is a strict payload with exactly one subject and no free text", () => {
    expect(() => start({ task: "fix", issueNumber: 7, prompt: "do something else" })).toThrow();
    expect(() => start({ task: "fix", issueNumber: 7, inputs: { issue: "7" } })).toThrow();
    expect(() => start({ task: "fix", issueNumber: 7, ref: "main" })).toThrow();
    expect(() => start({ task: "fix" })).toThrow(/exactly one subject/);
    expect(() => start({ task: "fix", issueNumber: 7, pullNumber: 7 })).toThrow(/exactly one subject/);
    expect(() => start({ task: "fix", issueNumber: 7 }, { "/pullNumber": { step: "open-pr", output: "pullNumber" } })).toThrow(/exactly one subject/);
    expect(() => start({ task: "fix" }, { "/task": { step: "open-pr", output: "pullNumber" } })).toThrow(/only a \/pullNumber reference/);
    expect(() => start({ task: "fix" }, { "/pullNumber": { step: "open-pr", output: "headSha" } })).toThrow(/pullNumber output/);
  });

  it("admits a declared target on the run's own issue", async () => {
    const request = await runRequest();
    expect(proposalAuthorityRefusal(request, start({ task: "fix", issueNumber: 7 }), [label()])).toBeUndefined();
  });

  it("refuses an undeclared target and the task itself", async () => {
    const request = await runRequest();
    expect(proposalAuthorityRefusal(request, start({ task: "deploy", issueNumber: 7 }), [])).toBe(
      "Task did not declare deploy under task.run; it may start fix, fix-ready",
    );
    expect(proposalAuthorityRefusal(request, start({ task: "triage", issueNumber: 7 }), [])).toBe("task.run may not start task triage itself");
  });

  it("refuses another issue, a pull request that is not the run's, and the run's number as the wrong kind", async () => {
    const request = await runRequest();
    expect(proposalAuthorityRefusal(request, start({ task: "fix", issueNumber: 8 }), [])).toMatch(/only on issue #7/);
    expect(proposalAuthorityRefusal(request, start({ task: "fix", pullNumber: 12 }), [])).toMatch(/only on issue #7/);
    expect(proposalAuthorityRefusal(request, start({ task: "fix", pullNumber: 7 }), [])).toMatch(/only on issue #7/);
  });

  it("accepts a pull request this plan opens, by reference, and refuses one from another step or none", async () => {
    const request = await runRequest();
    const fromOpen = start({ task: "fix-ready" }, { "/pullNumber": { step: "open-pr", output: "pullNumber" } });
    expect(proposalAuthorityRefusal(request, fromOpen, [openPr()])).toBeUndefined();
    // The same reference with no such earlier step, or naming a step that opened nothing.
    expect(proposalAuthorityRefusal(request, fromOpen, [label()])).toMatch(/not one/);
    const fromLabel = start({ task: "fix-ready" }, { "/pullNumber": { step: "label", output: "pullNumber" } });
    expect(proposalAuthorityRefusal(request, fromLabel, [label()])).toMatch(/not one/);
    expect(taskStepIssues(fromLabel, { earlier: new Map([["label", "issue.label.add"]]) })).toHaveLength(1);
    expect(taskStepIssues(fromOpen, { earlier: new Map([["open-pr", "pull_request.open"]]) })).toHaveLength(0);
  });

  it("allows at most one per run, and nothing after it", async () => {
    const request = await runRequest();
    const first = start({ task: "fix", issueNumber: 7 });
    expect(proposalAuthorityRefusal(request, start({ task: "fix-ready", issueNumber: 7 }, {}, "again"), [first]))
      .toMatch(/task.run must be the last step/);
    // The rule of its own, should the ordering rule ever move.
    expect(taskRunProposalRefusal(request, start({ task: "fix-ready", issueNumber: 7 }, {}, "again"), [first]))
      .toBe("A run starts at most one task, and step start-fix already starts one");
    expect(proposalAuthorityRefusal(request, label("late"), [first])).toBe(
      "task.run must be the last step, and step start-fix already starts a task; add issue.label.add before it",
    );
  });

  it("refuses at the depth limit, and allows one level short of it", async () => {
    expect(proposalAuthorityRefusal(await runRequest({ lineage: { parentRunId: "run:0", depth: 3, rootAuthorId: "2" } }), start({ task: "fix", issueNumber: 7 }), []))
      .toMatch(/at most 3 deep/);
    expect(proposalAuthorityRefusal(await runRequest({ lineage: { parentRunId: "run:0", depth: 2, rootAuthorId: "2" } }), start({ task: "fix", issueNumber: 7 }), []))
      .toBeUndefined();
  });

  it("refuses on a pin whose apply predates task.run, with upgrade advice", async () => {
    const refusal = proposalAuthorityRefusal(await runRequest({ jobWorkflowRef: PIN_0_1_19 }), start({ task: "fix", issueNumber: 7 }), []);
    expect(refusal).toMatch(/^task\.run is not supported by this run's task workflow \(release 0d02b66f47cc\)/);
    expect(refusal).toContain("gardener upgrade --workspace <name>");
  });
});

describe("task.run targets", () => {
  const target = (triggers: TaskBundleV1["triggers"]) => ({ ...inspectRepositoryFixtureBundle(), taskId: "fix", triggers });
  it("must be an enabled task of the repository whose workflow takes the subject", () => {
    expect(taskRunTargetRefusal("fix", undefined, "issue")).toMatch(/not an enabled task of this repository/);
    expect(taskRunTargetRefusal("fix", { ...target([{ kind: "github.workflow_dispatch" }]), taskId: "other" }, "issue")).toMatch(/not an enabled task/);
    expect(taskRunTargetRefusal("fix", target([{ kind: "github.workflow_dispatch" }]), "issue")).toMatch(/takes no issue input/);
    expect(taskRunTargetRefusal("fix", target([{ kind: "github.issue.labeled", labelsAll: ["gardener-fix"] }, { kind: "github.workflow_dispatch" }]), "issue"))
      .toBeUndefined();
    expect(taskRunTargetRefusal("fix", target([{ kind: "github.issue.labeled", labelsAll: ["gardener-fix"] }, { kind: "github.workflow_dispatch" }]), "pull_request"))
      .toMatch(/takes no pull_request input/);
    // A manual-only task offers the input its dispatch trigger names.
    expect(taskRunTargetRefusal("fix", target([{ kind: "github.workflow_dispatch", subject: "pull_request" }]), "pull_request")).toBeUndefined();
  });
});

describe("task.run plans", () => {
  it("carry the resolved workflow path and the subject, last, never as an operation", async () => {
    const request = await runRequest();
    const plan = await buildTaskEffectPlan({ request, outcome: outcome(request, [label(), start({ task: "fix", issueNumber: 7 })]) });
    expect(plan.operations.map((operation) => operation.kind)).toEqual(["issue.label.add"]);
    expect(plan.taskRuns).toEqual([{ task: "fix", workflowPath: ".github/workflows/gardener-fix.yml", subject: { kind: "issue", issueNumber: 7 } }]);
    const opened = await buildTaskEffectPlan({
      request,
      outcome: outcome(request, [openPr(), start({ task: "fix-ready" }, { "/pullNumber": { step: "open-pr", output: "pullNumber" } })]),
    });
    expect(opened.taskRuns?.[0]?.subject).toEqual({ kind: "pull_request", openedBy: "open-pr" });
    // Plans without one hash as before.
    expect("taskRuns" in await buildTaskEffectPlan({ request, outcome: outcome(request, [label()]) })).toBe(false);
  });

  it("refuse a task run that is not last, one more than once, and one on an older pin", async () => {
    const request = await runRequest();
    await expect(buildTaskEffectPlan({ request, outcome: outcome(request, [start({ task: "fix", issueNumber: 7 }), label()]) }))
      .rejects.toThrow(/must be the last step/);
    const old = await runRequest({ jobWorkflowRef: PIN_0_1_19 });
    await expect(buildTaskEffectPlan({ request: old, outcome: outcome(old, [start({ task: "fix", issueNumber: 7 })]) }))
      .rejects.toThrow(/not supported by this run's task workflow/);
    const undeclared = await runRequest({ effects: ["issue.label.add"] });
    await expect(buildTaskEffectPlan({ request: undeclared, outcome: outcome(undeclared, [start({ task: "fix", issueNumber: 7 })]) }))
      .rejects.toThrow(/undeclared effect task.run/);
  });

  it("are refused at apply when the path, subject or target does not hold", async () => {
    const request = await runRequest();
    const plan = await buildTaskEffectPlan({ request, outcome: outcome(request, [label(), start({ task: "fix", issueNumber: 7 })]) });
    const withRun = (run: unknown) => taskEffectPlanV1Schema.safeParse({ ...plan, taskRuns: [run] });
    expect(withRun({ ...plan.taskRuns![0], workflowPath: ".github/workflows/gardener-deploy.yml" }).success).toBe(false);
    expect(withRun({ ...plan.taskRuns![0], workflowPath: ".github/workflows/release.yml" }).success).toBe(false);
    expect(withRun({ ...plan.taskRuns![0], subject: { kind: "issue", issueNumber: 8 } }).success).toBe(false);
    expect(withRun({ ...plan.taskRuns![0], subject: { kind: "pull_request", openedBy: "label" } }).success).toBe(false);
    expect(withRun({ task: "triage", workflowPath: ".github/workflows/gardener-triage.yml", subject: { kind: "issue", issueNumber: 7 } }).success).toBe(false);
    expect(withRun({ ...plan.taskRuns![0], inputs: { prompt: "x" } }).success).toBe(false);
    expect(withRun(plan.taskRuns![0]).success).toBe(true);
  });
});

describe("task.run receipts at the runtime", () => {
  const run = (status: RunnerTaskRunReceiptV1["status"], overrides: Partial<RunnerTaskRunReceiptV1> = {}): RunnerTaskRunReceiptV1 => ({
    task: "fix",
    subject: { kind: "issue", number: 7 },
    status,
    ...(status === "dispatch_unknown" ? { reason: "dispatch_failed" as const } : {}),
    attemptedAt: NOW,
    ...overrides,
  });

  it("move once, from dispatching to dispatched or dispatch_unknown, and never back to a dispatch", () => {
    expect(() => assertTaskRunTransition(undefined, run("dispatching"))).not.toThrow();
    expect(() => assertTaskRunTransition(undefined, run("dispatched"))).toThrow("A task run is recorded as dispatching before it is dispatched");
    expect(() => assertTaskRunTransition(undefined, run("dispatch_unknown"))).toThrow(/recorded as dispatching/);
    expect(() => assertTaskRunTransition(run("dispatching"), run("dispatched"))).not.toThrow();
    expect(() => assertTaskRunTransition(run("dispatching"), run("dispatch_unknown", { reason: "interrupted" }))).not.toThrow();
    expect(() => assertTaskRunTransition(run("dispatching"), run("dispatching", { attemptedAt: "2026-10-27T12:01:00.000Z" })))
      .toThrow("A dispatching task run settles only as dispatched or dispatch_unknown");
    for (const settled of [run("dispatched"), run("dispatch_unknown")]) {
      expect(() => assertTaskRunTransition(settled, run("dispatching"))).toThrow(/never dispatched again/);
      expect(() => assertTaskRunTransition(settled, run("dispatched", { attemptedAt: "2026-10-27T12:02:00.000Z" }))).toThrow(/never dispatched again/);
    }
    expect(() => assertTaskRunTransition(run("dispatching"), undefined)).toThrow("Effect receipt dropped its task run");
    expect(() => assertTaskRunTransition(run("dispatching"), run("dispatched", { task: "fix-ready" }))).toThrow(/task or subject/);
    expect(() => assertTaskRunTransition(run("dispatching"), run("dispatched", { subject: { kind: "issue", number: 8 } }))).toThrow(/task or subject/);
  });

  it("answer the plan's own task run, resolving a pull request the plan opened from its step's output", async () => {
    const request = await runRequest();
    const plan = await buildTaskEffectPlan({
      request,
      outcome: outcome(request, [openPr(), start({ task: "fix-ready" }, { "/pullNumber": { step: "open-pr", output: "pullNumber" } })]),
    });
    const receipt = (number: number, task = "fix-ready"): RunnerEffectReceiptV1 => runnerEffectReceiptV1Schema.parse({
      schemaVersion: "gardener.runner.effect-receipt/v1",
      planRunId: plan.runId,
      bundleHash: plan.bundleHash,
      artifactSha256: "e".repeat(64),
      plannedOperations: 1,
      status: "applied",
      stoppedAtStep: null,
      operations: [{
        stepName: "open-pr",
        receipt: {
          schemaVersion: "v2", operationId: plan.operations[0]!.operationId, operationHash: "a".repeat(64),
          kind: "pull_request.open", status: "succeeded", attempt: 1, attemptedAt: NOW, completedAt: NOW,
        },
        outputs: { pullNumber: 12, pullUrl: "https://github.com/scuffi/demo/pull/12", headSha: COMMIT, labelsApplied: false },
      }],
      taskRuns: [{ task, subject: { kind: "pull_request", number }, status: "dispatching", attemptedAt: NOW }],
    });
    // Valid outputs or not, the subject must be what the step opened.
    const matches = (value: RunnerEffectReceiptV1) => {
      try {
        assertReceiptMatchesPlan(plan, value);
        return "ok";
      } catch (error) {
        return (error as Error).message;
      }
    };
    expect(matches(receipt(13))).toBe("Effect receipt records a task run for another task or subject than the plan's");
    expect(matches(receipt(12, "fix"))).toBe("Effect receipt records a task run for another task or subject than the plan's");
    expect(matches(receipt(12))).not.toMatch(/task run/);
  });

  it("let an applied receipt record its task run beside a settled message, but never re-dispatch", () => {
    const base = runnerEffectReceiptV1Schema.parse({
      schemaVersion: "gardener.runner.effect-receipt/v1",
      planRunId: "run:triage:1",
      bundleHash: "f".repeat(64),
      artifactSha256: "e".repeat(64),
      plannedOperations: 0,
      status: "applied",
      stoppedAtStep: null,
      operations: [],
      messages: [{ channel: "default", subject: { kind: "issue", number: 7 }, status: "skipped", reason: "destination_unset", attemptedAt: NOW }],
    });
    const withRun = (taskRun: RunnerTaskRunReceiptV1) => runnerEffectReceiptV1Schema.parse({ ...base, taskRuns: [taskRun] });
    expect(() => assertMonotonicReceipt(base, withRun(run("dispatching")))).not.toThrow();
    expect(() => assertMonotonicReceipt(withRun(run("dispatching")), withRun(run("dispatched")))).not.toThrow();
    expect(() => assertMonotonicReceipt(base, withRun(run("dispatched")))).toThrow(/recorded as dispatching/);
    expect(() => assertMonotonicReceipt(withRun(run("dispatched")), withRun(run("dispatching")))).toThrow(/never dispatched again/);
  });
});
