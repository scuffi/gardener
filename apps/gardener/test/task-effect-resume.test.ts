import { describe, expect, it } from "vitest";
import { runnerEffectReceiptV1Schema, type RunnerEffectReceiptV1 } from "@gardener/protocol";
import { assertMonotonicReceipt } from "../src/task-runtime/effect-plan";

function operation(index: number, status: "succeeded" | "failed" = "succeeded") {
  return {
    stepName: `step-${index}`,
    outputs: status === "succeeded" ? { value: String(index) } : {},
    receipt: {
      schemaVersion: "v2" as const,
      operationId: `op_${index}`,
      operationHash: String(index).padStart(64, "0"),
      kind: "issue.comment.create",
      status,
      attempt: 1,
      attemptedAt: "2026-09-17T12:00:00.000Z",
      completedAt: "2026-09-17T12:00:01.000Z",
      ...(status === "failed" ? { error: { code: "failed", message: "failed", retryable: true } } : {}),
    },
  };
}

function receipt(
  operations: ReturnType<typeof operation>[],
  status: "running" | "applied" | "stopped",
): RunnerEffectReceiptV1 {
  return runnerEffectReceiptV1Schema.parse({
    schemaVersion: "gardener.runner.effect-receipt/v1",
    planRunId: "repo-1-run-2-attempt-1-plan",
    bundleHash: "a".repeat(64),
    artifactSha256: "b".repeat(64),
    plannedOperations: 3,
    status,
    stoppedAtStep: status === "stopped" ? operations.at(-1)?.stepName ?? null : null,
    operations,
  });
}

describe("monotonic effect receipts", () => {
  it("extends an immutable successful prefix", () => {
    const first = receipt([operation(1)], "running");
    const second = receipt([operation(1), operation(2)], "running");
    expect(() => assertMonotonicReceipt(first, second)).not.toThrow();
  });

  it("replaces only the prior halted step during resume", () => {
    const stopped = receipt([operation(1), operation(2, "failed")], "stopped");
    const resumed = receipt([operation(1), operation(2), operation(3)], "applied");
    expect(() => assertMonotonicReceipt(stopped, resumed)).not.toThrow();
  });

  it("refuses a changed successful prefix, no progress, or mutation after applied", () => {
    const first = receipt([operation(1)], "running");
    const changed = receipt([{ ...operation(1), outputs: { value: "forged" } }, operation(2)], "running");
    expect(() => assertMonotonicReceipt(first, changed)).toThrow(/changed an already completed/);
    expect(() => assertMonotonicReceipt(first, receipt([operation(1)], "running"))).toThrow(/no progress/);
    expect(() => assertMonotonicReceipt(receipt([operation(1), operation(2), operation(3)], "applied"), receipt([operation(1), operation(2), operation(3)], "applied")))
      .toThrow(/terminal/);
  });
});
