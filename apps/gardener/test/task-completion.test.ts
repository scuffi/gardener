import { describe, expect, it } from "vitest";
import { HARNESS_ADAPTER_VERSIONS } from "../src/harness";
import {
  CompletionSignal,
  SUBMISSION_KEY,
  completionHarnessOutcome,
  confirmTaskResult,
  explainRefusedCompletion,
  recordCompletionRefusal,
  readTaskCompletion,
  recordTaskCandidate,
  recordTaskSettlement,
  untilWokenOrTimeout,
} from "../src/task-runtime/task-completion";
import { MemoryStorage } from "./memory-storage";

const runId = "repo-1-run-2-attempt-1-plan";
const requestId = "task_request_1";
const submissionId = "sub_1";
const submission = {
  schemaVersion: "gardener.harness.submission/v1" as const,
  harness: { id: "flue" as const, adapterVersion: HARNESS_ADAPTER_VERSIONS.flue },
  runId,
  requestId,
  submissionId,
  acceptedAt: "2026-10-01T10:00:00.000Z",
};

function outcome(summary = "Done.") {
  return {
    schemaVersion: "gardener.task-outcome/v1",
    runId,
    taskId: "fixture.issue-triage",
    bundleHash: "a".repeat(64),
    status: "completed",
    summary,
    observations: [],
    proposedEffects: [],
  };
}

async function dispatched(): Promise<MemoryStorage> {
  const storage = new MemoryStorage();
  await storage.put(SUBMISSION_KEY, { runId, requestId, submissionId });
  return storage;
}

const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15, turns: 1, toolCalls: 3, model: "anthropic/claude-opus-5-5" };

