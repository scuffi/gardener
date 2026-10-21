import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { taskEffectPlanV1Schema, type Operation, type TaskEffectPlanV1 } from "@gardener/contracts";
import { runnerEffectReceiptV1Schema, type RunnerEffectReceiptV1 } from "@gardener/protocol";
import { canonicalOperationHash, type GitHubEffectResult, type GitHubEffectsContext } from "../src/github-effects";

const core = vi.hoisted(() => ({
  setOutput: vi.fn(),
  setFailed: vi.fn(),
  setSecret: vi.fn(),
  notice: vi.fn(),
}));

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

const SLACK = "https://hooks.slack.com/services/T0SECRET1/B0SECRET2/abcdefSECRETxyz";
process.env["INPUT_CHAT-WEBHOOK"] = ` ${SLACK} `;
delete process.env.GITHUB_STEP_SUMMARY;
const effects = await import("../src/effects-main");
await vi.waitFor(() => expect(core.setFailed).toHaveBeenCalled());
// Captured at import, which is when the bridge reads the destination.
const maskedAtImport = core.setSecret.mock.calls.map(([value]) => value as string);

const PLANNED = "2026-10-21T10:00:00.000Z";
const LABELLED = "2026-10-21T10:00:05.000Z";
const ARTIFACT = "c".repeat(64);

function plan(operations: TaskEffectPlanV1["operations"], messages = true): TaskEffectPlanV1 {
  return taskEffectPlanV1Schema.parse({
    schemaVersion: "gardener.task-effect-plan/v1",
    runId: "repo-123-run-2-attempt-1-plan",
    taskId: "triage",
    taskName: "Triage",
    bundleHash: "a".repeat(64),
    repository: { id: "123", fullName: "owner/repo", defaultBranch: "main" },
    provenance: { sourcePath: ".gardener/tasks/triage/TASK.md", commitSha: "b".repeat(40), workflowRunId: "2", workflowRunAttempt: 1 },
    event: { kind: "github.workflow_dispatch", eventName: "workflow_dispatch", action: null, resource: null, commentId: null },
    limits: {},
    operations,
    ...(messages
      ? { messages: [{ channel: "default", subject: { kind: "issue", issueNumber: 7, expectedIssueUpdatedAt: PLANNED }, summary: "Crash on start." }] }
      : {}),
  });
}

const label = {
  stepName: "label",
  operationId: "op_label",
  kind: "issue.label.add",
  payload: { issueNumber: 7, expectedIssueState: "open", expectedIssueUpdatedAt: PLANNED, label: "priority: high" },
  references: {},
  rationale: "Urgent.",
} as TaskEffectPlanV1["operations"][number];

function succeeded(operation: Operation): GitHubEffectResult {
  return {
    receipt: {
      schemaVersion: "v2", operationId: operation.id, operationHash: canonicalOperationHash(operation), kind: operation.kind,
      status: "succeeded", attempt: 1, attemptedAt: PLANNED, completedAt: PLANNED,
    },
    outputs: { kind: "issue.label.add", issueNumber: 7, label: "priority: high" } as NonNullable<GitHubEffectResult["outputs"]>,
    resourceVersion: { resource: "issue:7", updatedAt: LABELLED },
  };
}

function failing(operation: Operation): GitHubEffectResult {
  return {
    receipt: {
      schemaVersion: "v2", operationId: operation.id, operationHash: canonicalOperationHash(operation), kind: operation.kind,
      status: "failed", attempt: 1, attemptedAt: PLANNED, completedAt: PLANNED,
      error: { code: "github_unavailable", message: "down", retryable: true },
    },
  };
}

/** GitHub answers the subject at `updatedAt`; Slack accepts every post. */
function service(updatedAt: string) {
  const posts: string[] = [];
  const fetchImpl = vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
    const url = String(request);
    if (url.startsWith("https://api.github.com/")) {
      return Response.json({ updated_at: updatedAt, title: "Crash", html_url: "https://github.com/owner/repo/issues/7", user: { login: "octocat" } });
    }
    posts.push(String(init?.body));
    return new Response("ok");
  });
  return { fetch: fetchImpl as unknown as typeof fetch, posts };
}

async function apply(value: TaskEffectPlanV1, options: {
  prior?: RunnerEffectReceiptV1 | null;
  updatedAt?: string;
  destination?: string;
  execute?: (operation: Operation, context: GitHubEffectsContext) => Promise<GitHubEffectResult>;
} = {}) {
  const recorded: RunnerEffectReceiptV1[] = [];
  const contexts: GitHubEffectsContext[] = [];
  const { fetch, posts } = service(options.updatedAt ?? PLANNED);
  const result = await effects.applyOrderedPlan({
    plan: value,
    artifactSha256: ARTIFACT,
    token: "gh-token",
    deadlineAt: Date.now() + 60_000,
    prior: options.prior ?? null,
    destination: options.destination ?? SLACK,
    fetch,
    execute: async (operation, context) => {
      contexts.push(context);
      return (options.execute ?? (async (op) => succeeded(op)))(operation, context);
    },
    record: async (receipt) => { recorded.push(runnerEffectReceiptV1Schema.parse(receipt)); },
  });
  return { result, recorded, posts, contexts };
}

