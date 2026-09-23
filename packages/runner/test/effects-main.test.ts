import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  taskEffectPlanV1Schema,
  type Operation,
  type TaskEffectPlanV1,
} from "@gardener/contracts";
import type { RunnerEffectReceiptV1 } from "@gardener/protocol";
import {
  canonicalOperationHash,
  type GitHubEffectResult,
  type GitHubEffectsContext,
  type OperationOutputsV1,
} from "../src/github-effects";

const core = vi.hoisted(() => ({
  inputs: new Map<string, string>(),
  setOutput: vi.fn(),
  setFailed: vi.fn(),
  setSecret: vi.fn(),
  recordEffect: vi.fn(async (receipt: RunnerEffectReceiptV1) => receipt),
  priorEffectReceipt: vi.fn(async () => null as RunnerEffectReceiptV1 | null),
}));

vi.mock("@actions/core", () => ({
  getInput: (name: string) => core.inputs.get(name) ?? "",
  setOutput: core.setOutput,
  setFailed: core.setFailed,
  setSecret: core.setSecret,
  getIDToken: vi.fn(async () => "oidc-token"),
}));

vi.mock("capnweb", () => ({
  RpcTarget: class {},
  newWebSocketRpcSession: vi.fn(() => ({
    authenticate: () => ({
      recordEffect: core.recordEffect,
      priorEffectReceipt: core.priorEffectReceipt,
    }),
    [Symbol.dispose]: vi.fn(),
  })),
}));

vi.mock("../src/context", () => ({
  helloFromOidcToken: vi.fn(() => ({ phase: "effects" })),
  sessionSocketUrl: vi.fn(() => "wss://gardener.example/session/effects"),
}));

const effects = await import("../src/effects-main");
await vi.waitFor(() => expect(core.setFailed).toHaveBeenCalled());

const SHA = "b".repeat(40);
const BUNDLE_HASH = "a".repeat(64);
const ARTIFACT_HASH = "c".repeat(64);
const NOW = "2026-09-17T12:01:00.000Z";

function step(
  stepName: string,
  operationId: string,
  kind: TaskEffectPlanV1["operations"][number]["kind"],
  payload: Record<string, unknown>,
  references: Record<string, { step: string; output: string }> = {},
): TaskEffectPlanV1["operations"][number] {
  return {
    stepName,
    operationId,
    kind,
    payload,
    references,
    rationale: `Apply ${stepName}.`,
  } as TaskEffectPlanV1["operations"][number];
}

function plan(operations: TaskEffectPlanV1["operations"], extra: Partial<TaskEffectPlanV1> = {}): TaskEffectPlanV1 {
  return taskEffectPlanV1Schema.parse({
    schemaVersion: "gardener.task-effect-plan/v1",
    runId: "repo-123-run-2-attempt-1-plan",
    taskId: "fixture.task",
    taskName: "Fixture task",
    bundleHash: BUNDLE_HASH,
    repository: { id: "123", fullName: "owner/repo", defaultBranch: "main" },
    provenance: {
      sourcePath: ".gardener/tasks/fixture/TASK.md",
      commitSha: SHA,
      workflowRunId: "2",
      workflowRunAttempt: 1,
    },
    event: {
      kind: "github.workflow_dispatch",
      eventName: "workflow_dispatch",
      action: null,
      resource: null,
      commentId: null,
    },
    limits: {},
    operations,
    ...extra,
  });
}

function receipt(operation: Operation, status: "succeeded" | "skipped" | "failed" | "conflicted" = "succeeded") {
  return {
    schemaVersion: "v2" as const,
    operationId: operation.id,
    operationHash: canonicalOperationHash(operation),
    kind: operation.kind,
    status,
    attempt: 1,
    attemptedAt: NOW,
    completedAt: "2026-09-17T12:01:01.000Z",
    ...(status === "failed" || status === "conflicted"
      ? { error: { code: "fixture_failure", message: "fixture failed", retryable: status === "failed" } }
      : {}),
  };
}

function success(operation: Operation, outputs: OperationOutputsV1): GitHubEffectResult {
  return { receipt: receipt(operation), outputs };
}

function commentStep(name: string, id: string, body = "Thanks.") {
  return step(name, id, "issue.comment.create", {
    issueNumber: 7,
    expectedIssueState: "open",
    expectedIssueUpdatedAt: "2026-09-17T12:00:00.000Z",
    body,
  });
}

