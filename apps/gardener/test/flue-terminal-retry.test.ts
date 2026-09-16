import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Operation } from "@gardener/contracts";

const mocks = vi.hoisted(() => ({
  assertAuthority: vi.fn(async () => undefined),
  claim: vi.fn(async () => true),
  execute: vi.fn(),
  getEffect: vi.fn(async () => ({ status: "approved", operationHash: "b".repeat(64) })),
  getRun: vi.fn(async () => ({ cancelRequestedAt: null as string | null })),
  markNotExecuted: vi.fn(),
  markUnknown: vi.fn(),
  record: vi.fn(),
}));
vi.mock("../src/instance-state", () => ({ assertLiveAutomaticAuthority: mocks.assertAuthority }));
vi.mock("../src/providers/github/client", () => ({ executeGitHubOperation: mocks.execute }));
vi.mock("../src/persistence", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  claimEffectExecution: mocks.claim,
  getEffect: mocks.getEffect,
  getRun: mocks.getRun,
  markEffectNotExecuted: mocks.markNotExecuted,
  markEffectOutcomeUnknown: mocks.markUnknown,
  recordEffectOutcome: mocks.record,
}));

import { executeExactCommentEffect } from "../src/harness/flue/terminal-tool";

const operation: Operation = {
  schemaVersion: "v2",
  id: `op_${"a".repeat(64)}`,
  kind: "issue.comment.create",
  repository: { provider: "github", id: "repo", installationId: "installation", owner: "acme", name: "widgets", defaultBranch: "main" },
  issueNumber: 1,
  expectedIssueState: "open",
  expectedIssueUpdatedAt: "2026-01-01T00:00:00.000Z",
  body: "Hello",
};
const effect = { effectId: `effect_${"b".repeat(64)}`, operation, operationHash: "b".repeat(64) };

