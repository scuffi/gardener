import { beforeEach, describe, expect, it, vi } from "vitest";
import { taskEffectPlanV1Schema, type Operation, type TaskEffectPlanV1 } from "@gardener/contracts";
import { runnerEffectReceiptV1Schema, type RunnerEffectReceiptV1 } from "@gardener/protocol";
import { canonicalOperationHash, type GitHubEffectResult } from "../src/github-effects";
import { dispatchPlanTaskRun, taskRunDispatchRequest } from "../src/task-runs";

const core = vi.hoisted(() => ({ setOutput: vi.fn(), setFailed: vi.fn(), setSecret: vi.fn(), notice: vi.fn() }));
vi.mock("@actions/core", () => ({
  getInput: () => "",
  setOutput: core.setOutput,
  setFailed: core.setFailed,
  setSecret: core.setSecret,
  notice: core.notice,
  getIDToken: vi.fn(async () => "oidc-token"),
}));
vi.mock("capnweb", () => ({
  RpcTarget: class {},
  newWebSocketRpcSession: vi.fn(() => ({ authenticate: () => ({}), [Symbol.dispose]: vi.fn() })),
}));
delete process.env.GITHUB_STEP_SUMMARY;
const effects = await import("../src/effects-main");
await vi.waitFor(() => expect(core.setFailed).toHaveBeenCalled());

const PLANNED = "2026-10-27T10:00:00.000Z";
const ARTIFACT = "c".repeat(64);
const COMMIT = "b".repeat(40);

const openPr = {
  stepName: "open-pr",
  operationId: "op_open",
  kind: "pull_request.open",
  payload: { head: "gardener/issue-7", base: "main", expectedHeadSha: COMMIT, expectedBaseSha: COMMIT, title: "Fix #7", body: "Fixes #7." },
  references: {},
  rationale: "Open it.",
} as TaskEffectPlanV1["operations"][number];

function plan(taskRun: Record<string, unknown> = { task: "fix", workflowPath: ".github/workflows/gardener-fix.yml", subject: { kind: "issue", issueNumber: 7 } }, operations: TaskEffectPlanV1["operations"] = []): TaskEffectPlanV1 {
  return taskEffectPlanV1Schema.parse({
    schemaVersion: "gardener.task-effect-plan/v1",
    runId: "repo-123-run-2-attempt-1-plan",
    taskId: "triage",
    taskName: "Triage",
    bundleHash: "a".repeat(64),
    repository: { id: "123", fullName: "owner/repo", defaultBranch: "main" },
    provenance: { sourcePath: ".gardener/tasks/triage/TASK.md", commitSha: COMMIT, workflowRunId: "2", workflowRunAttempt: 1 },
    event: { kind: "github.issue.opened", eventName: "issues", action: "opened", resource: { kind: "issue", id: "999", number: 7 }, commentId: null },
    limits: {},
    operations,
    taskRuns: [taskRun],
  });
}

function opened(operation: Operation): GitHubEffectResult {
  return {
    receipt: {
      schemaVersion: "v2", operationId: operation.id, operationHash: canonicalOperationHash(operation), kind: operation.kind,
      status: "succeeded", attempt: 1, attemptedAt: PLANNED, completedAt: PLANNED,
    },
    outputs: { kind: "pull_request.open", pullNumber: 12, pullUrl: "https://github.com/owner/repo/pull/12", pullNodeId: "PR_1", headRef: "gardener/issue-7", headSha: COMMIT, baseRef: "main" } as NonNullable<GitHubEffectResult["outputs"]>,
  };
}

/** GitHub: the repository reads with a default branch, the dispatch answers `status`. */
function github(status = 204, events: string[] = []) {
  const dispatches: { url: string; body: unknown }[] = [];
  const fetchImpl = vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
    const url = String(request);
    if (init?.method === "POST") {
      events.push("POST");
      dispatches.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(null, { status });
    }
    return Response.json({ default_branch: "trunk" });
  });
  return { fetch: fetchImpl as unknown as typeof fetch, dispatches };
}

async function apply(value: TaskEffectPlanV1, options: { prior?: RunnerEffectReceiptV1 | null; status?: number; record?: (receipt: RunnerEffectReceiptV1) => Promise<void> } = {}) {
  const recorded: RunnerEffectReceiptV1[] = [];
  const events: string[] = [];
  const { fetch, dispatches } = github(options.status, events);
  const result = await effects.applyOrderedPlan({
    plan: value,
    artifactSha256: ARTIFACT,
    token: "gh-token",
    deadlineAt: Date.now() + 60_000,
    prior: options.prior ?? null,
    fetch,
    execute: async (operation) => opened(operation),
    record: async (receipt) => {
      const parsed = runnerEffectReceiptV1Schema.parse(receipt);
      events.push(`record:${parsed.taskRuns?.[0]?.status ?? parsed.status}`);
      if (options.record) await options.record(parsed);
      recorded.push(parsed);
    },
  });
  return { result, recorded, dispatches, events };
}

beforeEach(() => {
  process.env.GITHUB_RUN_ATTEMPT = "1";
});