beforeEach(() => {
  core.inputs.clear();
  core.setOutput.mockClear();
  core.setFailed.mockClear();
  core.setSecret.mockClear();
  core.recordEffect.mockClear();
  core.priorEffectReceipt.mockClear();
  process.env.GITHUB_RUN_ATTEMPT = "1";
});

describe("ordered effect application", () => {
  it("resolves typed prior-step outputs and records progress in exact order", async () => {
    const value = plan([
      step("branch", "op_branch", "branch.create", {
        branch: "gardener/fix-1",
        fromSha: SHA,
        expectedAbsent: true,
      }),
      step("release", "op_release", "release.create", {
        tagName: "v0.0.1-draft",
        expectedTagAbsent: true,
        name: "Draft",
        body: "Draft release.",
        draft: true,
        prerelease: true,
      }, { "/targetCommitSha": { step: "branch", output: "commitSha" } }),
    ]);
    const seen: Operation[] = [];
    const recorded: RunnerEffectReceiptV1[] = [];
    const execute = vi.fn(async (operation: Operation, _context: GitHubEffectsContext) => {
      seen.push(operation);
      if (operation.kind === "branch.create") {
        return success(operation, {
          kind: operation.kind,
          branch: operation.branch,
          ref: `refs/heads/${operation.branch}`,
          commitSha: SHA,
          branchUrl: "https://github.com/owner/repo/tree/gardener/fix-1",
        });
      }
      if (operation.kind !== "release.create") throw new Error("unexpected operation");
      expect(operation.targetCommitSha).toBe(SHA);
      return success(operation, {
        kind: operation.kind,
        releaseId: "99",
        tagName: operation.tagName,
        releaseUrl: "https://github.com/owner/repo/releases/tag/v0.0.1-draft",
        draft: true,
        prerelease: true,
      });
    });

    const result = await effects.applyOrderedPlan({
      plan: value,
      artifactSha256: ARTIFACT_HASH,
      token: "token",
      deadlineAt: Date.now() + 60_000,
      prior: null,
      execute,
      record: async (value) => { recorded.push(value); },
    });

    expect(seen.map((operation) => operation.kind)).toEqual(["branch.create", "release.create"]);
    expect(recorded.map((entry) => [entry.status, entry.operations.length]))
      .toEqual([["running", 1], ["applied", 2]]);
    expect(result.receipt.status).toBe("applied");
    expect(result.outputs.get("release")?.releaseId).toBe("99");
  });

  it("derives provider-visible idempotency markers after planning", async () => {
    const value = plan([
      commentStep("issue-comment", "op_issue", "Thanks."),
      step("review", "op_review", "pull_request.review.submit", {
        pullNumber: 8,
        expectedHeadSha: SHA,
        expectedBaseRef: "main",
        expectedBaseSha: SHA,
        expectedState: "open",
        expectedDraft: false,
        expectedPullUpdatedAt: NOW,
        event: "comment",
        body: "Review note.",
        comments: [],
      }),
      step("draft", "op_draft", "pull_request.open_draft", {
        head: "gardener/fix-1",
        base: "main",
        expectedHeadSha: SHA,
        expectedBaseSha: SHA,
        title: "Draft fix",
        body: "",
        draft: true,
      }),
    ]);
    const seen: Operation[] = [];
    await effects.applyOrderedPlan({
      plan: value,
      artifactSha256: ARTIFACT_HASH,
      token: "token",
      deadlineAt: Date.now() + 60_000,
      prior: null,
      execute: async (operation) => {
        seen.push(operation);
        if (operation.kind === "issue.comment.create") {
          return success(operation, {
            kind: operation.kind,
            issueNumber: operation.issueNumber,
            commentId: "101",
            commentUrl: "https://github.com/owner/repo/issues/7#issuecomment-101",
          });
        }
        if (operation.kind === "pull_request.review.submit") {
          return success(operation, {
            kind: operation.kind,
            pullNumber: operation.pullNumber,
            reviewId: "201",
            reviewUrl: "https://github.com/owner/repo/pull/8#pullrequestreview-201",
            reviewState: "COMMENTED",
          });
        }
        if (operation.kind !== "pull_request.open_draft") throw new Error("unexpected operation");
        return success(operation, {
          kind: operation.kind,
          pullNumber: 9,
          pullUrl: "https://github.com/owner/repo/pull/9",
          pullNodeId: "PR_kwDOAbc",
          headRef: operation.head,
          headSha: operation.expectedHeadSha,
          baseRef: operation.base,
        });
      },
      record: async () => undefined,
    });

    expect(seen.map((operation) => "body" in operation ? operation.body : undefined)).toEqual([
      "Thanks.\n<!-- gardener-operation:op_issue -->",
      "Review note.\n<!-- gardener-operation:op_review -->",
      "<!-- gardener-operation:op_draft -->",
    ]);
  });

  it("stops on the first failed step and resumes from its successful prefix", async () => {
    const value = plan([
      commentStep("first", "op_first", "First."),
      commentStep("second", "op_second", "Second."),
      commentStep("third", "op_third", "Third."),
    ]);
    let calls = 0;
    const firstPass = await effects.applyOrderedPlan({
      plan: value,
      artifactSha256: ARTIFACT_HASH,
      token: "token",
      deadlineAt: Date.now() + 60_000,
      prior: null,
      execute: async (operation) => {
        calls += 1;
        if (calls === 2) return { receipt: receipt(operation, "failed") };
        return success(operation, {
          kind: "issue.comment.create",
          issueNumber: 7,
          commentId: "101",
          commentUrl: "https://github.com/owner/repo/issues/7#issuecomment-101",
        });
      },
      record: async () => undefined,
    });
    expect(firstPass.receipt.status).toBe("stopped");
    expect(firstPass.receipt.stoppedAtStep).toBe("second");
    expect(firstPass.receipt.operations).toHaveLength(2);

    const retried: string[] = [];
    const secondPass = await effects.applyOrderedPlan({
      plan: value,
      artifactSha256: ARTIFACT_HASH,
      token: "token",
      deadlineAt: Date.now() + 60_000,
      prior: firstPass.receipt,
      execute: async (operation) => {
        retried.push(operation.id);
        const suffix = operation.id === "op_second" ? "102" : "103";
        return success(operation, {
          kind: "issue.comment.create",
          issueNumber: 7,
          commentId: suffix,
          commentUrl: `https://github.com/owner/repo/issues/7#issuecomment-${suffix}`,
        });
      },
      record: async () => undefined,
    });
    expect(retried).toEqual(["op_second", "op_third"]);
    expect(secondPass.receipt.status).toBe("applied");
    expect(secondPass.receipt.operations.map((entry) => entry.receipt.operationId))
      .toEqual(["op_first", "op_second", "op_third"]);
  });

  it("preserves a conflicted halt instead of retrying an immutable mismatch", async () => {
    const value = plan([commentStep("comment", "op_comment")]);
    const first = await effects.applyOrderedPlan({
      plan: value,
      artifactSha256: ARTIFACT_HASH,
      token: "token",
      deadlineAt: Date.now() + 60_000,
      prior: null,
      execute: async (operation) => ({ receipt: receipt(operation, "conflicted") }),
      record: async () => undefined,
    });
    expect(first.receipt.status).toBe("stopped");

    const execute = vi.fn();
    const resumed = await effects.applyOrderedPlan({
      plan: value,
      artifactSha256: ARTIFACT_HASH,
      token: "token",
      deadlineAt: Date.now() + 60_000,
      prior: first.receipt,
      execute,
      record: async () => undefined,
    });
    expect(execute).not.toHaveBeenCalled();
    expect(resumed.receipt).toEqual(first.receipt);
  });

  it("records a retryable stopped receipt when the apply deadline expires", async () => {
    const value = plan([commentStep("comment", "op_comment")]);
    const recorded: RunnerEffectReceiptV1[] = [];
    const execute = vi.fn();
    const result = await effects.applyOrderedPlan({
      plan: value,
      artifactSha256: ARTIFACT_HASH,
      token: "token",
      deadlineAt: Date.now(),
      prior: null,
      execute,
      record: async (entry) => { recorded.push(entry); },
    });
    expect(execute).not.toHaveBeenCalled();
    expect(result.receipt).toMatchObject({ status: "stopped", stoppedAtStep: "comment" });
    expect(result.receipt.operations[0]?.receipt).toMatchObject({
      status: "failed",
      error: { code: "effect_deadline_expired", retryable: true },
    });
    expect(recorded).toEqual([result.receipt]);
  });

  it("refuses a prior receipt from another artifact before executing", async () => {
    const value = plan([commentStep("comment", "op_comment")]);
    const operation = operationForComment(value.operations[0]!);
    const prior = {
      schemaVersion: "gardener.runner.effect-receipt/v1" as const,
      planRunId: value.runId,
      bundleHash: value.bundleHash,
      artifactSha256: "d".repeat(64),
      plannedOperations: 1,
      status: "applied" as const,
      stoppedAtStep: null,
      operations: [{
        stepName: "comment",
        outputs: { issueNumber: 7, commentId: "1", commentUrl: "https://github.com/owner/repo/issues/7#issuecomment-1" },
        receipt: receipt(operation),
      }],
    };
    const execute = vi.fn();
    await expect(effects.applyOrderedPlan({
      plan: value,
      artifactSha256: ARTIFACT_HASH,
      token: "token",
      deadlineAt: Date.now() + 60_000,
      prior,
      execute,
      record: async () => undefined,
    })).rejects.toThrow(/not bound to this exact plan/);
    expect(execute).not.toHaveBeenCalled();
  });

  it("materializes commit files only as capture-backed metadata", async () => {
    const content = Buffer.from("changed\n");
    const digest = createHash("sha256").update(content).digest("hex");
    const capture = {
      schemaVersion: "gardener.task-capture-manifest/v1" as const,
      captureId: `cap_${"1".repeat(64)}`,
      baseSha: SHA,
      files: [{ path: "src/a.txt", status: "modified" as const, mode: "100644" as const, sizeBytes: content.length, sha256: digest }],
      totalBytes: content.length,
      truncated: false as const,
    };
    const value = plan([
      step("commit", "op_commit", "commit.create", {
        branch: "gardener/fix-1",
        expectedHeadSha: SHA,
        message: "Apply capture.",
      }),
    ], { capture, changesSha256: "e".repeat(64) });
    let read = false;
    const result = await effects.applyOrderedPlan({
      plan: value,
      artifactSha256: ARTIFACT_HASH,
      token: "token",
      deadlineAt: Date.now() + 60_000,
      prior: null,
      captureDirectory: "/verified/capture",
      execute: async (operation, context) => {
        if (operation.kind !== "commit.create" || !("captured" in operation.files[0]!)) {
          throw new Error("commit was not capture-backed");
        }
        expect(operation.files[0]!.captured).toMatchObject({ sha256: digest, sizeBytes: content.length });
        expect(context.readCapturedFile).toBeTypeOf("function");
        // The reader itself is separately exercised by capture integration;
        // this pins that it is the only byte source given to the executor.
        read = true;
        return success(operation, {
          kind: operation.kind,
          branch: operation.branch,
          commitSha: "f".repeat(40),
          treeSha: "1".repeat(40),
          parentSha: SHA,
          commitUrl: `https://github.com/owner/repo/commit/${"f".repeat(40)}`,
        });
      },
      record: async () => undefined,
    });
    expect(read).toBe(true);
    expect(result.receipt.changesSha256).toBe("e".repeat(64));
  });
});

