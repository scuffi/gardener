import { describe, expect, it } from "vitest";
import {
  normalizedIssueEventSchema,
  operationReceiptSchema,
  operationSchema,
  runGrantSchema,
} from "../src";

const repository = { provider: "github" as const, id: "R1", installationId: "I1", owner: "acme", name: "garden" };

describe("v1 contracts", () => {
  it("normalizes and rejects malformed issue events", () => {
    const event = normalizedIssueEventSchema.parse({
      schemaVersion: "v1", id: "event-1", deliveryId: "delivery-1", instanceId: "instance-1",
      kind: "github.issue", action: "opened", occurredAt: "2026-09-02T12:00:00.000Z",
      repository, issue: { id: "issue-1", number: 1, title: "Broken docs", state: "open", author: "octo", htmlUrl: "https://github.com/acme/garden/issues/1" },
    });
    expect(event.issue.body).toBeNull();
    expect(() => normalizedIssueEventSchema.parse({ ...event, extra: true })).toThrow();
  });

  it("requires merge safety preconditions", () => {
    expect(() => operationSchema.parse({ schemaVersion: "v1", id: "op", kind: "pull_request.merge", repository, pullNumber: 2, expectedHeadSha: "abcdef1", method: "squash", expectedDraft: false, requiredChecks: [] })).toThrow();
  });

  it("validates grant lifetimes and receipt consistency", () => {
    const grant = { schemaVersion: "v1", id: "g", instanceId: "i", runId: "r", eventId: "e", repository, scopes: [{ kind: "repository.read" }], issuedAt: "2026-09-02T13:00:00.000Z", expiresAt: "2026-09-02T12:00:00.000Z", nonce: "0123456789abcdef" };
    expect(() => runGrantSchema.parse(grant)).toThrow(/expire/);
    expect(() => operationReceiptSchema.parse({ schemaVersion: "v1", operationId: "op", kind: "issue.close", status: "failed", attemptedAt: "2026-09-02T12:00:00.000Z", completedAt: "2026-09-02T12:00:01.000Z" })).toThrow(/error/);
  });
});