describe("the task.run dispatch request", () => {
  it("has exactly one input, naming the subject, on the default branch read from the API", () => {
    const request = taskRunDispatchRequest({ task: "fix", workflowPath: ".github/workflows/gardener-fix.yml" }, { kind: "issue", number: 7 }, "trunk");
    expect(request).toEqual({ workflowFile: "gardener-fix.yml", body: { ref: "trunk", inputs: { issue: "7" } } });
    expect(Object.keys(request.body.inputs)).toHaveLength(1);
    expect(Object.keys(request.body)).toEqual(["ref", "inputs"]);
    expect(taskRunDispatchRequest({ task: "fix-ready", workflowPath: ".github/workflows/gardener-fix-ready.yml" }, { kind: "pull_request", number: 12 }, "main").body.inputs)
      .toEqual({ pull_request: "12" });
  });

  it("refuses any workflow that is not the task's own Gardener workflow", () => {
    for (const workflowPath of [".github/workflows/release.yml", ".github/workflows/gardener-deploy.yml", ".github/workflows/../gardener-fix.yml", "gardener-fix.yml"]) {
      expect(() => taskRunDispatchRequest({ task: "fix", workflowPath }, { kind: "issue", number: 7 }, "main")).toThrow(/not task fix's Gardener workflow/);
    }
  });
});

describe("applying a plan with a task run", () => {
  it("reports dispatching before it calls GitHub, then dispatched, with the one input", async () => {
    const { result, recorded, dispatches, events } = await apply(plan());
    expect(events).toEqual(["record:dispatching", "POST", "record:dispatched"]);
    expect(dispatches).toEqual([{ url: "https://api.github.com/repos/owner/repo/actions/workflows/gardener-fix.yml/dispatches", body: { ref: "trunk", inputs: { issue: "7" } } }]);
    expect(recorded.at(-1)?.taskRuns?.[0]).toMatchObject({ task: "fix", subject: { kind: "issue", number: 7 }, status: "dispatched" });
    expect(result.taskRun?.receipt.status).toBe("dispatched");
  });

  it("starts the task on the pull request the plan opened, from that step's output", async () => {
    const { dispatches, recorded } = await apply(plan({ task: "fix-ready", workflowPath: ".github/workflows/gardener-fix-ready.yml", subject: { kind: "pull_request", openedBy: "open-pr" } }, [openPr]));
    expect(dispatches.map((dispatch) => dispatch.body)).toEqual([{ ref: "trunk", inputs: { pull_request: "12" } }]);
    expect(recorded.at(-1)?.taskRuns?.[0]?.subject).toEqual({ kind: "pull_request", number: 12 });
  });

  it("never calls GitHub when the runtime refuses the dispatching receipt", async () => {
    const attempt = apply(plan(), { record: async (receipt) => { if (receipt.taskRuns?.[0]?.status === "dispatching") throw new Error("not enabled"); } });
    await expect(attempt).rejects.toThrow("not enabled");
  });

  it("settles a refused dispatch as dispatch_unknown, final", async () => {
    const { result, dispatches } = await apply(plan(), { status: 404 });
    expect(dispatches).toHaveLength(1);
    expect(result.taskRun?.receipt).toMatchObject({ status: "dispatch_unknown", reason: "dispatch_refused" });
  });

  it("never dispatches again after dispatching was reported, whatever came of it", async () => {
    const first = await apply(plan());
    const dispatching = first.recorded[0]!;
    // An attempt stopped between reporting and settling: the outcome is unknown, and it is not sent again.
    const resumed = await apply(plan(), { prior: dispatching });
    expect(resumed.dispatches).toHaveLength(0);
    expect(resumed.result.taskRun?.receipt).toMatchObject({ status: "dispatch_unknown", reason: "interrupted" });
    // Settled either way: a rerun records nothing and calls nothing.
    for (const prior of [first.recorded.at(-1)!, resumed.recorded.at(-1)!]) {
      const again = await apply(plan(), { prior });
      expect(again.dispatches).toHaveLength(0);
      expect(again.recorded).toHaveLength(0);
      expect(again.result.taskRun?.settled).toBe(true);
    }
  });

  it("refuses, naming the step, when the step that opened the pull request recorded no number, before calling GitHub", async () => {
    const value = plan({ task: "fix-ready", workflowPath: ".github/workflows/gardener-fix-ready.yml", subject: { kind: "pull_request", openedBy: "open-pr" } }, [openPr]);
    const operation = value.operations[0]!;
    const receipt = (status: "succeeded" | "failed") => ({
      schemaVersion: "v2" as const, operationId: operation.operationId, operationHash: "d".repeat(64), kind: operation.kind,
      status, attempt: 1, attemptedAt: PLANNED, completedAt: PLANNED,
      ...(status === "failed" ? { error: { code: "github_unavailable", message: "down", retryable: true } } : {}),
    });
    const steps = [
      [{ stepName: "open-pr", receipt: receipt("succeeded"), outputs: {} }],
      [{ stepName: "open-pr", receipt: receipt("failed"), outputs: { pullNumber: 12 } }],
      [],
    ];
    for (const operations of steps) {
      const { fetch } = github();
      const recorded: unknown[] = [];
      await expect(dispatchPlanTaskRun({
        plan: value,
        operations: operations as never,
        token: "t",
        deadlineAt: Date.now() + 60_000,
        fetch,
        record: async (receipt) => { recorded.push(receipt); },
      })).rejects.toThrow("task.run names the pull request step open-pr opened, which recorded no pull request number");
      expect(fetch).not.toHaveBeenCalled();
      expect(recorded).toEqual([]);
    }
  });

  it("does nothing for a plan without one", async () => {
    const calls: string[] = [];
    await expect(dispatchPlanTaskRun({
      plan: { ...plan(), taskRuns: undefined } as unknown as TaskEffectPlanV1,
      operations: [], token: "t", deadlineAt: Date.now() + 60_000,
      record: async () => { calls.push("record"); },
    })).resolves.toBeUndefined();
    expect(calls).toEqual([]);
  });
});
