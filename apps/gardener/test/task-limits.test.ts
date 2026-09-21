import { describe, expect, it } from "vitest";
import {
  assertRunnerToolBudget,
  boundedTaskLimitFailure,
  remainingTaskRuntime,
} from "../src/task-runtime/task-limits";

describe("Actions task hard limits", () => {
  it("reserves one tool call for terminal settlement and rejects before runner dispatch", () => {
    expect(() => assertRunnerToolBudget(3, 0)).not.toThrow();
    expect(() => assertRunnerToolBudget(3, 1)).not.toThrow();
    expect(() => assertRunnerToolBudget(3, 2)).toThrow(/budget is exhausted/);
  });

  it("reports trusted bounded-provider limit failures without exposing arbitrary provider errors", () => {
    expect(boundedTaskLimitFailure(new Error("Gardener model output-token budget is exhausted")))
      .toEqual({ code: "budget-exceeded", message: "Task model-output limit was exceeded" });
    expect(boundedTaskLimitFailure(new Error("dispatch failed", {
      cause: new Error("Flue model input exceeds its immutable 8000-byte safety limit"),
    }))).toEqual({ code: "budget-exceeded", message: "Task model-input limit was exceeded" });
    expect(boundedTaskLimitFailure(new Error("Workers AI request failed: private detail"))).toBeNull();
  });

  it("computes the immutable remaining runtime and rejects malformed deadlines", () => {
    expect(remainingTaskRuntime("2026-09-21T12:05:00.000Z", Date.parse("2026-09-21T12:00:00.000Z")))
      .toBe(300_000);
    expect(remainingTaskRuntime("2026-09-21T12:00:00.000Z", Date.parse("2026-09-21T12:00:01.000Z")))
      .toBe(-1_000);
    expect(() => remainingTaskRuntime("not-a-date")).toThrow(/deadline is invalid/);
  });
});
