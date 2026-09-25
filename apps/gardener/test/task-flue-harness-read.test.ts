import { beforeEach, describe, expect, it, vi } from "vitest";

const flue = vi.hoisted(() => {
  class AgentRunError extends Error {
    outcome: string;
    submissionId: string;
    constructor(options: { outcome: string; submissionId: string; cause?: unknown }) {
      super(`[flue] Agent run failed (submission ${options.submissionId}).`, options.cause === undefined ? undefined : { cause: options.cause });
      this.name = "AgentRunError";
      this.outcome = options.outcome;
      this.submissionId = options.submissionId;
    }
  }
  return { AgentRunError, read: vi.fn(), abort: vi.fn(async () => undefined) };
});

vi.mock("@flue/runtime", () => ({
  AgentRunError: flue.AgentRunError,
  init: vi.fn(() => ({ read: flue.read, abort: flue.abort })),
}));
vi.mock("../src/task-runtime/flue-agent", () => ({ GardenerTaskFlueAgent: () => "" }));

import { HARNESS_ADAPTER_VERSIONS } from "../src/harness";
import { FlueTaskHarness, SupersededReadError } from "../src/task-runtime/flue-harness";

const submission = {
  schemaVersion: "gardener.harness.submission/v1" as const,
  harness: { id: "flue" as const, adapterVersion: HARNESS_ADAPTER_VERSIONS.flue },
  runId: "repo-1-run-2-attempt-1-plan",
  requestId: "task_request_1",
  submissionId: "sub_1",
  acceptedAt: "2026-09-25T10:00:00.000Z",
};

describe("Flue task harness read", () => {
  beforeEach(() => {
    flue.read.mockReset();
    flue.abort.mockClear();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("propagates a failed wait instead of recording a failed run, so the runner reconnects", async () => {
    const depth = new Error("D1_ERROR: Subrequest depth limit exceeded.");
    flue.read.mockRejectedValue(depth);
    const failure = await new FlueTaskHarness().read(submission).then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/interrupted; reconnect to resume/);
    expect((failure as Error).cause).toBe(depth);
  });

  it("still settles a runtime-deadline abort as a failed run rather than reconnecting", async () => {
    const controller = new AbortController();
    controller.abort(new DOMException("deadline", "TimeoutError"));
    flue.read.mockRejectedValue(controller.signal.reason);
    const outcome = await new FlueTaskHarness().read(submission, { signal: controller.signal });
    expect(outcome).toMatchObject({ status: "failed", error: { message: "Task execution exceeded its runtime deadline" } });
    expect(flue.abort).toHaveBeenCalled();
  });

  it("ends a superseded wait without stopping the run a newer wait is watching", async () => {
    const controller = new AbortController();
    const superseded = new SupersededReadError();
    controller.abort(superseded);
    flue.read.mockRejectedValue(new DOMException("aborted", "AbortError"));
    const signal = AbortSignal.any([AbortSignal.timeout(60_000), controller.signal]);
    await expect(new FlueTaskHarness().read(submission, { signal })).rejects.toBe(superseded);
    expect(flue.abort).not.toHaveBeenCalled();
  });

  it("still treats a combined signal's deadline as the run deadline", async () => {
    const control = new AbortController();
    const signal = AbortSignal.any([AbortSignal.timeout(1), control.signal]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    flue.read.mockRejectedValue(signal.reason);
    const outcome = await new FlueTaskHarness().read(submission, { signal });
    expect(outcome).toMatchObject({ status: "failed", error: { message: "Task execution exceeded its runtime deadline" } });
    expect(flue.abort).toHaveBeenCalled();
  });

  it("returns a completed outcome for a settled reply", async () => {
    flue.read.mockResolvedValue({ data: { taskOutcome: [{ ok: true }] }, usage: undefined });
    const outcome = await new FlueTaskHarness().read(submission);
    expect(outcome).toMatchObject({ status: "completed", result: { data: { ok: true } } });
  });

  it("records a settled agent failure as a failed run", async () => {
    flue.read.mockRejectedValue(new flue.AgentRunError({ outcome: "failed", submissionId: "sub_1", cause: { name: "FlueError", message: "boom" } }));
    const outcome = await new FlueTaskHarness().read(submission);
    expect(outcome).toMatchObject({ status: "failed", error: { message: "Flue task execution failed" } });
  });

  it("maps a turn-limit failure delivered as Flue's serialized error", async () => {
    flue.read.mockRejectedValue(new flue.AgentRunError({
      outcome: "failed",
      submissionId: "sub_1",
      cause: {
        name: "Error",
        type: "operation_failed",
        message: "dispatch(sub_1) failed: Gardener native profile permits at most 12 model turns",
        meta: { operation: "dispatch(sub_1)", reason: "Gardener native profile permits at most 12 model turns" },
      },
    }));
    const outcome = await new FlueTaskHarness().read(submission);
    expect(outcome).toMatchObject({ status: "failed", error: { message: "Task model-turn limit was exceeded" } });
    // The log unpacks the serialized cause instead of printing [object Object].
    const logged = vi.mocked(console.error).mock.calls.find(([label]) => label === "Gardener task Flue read failed")?.[1] as { chain: { name: string; message: string }[] };
    expect(logged.chain[1]).toEqual({
      name: "Error/operation_failed",
      message: "dispatch(sub_1) failed: Gardener native profile permits at most 12 model turns",
    });
  });
});
