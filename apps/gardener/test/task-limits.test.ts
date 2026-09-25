import { describe, expect, it } from "vitest";
import {
  assertRunnerToolBudget,
  boundedTaskLimitFailure,
  classifyTaskFailure,
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
    // Flue's serialized settlement cause is a plain object.
    expect(boundedTaskLimitFailure({ message: "dispatch(x) failed: Gardener native profile permits at most 12 model turns" }))
      .toEqual({ code: "budget-exceeded", message: "Task model-turn limit was exceeded" });
    expect(boundedTaskLimitFailure({ message: 42, meta: { reason: "Gardener model runtime budget expired" } }))
      .toEqual({ code: "budget-exceeded", message: "Task model-runtime limit was exceeded" });
    expect(boundedTaskLimitFailure(new Error("outer", { cause: { message: "Gardener model output-token budget is exhausted" } })))
      .toEqual({ code: "budget-exceeded", message: "Task model-output limit was exceeded" });
    expect(boundedTaskLimitFailure({ message: "Workers AI request failed" })).toBeNull();
    expect(boundedTaskLimitFailure(null)).toBeNull();
  });

  it("explains known run failures in fixed sentences without leaking provider bodies", () => {
    const flueFailure = (message: string) => ({ name: "Error", type: "operation_failed", message, meta: { reason: message } });
    const gateway402 = flueFailure(
      "dispatch(sub_1) failed: Cloudflare AI binding request failed with 402 Payment Required: "
      + "{\"success\":false,\"error\":[{\"code\":2021,\"message\":\"Insufficient balance; add money to your gateway or use BYOK\"}],\"httpCode\":402}",
    );
    const explained = classifyTaskFailure(gateway402);
    expect(explained).toEqual({
      code: "provider-error",
      message: "AI Gateway refused the request for insufficient balance (HTTP 402). Add a provider key or credit to the account's default AI Gateway",
    });
    expect(explained!.message).not.toContain("BYOK");

    const status = (code: number) => classifyTaskFailure(flueFailure(`dispatch failed: Cloudflare AI binding request failed with ${code} X: secret body`))?.message;
    expect(status(401)).toMatch(/rejected the request \(HTTP 401\)\. Check the provider keys/);
    expect(status(404)).toMatch(/did not find the model \(HTTP 404\)/);
    expect(status(429)).toMatch(/rate-limited the request \(HTTP 429\)/);
    expect(status(503)).toBe("The model provider failed (HTTP 503)");
    expect(status(504)).toBe("The model provider timed out (HTTP 504)");
    expect(status(418)).toBe("The model provider rejected the request (HTTP 418)");
    expect(classifyTaskFailure(flueFailure('upstream said {"httpCode": 500}'))?.message).toBe("The model provider failed (HTTP 500)");

    const hook = (reason: string) => classifyTaskFailure(flueFailure(
      `dispatch(sub_1) failed: [flue] A useAgentFinish callback (hook #0 in declaration order) threw: ${reason}`,
    ));
    expect(hook("task_completed_without_terminal_outcome")).toEqual({
      code: "invalid-outcome",
      message: "The model stopped without calling finish_task. It may have run out of output tokens; consider raising output-tokens",
    });
    expect(hook("task_has_multiple_terminal_outcomes")?.message).toBe("The model called finish_task more than once");
    expect(hook("task_tool_budget_exceeded")?.message).toBe("Task tool-call limit was exceeded");
    expect(hook("task_model_token_budget_exceeded")?.message).toBe("Task model-output limit was exceeded");

    expect(classifyTaskFailure(flueFailure("A canonical conversation record violates the conversation stream contract."))).toBeNull();
    expect(classifyTaskFailure(undefined)).toBeNull();
  });

  it("computes the immutable remaining runtime and rejects malformed deadlines", () => {
    expect(remainingTaskRuntime("2026-09-21T12:05:00.000Z", Date.parse("2026-09-21T12:00:00.000Z")))
      .toBe(300_000);
    expect(remainingTaskRuntime("2026-09-21T12:00:00.000Z", Date.parse("2026-09-21T12:00:01.000Z")))
      .toBe(-1_000);
    expect(() => remainingTaskRuntime("not-a-date")).toThrow(/deadline is invalid/);
  });
});
