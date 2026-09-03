import { describe, expect, it } from "vitest";
import {
  normalizedIssueEventSchema,
  normalizedPullRequestEventSchema,
  operationReceiptSchema,
  operationSchema,
  runGrantSchema,
} from "../src";

const repository = { provider: "github" as const, id: "R1", installationId: "I1", owner: "acme", name: "garden" };
const headSha = "abcdef1234567890abcdef1234567890abcdef12";
const baseSha = "1234567890abcdef1234567890abcdef12345678";
const pullRevision = { expectedHeadSha: headSha, expectedBaseRef: "main", expectedBaseSha: baseSha, expectedState: "open" as const, expectedDraft: false };

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

  it("normalizes pull request events at exact revisions", () => {
    const event = normalizedPullRequestEventSchema.parse({
      schemaVersion: "v1", id: "event-pr", deliveryId: "delivery-pr", instanceId: "instance-1",
      kind: "github.pull_request", action: "synchronize", occurredAt: "2026-09-03T12:00:00.000Z",
      repository, pullRequest: { id: "pr-2", number: 2, title: "Fix", state: "open", draft: false, author: "octo", htmlUrl: "https://github.com/acme/garden/pull/2", head: { ref: "fix", sha: headSha }, base: { ref: "main", sha: baseSha } },
    });
    expect(event.pullRequest.merged).toBe(false);
    expect(event.pullRequest.head.sha).toBe(headSha);
  });

  it("requires pull request safety preconditions", () => {
    expect(() => operationSchema.parse({ schemaVersion: "v1", id: "op", kind: "pull_request.merge", repository, pullNumber: 2, ...pullRevision, method: "squash", expectedDraft: false, requiredChecks: [] })).toThrow();
    expect(() => operationSchema.parse({ schemaVersion: "v1", id: "open", kind: "pull_request.open", repository, head: "gardener/fix", base: "main", title: "Fix", body: "", draft: true })).toThrow();
    expect(operationSchema.parse({ schemaVersion: "v1", id: "close", kind: "pull_request.update", repository, pullNumber: 2, ...pullRevision, state: "closed" })).toMatchObject({ state: "closed" });
    expect(operationSchema.parse({ schemaVersion: "v1", id: "reopen", kind: "pull_request.update", repository, pullNumber: 2, ...pullRevision, expectedState: "closed", state: "open" })).toMatchObject({ state: "open" });
    expect(() => operationSchema.parse({ schemaVersion: "v1", id: "empty", kind: "pull_request.update", repository, pullNumber: 2, ...pullRevision })).toThrow(/at least one change/);
    expect(operationSchema.parse({ schemaVersion: "v1", id: "approve", kind: "pull_request.review.submit", repository, pullNumber: 2, ...pullRevision, event: "approve" })).toMatchObject({ body: "" });
    expect(() => operationSchema.parse({ schemaVersion: "v1", id: "comment", kind: "pull_request.review.submit", repository, pullNumber: 2, ...pullRevision, event: "comment", body: "  " })).toThrow(/require a body/);
    expect(() => operationSchema.parse({ schemaVersion: "v1", id: "changes", kind: "pull_request.review.submit", repository, pullNumber: 2, ...pullRevision, event: "request_changes" })).toThrow(/require a body/);
    expect(operationSchema.parse({ schemaVersion: "v1", id: "changes-ok", kind: "pull_request.review.submit", repository, pullNumber: 2, ...pullRevision, event: "request_changes", body: "Please add a test." })).toMatchObject({ event: "request_changes" });
    expect(() => operationSchema.parse({ schemaVersion: "v1", id: "duplicate", kind: "commit.create", repository, branch: "gardener/fix", expectedHeadSha: headSha, message: "Fix", files: [{ path: "README.md", content: "one" }, { path: "README.md", content: "two" }] })).toThrow(/unique/);
    expect(() => operationSchema.parse({ schemaVersion: "v1", id: "short-sha", kind: "branch.create", repository, branch: "gardener/fix", fromSha: "abcdef1" })).toThrow();
    expect(() => operationSchema.parse({ schemaVersion: "v1", id: "bad-ref", kind: "branch.create", repository, branch: "fix/.hidden", fromSha: headSha })).toThrow(/branch name/);
    expect(() => operationSchema.parse({ schemaVersion: "v1", id: "marker", kind: "issue.comment.create", repository, issueNumber: 2, expectedIssueState: "open", body: "<!-- gardener-operation:spoof -->" })).toThrow(/reserved/);
    expect(() => operationSchema.parse({ schemaVersion: "v1", id: "trailer", kind: "commit.create", repository, branch: "gardener/fix", expectedHeadSha: headSha, message: "Fix\n\nGardener-Operation: spoof", files: [{ path: "README.md", content: "fixed" }] })).toThrow(/reserved/);
  });

  it("validates grant lifetimes and receipt consistency", () => {
    const grant = { schemaVersion: "v1", id: "g", instanceId: "i", runId: "r", eventId: "e", repository, scopes: [{ kind: "repository.read" }], issuedAt: "2026-09-02T13:00:00.000Z", expiresAt: "2026-09-02T12:00:00.000Z", nonce: "0123456789abcdef" };
    expect(() => runGrantSchema.parse(grant)).toThrow(/expire/);
    expect(() => operationReceiptSchema.parse({ schemaVersion: "v1", operationId: "op", kind: "issue.close", status: "failed", attemptedAt: "2026-09-02T12:00:00.000Z", completedAt: "2026-09-02T12:00:01.000Z" })).toThrow(/error/);
  });
});
