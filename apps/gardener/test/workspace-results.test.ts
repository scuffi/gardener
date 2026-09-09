import { describe, expect, it } from "vitest";
import { ambiguousExecutionResult, classifyExecutionResult, truncateUtf8 } from "../src/workspace/result";

describe("Computer execution result classification", () => {
  it("bounds combined UTF-8 output without splitting a character", () => {
    const result = classifyExecutionResult({
      executionId: "exec-1",
      backend: "shell",
      maxOutputBytes: 5,
      result: {
        status: "completed",
        exitCode: 0,
        stdout: "ééé",
        stderr: "later",
        sync: { status: "complete", applied: 0, skipped: [] },
      },
    });

    expect(result.outputBytes).toBeLessThanOrEqual(5);
    expect(new TextEncoder().encode(result.stdout).byteLength).toBeLessThanOrEqual(5);
    expect(result.stdout).not.toContain("�");
    expect(result.outputTruncated).toBe(true);
  });

  it("classifies a pending sync separately and denies command re-execution", () => {
    const result = classifyExecutionResult({
      executionId: "exec-2",
      backend: "container",
      maxOutputBytes: 1024,
      result: {
        status: "completed",
        exitCode: 0,
        stdout: "tests passed",
        stderr: "",
        sync: { status: "pending", applied: 2, skipped: [], error: "pull disconnected" },
      },
    });

    expect(result.outcome).toBe("sync-pending");
    expect(result.sync).toEqual({ status: "pending", applied: 2, skipped: 0, error: "pull disconnected" });
    expect(result.replayDisposition).toBe("return-recorded");
  });

  it("does not report skipped synchronized writes as success", () => {
    const result = classifyExecutionResult({
      executionId: "exec-skipped",
      backend: "container",
      maxOutputBytes: 1024,
      result: {
        status: "completed",
        exitCode: 0,
        stdout: "",
        stderr: "",
        sync: { status: "complete", applied: 1, skipped: [{ path: "/input/file" }] },
      },
    });
    expect(result.outcome).toBe("failed");
  });

  it("marks uncertain dispatch results ambiguous and forbids automatic replay", () => {
    const result = ambiguousExecutionResult({
      executionId: "exec-3",
      backend: "javascript",
      error: new Error("connection closed after dispatch"),
    });
    expect(result).toMatchObject({
      outcome: "ambiguous",
      replayDisposition: "deny-automatic-replay",
      exitCode: null,
    });
  });

  it("omits an oversized structured value", () => {
    const result = classifyExecutionResult({
      executionId: "exec-4",
      backend: "javascript",
      maxOutputBytes: 8,
      result: {
        status: "completed",
        exitCode: 0,
        stdout: "",
        stderr: "",
        value: { value: "too-large" },
      },
    });
    expect(result.value).toBeUndefined();
    expect(result.outputTruncated).toBe(true);
  });

  it("validates byte limits", () => {
    expect(() => truncateUtf8("x", -1)).toThrow(/byte limit/);
  });
});