describe("task completion pushed by the agent", () => {
  it("completes the run only from a confirmed, single candidate", async () => {
    const storage = await dispatched();
    await recordTaskCandidate(storage, { runId, requestId, toolCallId: "call-9", outcome: outcome() });
    expect(await readTaskCompletion(storage)).toBeNull();

    await confirmTaskResult(storage, { runId, requestId, usage });
    const completion = await readTaskCompletion(storage);
    expect(completion).toMatchObject({ kind: "result", usage, outcome: { summary: "Done." } });

    const harnessOutcome = completionHarnessOutcome(submission, completion!);
    expect(harnessOutcome).toMatchObject({
      status: "completed",
      submissionId,
      result: { kind: "result", summary: "Done.", data: outcome() },
      usage,
    });
  });

  it("is first-wins: a repeat is a duplicate and a divergent replay is never chosen", async () => {
    const storage = await dispatched();
    await expect(recordTaskCandidate(storage, { runId, requestId, toolCallId: "call-9", outcome: outcome() }))
      .resolves.toEqual({ duplicate: false });
    await expect(recordTaskCandidate(storage, { runId, requestId, toolCallId: "call-9", outcome: outcome() }))
      .resolves.toEqual({ duplicate: true });
    // A different outcome is kept apart, and confirmation then refuses to choose.
    await recordTaskCandidate(storage, { runId, requestId, toolCallId: "call-9", outcome: outcome("Different.") });
    await expect(confirmTaskResult(storage, { runId, requestId, usage })).rejects.toThrow(/more than one distinct/);
    expect(await readTaskCompletion(storage)).toBeNull();

    const confirmed = await dispatched();
    await recordTaskCandidate(confirmed, { runId, requestId, toolCallId: "call-9", outcome: outcome() });
    await confirmTaskResult(confirmed, { runId, requestId, usage });
    await expect(confirmTaskResult(confirmed, { runId, requestId, usage: { ...usage, inputTokens: 99 } }))
      .resolves.toEqual({ duplicate: true });
    expect(await readTaskCompletion(confirmed)).toMatchObject({ usage });
    // Neither a later candidate nor a settlement replaces a confirmed result.
    await recordTaskCandidate(confirmed, { runId, requestId, toolCallId: "call-10", outcome: outcome("Later.") });
    await recordTaskSettlement(confirmed, { runId, submissionId, outcome: "failed", error: "late" });
    expect(await readTaskCompletion(confirmed)).toMatchObject({ kind: "result", outcome: { summary: "Done." } });
  });

  it("refuses to confirm with no candidate or with two", async () => {
    const empty = await dispatched();
    await expect(confirmTaskResult(empty, { runId, requestId, usage })).rejects.toThrow(/found none/);

    const two = await dispatched();
    await recordTaskCandidate(two, { runId, requestId, toolCallId: "call-1", outcome: outcome("One.") });
    await recordTaskCandidate(two, { runId, requestId, toolCallId: "call-2", outcome: outcome("Two.") });
    await expect(confirmTaskResult(two, { runId, requestId, usage })).rejects.toThrow(/more than one distinct/);
    expect(await readTaskCompletion(two)).toBeNull();
  });

  it("confirms an identical outcome replayed under a new tool call id", async () => {
    // A durability retry can run finish_task again with a different id; the
    // ids here are shaped like real providers' (the strict pattern once refused them).
    const storage = await dispatched();
    await expect(recordTaskCandidate(storage, { runId, requestId, toolCallId: "call_8f3K|fc_0a1b2c3d", outcome: outcome() }))
      .resolves.toEqual({ duplicate: false });
    await expect(recordTaskCandidate(storage, { runId, requestId, toolCallId: "toolu_01Xy+Zw==", outcome: outcome() }))
      .resolves.toEqual({ duplicate: true });
    await expect(confirmTaskResult(storage, { runId, requestId, usage })).resolves.toEqual({ duplicate: false });
    expect(await readTaskCompletion(storage)).toMatchObject({ kind: "result", outcome: { summary: "Done." } });
    await expect(recordTaskCandidate(storage, { runId, requestId, toolCallId: "", outcome: outcome() }))
      .rejects.toThrow(/tool call id is malformed/);
  });

  it("binds every push to the submission this session dispatched", async () => {
    const before = new MemoryStorage();
    await expect(recordTaskCandidate(before, { runId, requestId, toolCallId: "c", outcome: outcome() }))
      .rejects.toThrow(/before this run's submission/);

    const storage = await dispatched();
    await expect(recordTaskCandidate(storage, { runId: "other-run", requestId, toolCallId: "c", outcome: outcome() }))
      .rejects.toThrow(/not bound/);
    await expect(recordTaskCandidate(storage, { runId, requestId: "task_other", toolCallId: "c", outcome: outcome() }))
      .rejects.toThrow(/does not belong/);
    await expect(recordTaskCandidate(storage, { runId, requestId, toolCallId: "c", outcome: { ...outcome(), runId: "other-run" } }))
      .rejects.toThrow(/this run's completed outcome/);
    await expect(confirmTaskResult(storage, { runId, requestId: "task_other", usage })).rejects.toThrow(/does not belong/);
    await expect(recordTaskSettlement(storage, { runId, submissionId: "sub_other", outcome: "failed" }))
      .rejects.toThrow(/does not belong/);

    // Between writing the request and Flue accepting the dispatch, no settlement can match.
    const undispatched = new MemoryStorage();
    await undispatched.put(SUBMISSION_KEY, { runId, requestId });
    await expect(recordTaskSettlement(undispatched, { runId, submissionId, outcome: "failed" }))
      .rejects.toThrow(/does not belong/);
  });

  it("translates settlements without a result", async () => {
    const aborted = await dispatched();
    await recordTaskSettlement(aborted, { runId, submissionId, outcome: "aborted" });
    expect(completionHarnessOutcome(submission, (await readTaskCompletion(aborted))!))
      .toMatchObject({ status: "cancelled", error: { code: "cancelled" } });

    const completed = await dispatched();
    await recordTaskSettlement(completed, { runId, submissionId, outcome: "completed" });
    expect(completionHarnessOutcome(submission, (await readTaskCompletion(completed))!))
      .toMatchObject({ status: "failed", error: { code: "invalid-outcome" } });

    const limited = await dispatched();
    await recordTaskSettlement(limited, {
      runId, submissionId, outcome: "failed", error: "Error\nGardener native profile permits at most 100 model turns",
    });
    expect(completionHarnessOutcome(submission, (await readTaskCompletion(limited))!))
      .toMatchObject({ status: "failed", error: { code: "budget-exceeded", message: "Task model-turn limit was exceeded" } });
    await expect(recordTaskSettlement(limited, { runId, submissionId, outcome: "aborted" })).resolves.toEqual({ duplicate: true });

    const unknown = await dispatched();
    await recordTaskSettlement(unknown, { runId, submissionId, outcome: "failed" });
    expect(completionHarnessOutcome(submission, (await readTaskCompletion(unknown))!))
      .toMatchObject({ status: "failed", error: { code: "provider-error", message: "Flue task execution failed" } });
  });
});

describe("completion signal", () => {
  it("wakes an armed wait, and a cancelled wait is never retained", async () => {
    const signal = new CompletionSignal();
    const wait = signal.arm();
    signal.notify();
    await expect(wait.promise).resolves.toBeUndefined();
    expect(signal.size).toBe(0);

    const dropped = signal.arm();
    dropped.cancel();
    expect(signal.size).toBe(0);
  });

  it("waits until woken, timed out, or aborted", async () => {
    const signal = new CompletionSignal();
    const wait = signal.arm();
    const woken = untilWokenOrTimeout(wait.promise, 60_000, new AbortController().signal);
    signal.notify();
    await expect(woken).resolves.toBeUndefined();

    await expect(untilWokenOrTimeout(new Promise(() => undefined), 5, new AbortController().signal)).resolves.toBeUndefined();

    const control = new AbortController();
    const aborted = untilWokenOrTimeout(new Promise(() => undefined), 60_000, control.signal);
    control.abort(new Error("superseded"));
    await expect(aborted).rejects.toThrow("superseded");
  });
});

describe("explaining a refused result", () => {
  const failed = (message: string) => ({
    schemaVersion: "gardener.harness.outcome/v1" as const,
    harness: submission.harness,
    runId,
    requestId,
    submissionId,
    status: "failed" as const,
    error: { code: "provider-error", message, retryable: false },
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, turns: 0, toolCalls: 0, model: "" },
    events: [],
  });

  it("replaces the generic failure with the recorded refusal", async () => {
    const storage = await dispatched();
    await recordCompletionRefusal(storage, new Error("Task completion tool call id is malformed"));
    await recordCompletionRefusal(storage, new Error("a later refusal"));
    const explained = await explainRefusedCompletion(storage, failed("Flue task execution failed") as never);
    expect(explained).toMatchObject({
      status: "failed",
      error: { code: "invalid-outcome", message: "The model reported a result, but Gardener could not record it: Task completion tool call id is malformed" },
    });
  });

  it("also beats the finish hook's missing-finish message, since the model did report", async () => {
    const storage = await dispatched();
    await recordCompletionRefusal(storage, new Error("Task result needs a finish_task outcome, found none"));
    const explained = await explainRefusedCompletion(storage, failed("The model stopped without calling finish_task. It may have run out of output tokens") as never);
    expect(explained).toMatchObject({
      error: { message: "The model reported a result, but Gardener could not record it: Task result needs a finish_task outcome, found none. The model stopped without calling finish_task. It may have run out of output tokens" },
    });
  });

  it("classifies a settlement that carries the finish hook's reason", async () => {
    const storage = await dispatched();
    await recordTaskSettlement(storage, {
      runId,
      submissionId,
      outcome: "failed",
      error: "task_tool_budget_exceeded\nAgentRunError\nThe agent submission failed because of an internal error.",
    });
    const harnessOutcome = completionHarnessOutcome(submission, (await readTaskCompletion(storage))!);
    expect(await explainRefusedCompletion(storage, harnessOutcome)).toMatchObject({
      status: "failed",
      error: { code: "budget-exceeded", message: "Task tool-call limit was exceeded" },
    });
  });

  it("leaves specific failures and refusal-free runs alone", async () => {
    const storage = await dispatched();
    const generic = failed("Flue task execution failed");
    expect(await explainRefusedCompletion(storage, generic as never)).toBe(generic);
    await recordCompletionRefusal(storage, new Error("x"));
    const limit = failed("Task model-turn limit was exceeded");
    expect(await explainRefusedCompletion(storage, limit as never)).toBe(limit);
  });

  it("names only the first schema issue, bounded", async () => {
    const storage = await dispatched();
    const schemaError = Object.assign(new Error("[{...long...}]"), {
      name: "ZodError",
      issues: [{ path: ["proposedEffects", 0, "kind"], message: "Invalid option" }, { path: ["summary"], message: "Too long" }],
    });
    await recordCompletionRefusal(storage, schemaError);
    const explained = await explainRefusedCompletion(storage, failed("Flue task execution failed") as never);
    expect(explained).toMatchObject({ error: { message: "The model reported a result, but Gardener could not record it: the result is not a valid task outcome (proposedEffects.0.kind: Invalid option)" } });
    const long = await dispatched();
    await recordCompletionRefusal(long, new Error(`Task candidate ${"x".repeat(1_000)}`));
    const bounded = await explainRefusedCompletion(long, failed("Flue task execution failed") as never) as { error: { message: string } };
    expect(bounded.error.message.length).toBeLessThan(400);
  });

  it("keeps anything but the completion paths' own messages in the Worker logs", async () => {
    const storage = await dispatched();
    await recordCompletionRefusal(storage, new Error("D1_ERROR: something with /repo/path and stderr"));
    const explained = await explainRefusedCompletion(storage, failed("Flue task execution failed") as never);
    expect(explained).toMatchObject({ error: { message: "The model reported a result, but Gardener could not record it: an unexpected error (details are in the Worker logs)" } });
  });

  it("detects a wrapped schema issue list by shape", async () => {
    const storage = await dispatched();
    await recordCompletionRefusal(storage, Object.assign(new Error('[{"received":"secret model text"}]'), { issues: [{ path: ["summary"], message: "Too long" }] }));
    const explained = await explainRefusedCompletion(storage, failed("Flue task execution failed") as never) as { error: { message: string } };
    expect(explained.error.message).toContain("the result is not a valid task outcome (summary: Too long)");
    expect(explained.error.message).not.toContain("secret");
  });
});