describe("terminal exact-effect retries", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.assertAuthority.mockResolvedValue(undefined);
    mocks.claim.mockResolvedValue(true);
    mocks.getEffect.mockResolvedValue({ status: "approved", operationHash: effect.operationHash });
    mocks.getRun.mockResolvedValue({ cancelRequestedAt: null });
  });

  it("retries an ambiguous Gateway throw inside versioned durable attempts without changing the operation", async () => {
    vi.clearAllMocks();
    mocks.getEffect.mockResolvedValue({ status: "approved", operationHash: effect.operationHash });
    mocks.claim.mockResolvedValue(true);
    mocks.execute
      .mockRejectedValueOnce(new Error("event delivery is not visible yet"))
      .mockResolvedValueOnce({ status: "succeeded" });
    mocks.record.mockResolvedValue({ effect: { status: "executed" }, receipt: { status: "succeeded" }, retryable: false });
    const names: string[] = [];
    const step = {
      async do<T>(name: string, callback: () => Promise<T>): Promise<T> {
        names.push(name);
        return callback();
      },
    };

    await expect(executeExactCommentEffect({ DB: {} } as any, {
      runId: "run-native", eventId: "event-native", deadlineAt: "2099-01-01T00:00:00.000Z",
      attempts: 2, effect,
    }, step as any)).resolves.toBe("executed");

    expect(names).toEqual([
      "execute-exact-comment-effect-v1-attempt-1",
      "execute-exact-comment-effect-v1-attempt-2",
    ]);
    expect(mocks.execute).toHaveBeenCalledTimes(2);
    expect(mocks.execute.mock.calls[0]).toEqual(mocks.execute.mock.calls[1]);
    expect(mocks.execute.mock.calls[0]).toEqual([expect.any(Object), "run-native", "event-native", operation]);
    expect(mocks.assertAuthority).toHaveBeenCalledTimes(6);
    expect(mocks.record).toHaveBeenCalledOnce();
    expect(mocks.markUnknown).not.toHaveBeenCalled();
  });

  it("projects exhausted ambiguous calls to a non-active unknown outcome", async () => {
    vi.clearAllMocks();
    mocks.getEffect.mockResolvedValue({ status: "approved", operationHash: effect.operationHash });
    mocks.claim.mockResolvedValue(true);
    mocks.execute.mockRejectedValue(new Error("ambiguous Gateway transport failure"));
    mocks.markUnknown.mockResolvedValue({ status: "failed" });
    const names: string[] = [];
    const step = {
      async do<T>(name: string, callback: () => Promise<T>): Promise<T> {
        names.push(name);
        return callback();
      },
    };

    await expect(executeExactCommentEffect({ DB: {} } as any, {
      runId: "run-native", eventId: "event-native", deadlineAt: "2099-01-01T00:00:00.000Z",
      attempts: 2, effect,
    }, step as any)).resolves.toBe("failed");

    expect(names).toEqual([
      "execute-exact-comment-effect-v1-attempt-1",
      "execute-exact-comment-effect-v1-attempt-2",
      "finalize-exact-comment-effect-v1-outcome-unknown",
    ]);
    expect(mocks.execute).toHaveBeenCalledTimes(2);
    expect(mocks.markUnknown).toHaveBeenCalledWith(expect.any(Object), {
      effectId: effect.effectId,
      operationHash: effect.operationHash,
      runId: "run-native",
    });
  });

  it("projects cancellation after claim but before Gateway invocation as known not executed", async () => {
    vi.clearAllMocks();
    let status = "approved";
    mocks.getEffect.mockImplementation(async () => ({ status, operationHash: effect.operationHash }));
    mocks.getRun.mockResolvedValue({ cancelRequestedAt: "2026-01-01T00:00:00.000Z" });
    mocks.claim.mockImplementation(async () => { status = "executing"; return true; });
    mocks.assertAuthority
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("cancelled"));
    mocks.markNotExecuted.mockImplementation(async () => ({ status: "cancelled" }));
    const names: string[] = [];
    const step = { async do<T>(name: string, callback: () => Promise<T>) { names.push(name); return callback(); } };

    await expect(executeExactCommentEffect({ DB: {} } as any, {
      runId: "run-native", eventId: "event-native", deadlineAt: "2099-01-01T00:00:00.000Z",
      attempts: 2, effect,
    }, step as any)).resolves.toBe("cancelled");

    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.markNotExecuted).toHaveBeenCalledWith(expect.any(Object), {
      effectId: effect.effectId,
      operationHash: effect.operationHash,
      runId: "run-native",
      expectedStatus: "executing",
      reason: "cancelled",
    });
    expect(names).toEqual([
      "execute-exact-comment-effect-v1-attempt-1",
      "finalize-exact-comment-effect-v1-cancelled",
    ]);
  });

  it("projects authority loss between ambiguous attempts to outcome unknown", async () => {
    vi.clearAllMocks();
    mocks.getEffect.mockResolvedValue({ status: "executing", operationHash: effect.operationHash });
    mocks.assertAuthority.mockRejectedValue(new Error("authority narrowed"));
    mocks.markUnknown.mockResolvedValue({ status: "failed" });
    const names: string[] = [];
    const step = { async do<T>(name: string, callback: () => Promise<T>) { names.push(name); return callback(); } };

    await expect(executeExactCommentEffect({ DB: {} } as any, {
      runId: "run-native", eventId: "event-native", deadlineAt: "2099-01-01T00:00:00.000Z",
      attempts: 2, effect,
    }, step as any)).resolves.toBe("failed");

    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.markUnknown).toHaveBeenCalledOnce();
    expect(names).toEqual(["finalize-exact-comment-effect-v1-outcome-unknown"]);
  });

  it("projects an executing effect to unknown when the deadline expires during backoff", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    try {
      vi.clearAllMocks();
      let status = "approved";
      mocks.getEffect.mockImplementation(async () => ({ status, operationHash: effect.operationHash }));
      mocks.claim.mockImplementation(async () => { status = "executing"; return true; });
      mocks.execute.mockRejectedValue(new Error("ambiguous"));
      mocks.markUnknown.mockResolvedValue({ status: "failed" });
      const step = { async do<T>(_name: string, callback: () => Promise<T>) { return callback(); } };
      const execution = executeExactCommentEffect({ DB: {} } as any, {
        runId: "run-native", eventId: "event-native", deadlineAt: "2026-01-01T00:00:00.100Z",
        attempts: 2, effect,
      }, step as any);
      await vi.advanceTimersByTimeAsync(100);
      await expect(execution).resolves.toBe("failed");
      expect(mocks.markUnknown).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