beforeEach(() => {
  process.env.GITHUB_RUN_ATTEMPT = "1";
});

afterAll(() => {
  delete process.env["INPUT_CHAT-WEBHOOK"];
});

describe("applying a plan with a message", () => {
  it("reads the destination once, masks it, and removes it from the environment", () => {
    expect(process.env["INPUT_CHAT-WEBHOOK"]).toBeUndefined();
    expect(maskedAtImport).toContain(SLACK);
  });

  it("sends after every operation applied, accepting the plan's own write to the subject", async () => {
    const { result, recorded, posts, contexts } = await apply(plan([label]), { updatedAt: LABELLED });
    // The label step reads its version back because the message needs it.
    expect(contexts[0]!.readBackVersion).toBe(true);
    expect(posts).toHaveLength(1);
    expect(recorded.map((receipt) => [receipt.status, receipt.messages?.[0]?.status])).toEqual([["applied", undefined], ["applied", "sent"]]);
    expect(result.message?.receipt.status).toBe("sent");
    expect(JSON.stringify(recorded)).not.toContain("hooks.slack.com");
  });

  it("sends nothing when an operation stopped the plan", async () => {
    const { result, posts } = await apply(plan([label]), { execute: async (operation) => failing(operation) });
    expect(result.receipt.status).toBe("stopped");
    expect(result.message).toBeUndefined();
    expect(posts).toHaveLength(0);
  });

  it("records a receipt for a plan whose only effect is the message", async () => {
    const { result, recorded, posts } = await apply(plan([]));
    expect(posts).toHaveLength(1);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ plannedOperations: 0, operations: [], status: "applied", messages: [{ status: "sent" }] });
    expect(result.receipt).toEqual(recorded[0]);
  });

  it("skips, records and succeeds without a destination", async () => {
    const { result, recorded, posts } = await apply(plan([]), { destination: "" });
    expect(posts).toHaveLength(0);
    expect(recorded[0]?.messages?.[0]).toMatchObject({ status: "skipped", reason: "destination_unset" });
    expect(result.receipt.status).toBe("applied");
  });

  it("conflicts when someone else changed the subject", async () => {
    const { recorded, posts } = await apply(plan([label]), { updatedAt: "2026-10-21T11:00:00.000Z" });
    expect(posts).toHaveLength(0);
    expect(recorded.at(-1)?.messages?.[0]).toMatchObject({ status: "conflicted", reason: "subject_changed" });
  });

  it("on a rerun, does not send again after a sent message, and retries a failed one", async () => {
    const first = await apply(plan([label]), { updatedAt: LABELLED });
    const sent = first.recorded.at(-1)!;
    const again = await apply(plan([label]), { prior: sent, updatedAt: LABELLED, execute: async () => { throw new Error("must not run"); } });
    expect(again.posts).toHaveLength(0);
    expect(again.recorded).toHaveLength(0);
    expect(again.result.message?.settled).toBe(true);
    expect(again.result.receipt).toEqual(sent);

    const failed = runnerEffectReceiptV1Schema.parse({ ...sent, messages: [{ ...sent.messages![0]!, status: "failed", reason: "send_failed" }] });
    const retried = await apply(plan([label]), { prior: failed, updatedAt: LABELLED, execute: async () => { throw new Error("must not run"); } });
    expect(retried.posts).toHaveLength(1);
    expect(retried.recorded.map((receipt) => receipt.messages?.[0]?.status)).toEqual(["sent"]);

    // Operations applied but the message never tried (a crash in between): try it now.
    const untried = runnerEffectReceiptV1Schema.parse({ ...sent, messages: undefined });
    expect((await apply(plan([label]), { prior: untried, updatedAt: LABELLED })).posts).toHaveLength(1);
  });

  it("treats an empty message list as no message, with a real receipt", async () => {
    // The plan schema refuses `[]`; this guards the runner if that bound ever moves.
    const value = { ...plan([label], false), messages: [] } as unknown as TaskEffectPlanV1;
    const { result, recorded, posts } = await apply(value);
    expect(posts).toHaveLength(0);
    expect(result.receipt).toEqual(recorded.at(-1));
    expect(result.receipt).toMatchObject({ status: "applied", operations: [{ stepName: "label" }] });
    expect(result.message).toBeUndefined();
  });

  it("leaves plans without a message exactly as before", async () => {
    const { result, recorded, contexts } = await apply(plan([label], false));
    expect(contexts[0]!.readBackVersion).toBeUndefined();
    expect(recorded).toHaveLength(1);
    expect(result.receipt).not.toHaveProperty("messages");
    expect(result.message).toBeUndefined();
  });
});
