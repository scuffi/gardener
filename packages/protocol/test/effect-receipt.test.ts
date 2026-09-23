import { describe, expect, it } from "vitest";
import {
  EFFECT_TRANSPORT_MAX_BYTES,
  base64DecodedLength,
  runnerEffectArtifactV1Schema,
  runnerEffectReceiptV1Schema,
  runnerOperationReceiptV1Schema,
} from "../src";

const attemptedAt = "2026-09-22T10:00:00.000Z";
const completedAt = "2026-09-22T10:00:01.000Z";

function operationReceipt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "v2",
    operationId: "run:1:step:1:comment",
    operationHash: "c".repeat(64),
    kind: "issue.comment.create",
    status: "succeeded",
    attempt: 1,
    attemptedAt,
    completedAt,
    resourceUrl: "https://github.com/owner/repository/issues/12#issuecomment-5733064172",
    ...overrides,
  };
}

function planReceipt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "gardener.runner.effect-receipt/v1",
    planRunId: "plan-run-1",
    bundleHash: "a".repeat(64),
    artifactSha256: "b".repeat(64),
    plannedOperations: 1,
    status: "applied",
    stoppedAtStep: null,
    operations: [{ stepName: "comment", receipt: operationReceipt() }],
    ...overrides,
  };
}

describe("ordered plan receipts", () => {
  it("accepts an applied multi-step receipt and binds the changes artifact", () => {
    const receipt = planReceipt({
      changesSha256: "d".repeat(64),
      plannedOperations: 3,
      operations: [
        { stepName: "commit", receipt: operationReceipt({ operationId: "run:1:step:1:commit", kind: "commit.create" }) },
        { stepName: "open-draft", receipt: operationReceipt({ operationId: "run:1:step:2:draft", kind: "pull_request.open_draft" }) },
        { stepName: "comment", receipt: operationReceipt({ status: "skipped", resourceUrl: undefined }) },
      ],
    });
    expect(runnerEffectReceiptV1Schema.parse(receipt)).toEqual({
      ...receipt,
      operations: (receipt.operations as Array<Record<string, unknown>>).map((entry) => ({ outputs: {}, ...entry })),
    });
  });

  it("accepts only HTTPS github.com resource URLs", () => {
    expect(() => runnerEffectReceiptV1Schema.parse(planReceipt({
      operations: [{ stepName: "comment", receipt: operationReceipt({ resourceUrl: "javascript:alert(1)" }) }],
    }))).toThrow();
    expect(() => runnerEffectReceiptV1Schema.parse(planReceipt({
      operations: [{ stepName: "comment", receipt: operationReceipt({ resourceUrl: "https://github.example.com/owner/repository/issues/12" }) }],
    }))).toThrow();
  });

  it("rejects the superseded single-comment receipt shape", () => {
    expect(() => runnerEffectReceiptV1Schema.parse({
      schemaVersion: "gardener.runner.effect-receipt/v1",
      planRunId: "plan-run-1",
      bundleHash: "a".repeat(64),
      artifactSha256: "b".repeat(64),
      operationId: "operation-1",
      kind: "issue.comment.create",
      commentId: "5733064172",
      commentUrl: "https://github.com/owner/repository/issues/12#issuecomment-5733064172",
    })).toThrow();
  });

  it("requires a receipt to record at least one applied step", () => {
    expect(() => runnerEffectReceiptV1Schema.parse(planReceipt({ operations: [] }))).toThrow();
  });

  it("requires unique step names and operation IDs", () => {
    expect(() => runnerEffectReceiptV1Schema.parse(planReceipt({
      plannedOperations: 2,
      operations: [
        { stepName: "comment", receipt: operationReceipt() },
        { stepName: "comment", receipt: operationReceipt({ operationId: "run:1:step:2:comment" }) },
      ],
    }))).toThrow(/step names must be unique/);
    expect(() => runnerEffectReceiptV1Schema.parse(planReceipt({
      plannedOperations: 2,
      operations: [
        { stepName: "first", receipt: operationReceipt() },
        { stepName: "second", receipt: operationReceipt() },
      ],
    }))).toThrow(/operation IDs must be unique/);
  });

  it("models stop-and-resume: a halt is the last recorded step and is named", () => {
    const failure = operationReceipt({
      operationId: "run:1:step:2:merge",
      kind: "pull_request.merge",
      status: "failed",
      resourceUrl: undefined,
      error: { code: "merge_conflict", message: "base moved", retryable: false },
    });
    const stopped = planReceipt({
      status: "stopped",
      stoppedAtStep: "merge",
      plannedOperations: 5,
      operations: [
        { stepName: "comment", receipt: operationReceipt() },
        { stepName: "merge", receipt: failure },
      ],
    });
    expect(runnerEffectReceiptV1Schema.parse(stopped)).toEqual({
      ...stopped,
      operations: (stopped.operations as Array<Record<string, unknown>>).map((entry) => ({ outputs: {}, ...entry })),
    });

    expect(() => runnerEffectReceiptV1Schema.parse({ ...stopped, stoppedAtStep: "comment" }))
      .toThrow(/stoppedAtStep must name the halting step/);
    expect(() => runnerEffectReceiptV1Schema.parse({ ...stopped, status: "applied", stoppedAtStep: null }))
      .toThrow(/cannot contain a failed or conflicted step/);
    // A stopped receipt is an exact prefix: never longer than the plan.
    expect(() => runnerEffectReceiptV1Schema.parse({ ...stopped, plannedOperations: 1 }))
      .toThrow(/records 2 steps but the plan contained 1/);
    expect(() => runnerEffectReceiptV1Schema.parse({
      ...stopped,
      operations: [
        { stepName: "merge", receipt: failure },
        { stepName: "comment", receipt: operationReceipt() },
      ],
    })).toThrow(/must be the last recorded step/);
  });

  it("keeps the applied status honest about stoppedAtStep", () => {
    expect(() => runnerEffectReceiptV1Schema.parse(planReceipt({ stoppedAtStep: "comment" })))
      .toThrow(/did not stop at a step/);
  });

  it("states the transport ceiling in decoded bytes and enforces it exactly", () => {
    // Mirrored by EFFECT_TRANSPORT_MAX_BYTES in @gardener/contracts, which
    // asserts the identical literal in its own suite. Protocol has no
    // dependency on contracts, so the pair of assertions is the drift alarm.
    expect(EFFECT_TRANSPORT_MAX_BYTES).toBe(4 * 1024 * 1024);
    expect(base64DecodedLength("AAAA")).toBe(3);
    expect(base64DecodedLength("AAA=")).toBe(2);
    expect(base64DecodedLength("AA==")).toBe(1);

    const encodedCap = 4 * Math.ceil(EFFECT_TRANSPORT_MAX_BYTES / 3);
    const artifact = {
      schemaVersion: "gardener.runner.effect-artifact/v1" as const,
      sha256: "e".repeat(64),
      // Exactly EFFECT_TRANSPORT_MAX_BYTES decoded, which needs two pad chars.
      bytesBase64: `${"A".repeat(encodedCap - 2)}==`,
    };
    expect(base64DecodedLength(artifact.bytesBase64)).toBe(EFFECT_TRANSPORT_MAX_BYTES);
    expect(runnerEffectArtifactV1Schema.parse(artifact).sha256).toBe("e".repeat(64));
    expect(runnerEffectArtifactV1Schema.parse({ ...artifact, changesSha256: "f".repeat(64) }).changesSha256)
      .toBe("f".repeat(64));

    // Same string length, no padding: two bytes over the decoded ceiling.
    expect(base64DecodedLength("A".repeat(encodedCap))).toBe(EFFECT_TRANSPORT_MAX_BYTES + 2);
    expect(() => runnerEffectArtifactV1Schema.parse({ ...artifact, bytesBase64: "A".repeat(encodedCap) }))
      .toThrow(/decoded bytes/);
    // One base64 group past the encoded ceiling.
    expect(() => runnerEffectArtifactV1Schema.parse({ ...artifact, bytesBase64: `${"A".repeat(encodedCap + 2)}==` }))
      .toThrow();
    // Unpadded remainder is not a base64 string at all.
    expect(() => runnerEffectArtifactV1Schema.parse({ ...artifact, bytesBase64: "AAAAA" })).toThrow();
    for (const malformed of ["====", "A===", "=AAA", "A A=", "AA=A"]) {
      expect(() => runnerEffectArtifactV1Schema.parse({ ...artifact, bytesBase64: malformed })).toThrow();
    }
    expect(() => runnerEffectArtifactV1Schema.parse({ ...artifact, changesSha256: "not-a-digest" })).toThrow();
  });

  it("validates a multi-megabyte artifact without overflowing the regex engine", () => {
    // The grouped `(?:[A-Za-z0-9+/]{4})*` base64 pattern recurses in V8 and
    // throws RangeError at this size. Raising the artifact ceiling from 128 KiB
    // to 4 MiB is what made that reachable, so the pattern has to stay linear.
    const artifact = {
      schemaVersion: "gardener.runner.effect-artifact/v1" as const,
      sha256: "e".repeat(64),
      bytesBase64: `${"A".repeat(4 * Math.ceil(EFFECT_TRANSPORT_MAX_BYTES / 3) - 2)}==`,
    };
    expect(() => runnerEffectArtifactV1Schema.safeParse(artifact)).not.toThrow();
    expect(runnerEffectArtifactV1Schema.safeParse(artifact).success).toBe(true);
  });

  it("requires an applied receipt to account for every planned step", () => {
    expect(() => runnerEffectReceiptV1Schema.parse(planReceipt({ plannedOperations: 3 })))
      .toThrow(/must record all 3 planned steps, not 1/);
    expect(runnerEffectReceiptV1Schema.parse(planReceipt({ plannedOperations: 1 })).plannedOperations).toBe(1);
    expect(() => runnerEffectReceiptV1Schema.parse(planReceipt({ plannedOperations: 0 }))).toThrow();
  });

  it("caps receipts by shared serialized bytes rather than by step count", () => {
    const wide = Array.from({ length: 2_000 }, (_, index) => ({
      stepName: `step-${index + 1}`,
      receipt: operationReceipt({ operationId: `run:1:step:${index + 1}` }),
    }));
    // 2,000 steps is well past the removed 1,000 ceiling and is accepted.
    expect(runnerEffectReceiptV1Schema.parse(planReceipt({ plannedOperations: wide.length, operations: wide }))
      .operations).toHaveLength(2_000);

    const bloated = wide.map((entry) => ({
      ...entry,
      receipt: operationReceipt({
        operationId: entry.receipt.operationId as string,
        providerRequestId: "x".repeat(255),
      }),
    }));
    const huge = Array.from({ length: 20 }, () => bloated).flat().map((entry, index) => ({
      stepName: `step-${index + 1}`,
      receipt: { ...entry.receipt, operationId: `run:1:step:${index + 1}` },
    }));
    const bytes = new TextEncoder().encode(JSON.stringify(huge)).length;
    expect(bytes).toBeGreaterThan(EFFECT_TRANSPORT_MAX_BYTES);
    expect(() => runnerEffectReceiptV1Schema.parse(planReceipt({ plannedOperations: huge.length, operations: huge })))
      .toThrow(new RegExp(`but the transport carries at most ${EFFECT_TRANSPORT_MAX_BYTES}`));
  });

  it("holds per-operation receipts to the contracts receipt invariants", () => {
    expect(() => runnerOperationReceiptV1Schema.parse(operationReceipt({ status: "failed", resourceUrl: undefined })))
      .toThrow(/require an error/);
    expect(() => runnerOperationReceiptV1Schema.parse(operationReceipt({
      error: { code: "x", message: "y", retryable: false },
    }))).toThrow(/cannot contain an error/);
    expect(() => runnerOperationReceiptV1Schema.parse(operationReceipt({ completedAt: "2026-09-22T09:59:59.000Z" })))
      .toThrow(/cannot complete before/);
    expect(() => runnerOperationReceiptV1Schema.parse(operationReceipt({ kind: "IssueCommentCreate" }))).toThrow();
  });
});