describe("effects action artifact boundary", () => {
  it("rejects a tampered artifact before opening a runtime session", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "gardener-effect-tampered-"));
    const artifactPath = path.join(directory, "effect.json");
    await writeFile(artifactPath, "{}");
    core.inputs.set("artifact-path", artifactPath);
    core.inputs.set("expected-sha256", "0".repeat(64));
    core.inputs.set("github-token", "token");
    core.inputs.set("runtime-url", "https://gardener.example");
    core.inputs.set("deadline-at", new Date(Date.now() + 60_000).toISOString());

    await effects.runEffectsMain();

    expect(core.setFailed).toHaveBeenCalledWith("Effect artifact digest mismatch");
    expect(core.recordEffect).not.toHaveBeenCalled();
    expect(core.priorEffectReceipt).not.toHaveBeenCalled();
  });
});

function operationForComment(value: TaskEffectPlanV1["operations"][number]): Operation {
  return {
    schemaVersion: "v2",
    id: value.operationId,
    repository: { provider: "github", id: "123", owner: "owner", name: "repo", defaultBranch: "main" },
    kind: "issue.comment.create",
    issueNumber: 7,
    expectedIssueState: "open",
    expectedIssueUpdatedAt: "2026-09-17T12:00:00.000Z",
    body: "Thanks.",
  };
}
