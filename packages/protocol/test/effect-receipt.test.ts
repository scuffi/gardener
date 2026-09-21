import { describe, expect, it } from "vitest";
import { runnerEffectReceiptV1Schema } from "../src";

const receipt = {
  schemaVersion: "gardener.runner.effect-receipt/v1" as const,
  planRunId: "plan-run-1",
  bundleHash: "a".repeat(64),
  artifactSha256: "b".repeat(64),
  operationId: "operation-1",
  kind: "issue.comment.create" as const,
  commentId: "5733064172",
  commentUrl: "https://github.com/owner/repository/issues/12#issuecomment-5733064172",
};

describe("effect receipt links", () => {
  it("accepts only HTTPS github.com receipt URLs", () => {
    expect(runnerEffectReceiptV1Schema.parse(receipt)).toEqual(receipt);
    expect(() => runnerEffectReceiptV1Schema.parse({
      ...receipt,
      commentUrl: "javascript:alert(1)",
    })).toThrow();
    expect(() => runnerEffectReceiptV1Schema.parse({
      ...receipt,
      commentUrl: "https://github.example.com/owner/repository/issues/12",
    })).toThrow();
  });
});
