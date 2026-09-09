import { describe, expect, it } from "vitest";
import {
  agentRunV1Schema,
  agentSourceV1Schema,
  capabilityCatalog,
  inboxItemSchema,
  interruptionSchema,
  operationKindValues,
  operationReceiptSchema,
  operationSchema,
  repositoryEventKindValues,
  repositoryEventTriggerSchema,
  repositoryEventV2Schema,
  requestedCapabilitySetSchema,
  runGrantV2Schema,
} from "../src";

const sha = "a".repeat(40);
const hash = "b".repeat(64);
const now = "2026-09-09T10:00:00.000Z";
const repository = { provider: "github", id: "1318443351", installationId: "158557952", owner: "scuffi", name: "flue", defaultBranch: "main" } as const;
const actor = { id: "100", login: "actor", accountType: "User" } as const;
const author = { id: "200", login: "author", accountType: "User" } as const;
const base = { schemaVersion: "v2", id: "op:1", repository } as const;
const issueBase = { ...base, issueNumber: 2, expectedIssueState: "open", expectedIssueUpdatedAt: now } as const;
const pullBase = { ...base, pullNumber: 3, expectedHeadSha: sha, expectedBaseRef: "main", expectedBaseSha: sha, expectedState: "open", expectedDraft: false, expectedPullUpdatedAt: now } as const;
const discussionBase = { ...base, discussionNumber: 4, expectedDiscussionState: "open", expectedDiscussionUpdatedAt: now } as const;

function operationFixture(kind: typeof operationKindValues[number]): Record<string, unknown> {
  switch (kind) {
    case "issue.label.add": case "issue.label.remove": return { ...issueBase, kind, label: "bug" };
    case "issue.comment.create": return { ...issueBase, kind, body: "Please add reproduction steps." };
    case "issue.comment.update": return { ...issueBase, kind, commentId: "44", expectedCommentUpdatedAt: now, body: "Updated" };
    case "issue.close": return { ...issueBase, kind };
    case "issue.reopen": return { ...issueBase, kind, expectedIssueState: "closed" };
    case "issue.assignee.add": case "issue.assignee.remove": return { ...issueBase, kind, assigneeId: "42" };
    case "pull_request.comment.create": return { ...pullBase, kind, body: "Looks good." };
    case "pull_request.comment.update": return { ...pullBase, kind, commentId: "44", expectedCommentUpdatedAt: now, body: "Updated" };
    case "pull_request.review.submit": return { ...pullBase, kind, event: "approve", body: "", comments: [] };
    case "pull_request.reviewer.request": case "pull_request.reviewer.remove": return { ...pullBase, kind, reviewerIds: ["42"] };
    case "pull_request.update": return { ...pullBase, kind, title: "New title" };
    case "branch.create": return { ...base, kind, branch: "gardener/fix-2", fromSha: sha, expectedAbsent: true };
    case "commit.create": return { ...base, kind, branch: "gardener/fix-2", expectedHeadSha: sha, message: "Fix issue", files: [{ path: "src/a.ts", contentBase64: "aGVsbG8=" }] };
    case "pull_request.open_draft": return { ...base, kind, head: "gardener/fix-2", base: "main", expectedHeadSha: sha, expectedBaseSha: sha, title: "Fix", body: "", draft: true };
    case "pull_request.merge": return { ...pullBase, kind, method: "squash", requiredChecks: [{ context: "test", appId: 1 }], expectedBranchProtectionHash: hash };
    case "discussion.comment.create": return { ...discussionBase, kind, body: "Thanks." };
    case "discussion.comment.update": return { ...discussionBase, kind, commentId: "44", expectedCommentUpdatedAt: now, body: "Updated" };
    case "discussion.answer.mark": return { ...discussionBase, kind, answerCommentId: "44", expectedAnswerCommentId: null };
    case "discussion.answer.unmark": return { ...discussionBase, kind, expectedAnswerCommentId: "44" };
    case "discussion.close": return { ...discussionBase, kind };
    case "discussion.reopen": return { ...discussionBase, kind, expectedDiscussionState: "closed" };
    case "check.rerun": return { ...base, kind, checkRunId: "44", expectedHeadSha: sha, expectedStatus: "completed", expectedConclusion: "failure" };
    case "release.create": return { ...base, kind, tagName: "v1.0.0", targetCommitSha: sha, expectedTagAbsent: true, name: "v1", body: "Notes", draft: true, prerelease: false };
    case "release.update": return { ...base, kind, releaseId: "44", expectedTagName: "v1.0.0", expectedTargetCommitSha: sha, expectedDraft: true, expectedPrerelease: false, expectedReleaseUpdatedAt: now, body: "New notes" };
    case "release.publish": return { ...base, kind, releaseId: "44", expectedTagName: "v1.0.0", expectedTargetCommitSha: sha, expectedDraft: true, expectedPrerelease: false, expectedPublished: false, expectedReleaseUpdatedAt: now };
    case "release.delete": return { ...base, kind, releaseId: "44", expectedTagName: "v1.0.0", expectedTargetCommitSha: sha, expectedDraft: true, expectedPublished: false, expectedReleaseUpdatedAt: now };
  }
}

const issue = { id: "301", number: 2, title: "Bug", body: "body", state: "open", labels: ["bug"], locked: false, updatedAt: now, htmlUrl: "https://github.com/scuffi/flue/issues/2" } as const;
const pullRequest = { id: "302", number: 3, title: "PR", body: "body", state: "open", draft: false, merged: false, labels: [], head: { ref: "topic", sha }, base: { ref: "main", sha }, updatedAt: now, htmlUrl: "https://github.com/scuffi/flue/pull/3" } as const;
const comment = { id: "303", body: "comment", updatedAt: now, htmlUrl: "https://github.com/x" } as const;
const discussion = { id: "304", number: 4, title: "D", body: "body", state: "open", answered: false, labels: [], updatedAt: now, htmlUrl: "https://github.com/x" } as const;
function eventFixture(kind: typeof repositoryEventKindValues[number]): Record<string, unknown> {
  const common = { schemaVersion: "v2", id: `event:${kind}`, instanceId: "instance:1", occurredAt: now, repository, actor, resourceAuthor: author };
  const github = { ...common, deliveryId: "delivery:1" };
  switch (kind) {
    case "github.issue": return { ...github, kind, action: "opened", issue };
    case "github.pull_request": return { ...github, kind, action: "opened", pullRequest };
    case "github.issue_comment": return { ...github, kind, action: "created", issue, comment };
    case "github.pull_request_comment": return { ...github, kind, action: "created", pullRequest, comment };
    case "github.pull_request_review": return { ...github, kind, action: "submitted", pullRequest, review: { id: "305", state: "approved", body: "", submittedAt: now, commitSha: sha } };
    case "github.pull_request_review_comment": return { ...github, kind, action: "created", pullRequest, comment: { ...comment, path: "src/a.ts", line: 1, commitSha: sha } };
    case "github.discussion": return { ...github, kind, action: "created", discussion };
    case "github.discussion_comment": return { ...github, kind, action: "created", discussion, comment };
    case "github.check_run": return { ...github, kind, action: "completed", resourceAuthor: null, checkRun: { id: "306", name: "test", headSha: sha, status: "completed", conclusion: "success", detailsUrl: null } };
    case "github.check_suite": return { ...github, kind, action: "completed", resourceAuthor: null, checkSuite: { id: "307", headSha: sha, status: "completed", conclusion: "success" } };
    case "github.push": return { ...github, kind, action: "pushed", push: { ref: "refs/heads/main", before: sha, after: sha, forced: false, created: false, deleted: false, commitCount: 1 } };
    case "github.release": return { ...github, kind, action: "created", release: { id: "308", tagName: "v1", targetCommitish: "main", name: "v1", body: "", draft: true, prerelease: false, publishedAt: null, updatedAt: now, htmlUrl: "https://github.com/x" } };
    case "gardener.manual": return { ...common, kind, action: "requested", actor: { kind: "owner", id: "owner:1" }, resourceAuthor: null, requestId: "request:1", prompt: "Inspect this repository" };
    case "gardener.scheduled": return { ...common, kind, action: "triggered", actor: { kind: "system", id: "system:1" }, resourceAuthor: null, scheduleId: "schedule:1", scheduledFor: now };
  }
}

describe("Agent-native contracts", () => {
  it("accepts every bounded operation family", () => {
    for (const kind of operationKindValues) expect(operationSchema.parse(operationFixture(kind)).kind).toBe(kind);
  });

  it("rejects credentials, unknown fields, and reserved idempotency markers", () => {
    expect(() => operationSchema.parse({ ...operationFixture("issue.comment.create"), token: "secret" })).toThrow();
    expect(() => operationSchema.parse({ ...operationFixture("issue.comment.create"), body: "<!-- gardener-operation:forged -->" })).toThrow(/reserved/i);
    expect(() => operationSchema.parse({ ...operationFixture("commit.create"), files: [{ path: "src//a.ts", contentBase64: "not base64" }] })).toThrow();
    expect(() => operationSchema.parse({ ...operationFixture("commit.create"), files: [{ path: "src/a.ts", contentBase64: "AB==" }] })).toThrow(/canonical base64/i);
  });

  it("strictly covers every RepositoryEventV2 family and preserves actor versus author", () => {
    for (const kind of repositoryEventKindValues) expect(repositoryEventV2Schema.parse(eventFixture(kind)).kind).toBe(kind);
    const parsed = repositoryEventV2Schema.parse(eventFixture("github.issue"));
    expect(parsed.actor.id).toBe("100");
    expect(parsed.resourceAuthor?.id).toBe("200");
    expect(() => repositoryEventV2Schema.parse({ ...eventFixture("github.issue"), unexpected: true })).toThrow();
    for (const trigger of ["github.issue.milestoned", "github.issue.typed", "github.pull_request.enqueued", "github.pull_request.locked", "github.discussion.category_changed"]) expect(repositoryEventTriggerSchema.parse(trigger)).toBe(trigger);
  });

  it("defaults omitted capabilities to none and rejects unknown capabilities", () => {
    expect(requestedCapabilitySetSchema.parse({})).toEqual({ observation: [], workspace: [], effects: [] });
    expect(() => requestedCapabilitySetSchema.parse({ observation: ["github.everything"], workspace: [], effects: [] })).toThrow();
    expect(capabilityCatalog.length).toBeGreaterThan(operationKindValues.length);
  });

  it("bounds exact source packages and rejects duplicate paths", () => {
    const source = { schemaVersion: "v1", agentMd: { path: "AGENT.md", mediaType: "text/markdown", bytesBase64: "LS0t" }, files: [] };
    expect(agentSourceV1Schema.parse(source)).toEqual(source);
    expect(() => agentSourceV1Schema.parse({ ...source, files: [{ path: "AGENT.md", mediaType: "text/plain", bytesBase64: "" }] })).toThrow();
    expect(() => agentSourceV1Schema.parse({ ...source, files: [{ path: "skills//review/SKILL.md", mediaType: "text/markdown", bytesBase64: "" }] })).toThrow();
    expect(() => agentSourceV1Schema.parse({ ...source, agentMd: { ...source.agentMd, bytesBase64: "AB==" } })).toThrow(/canonical base64/i);
  });

  it("enforces durable lifecycle chronology", () => {
    const budgetUsage = { turns: 0, toolCalls: 0, tasksCreated: 1, activeParallelTasks: 1, inputTokens: 0, outputTokens: 0, costUsd: 0, operations: 0, artifactBytes: 0, runtimeSeconds: 0 };
    expect(() => agentRunV1Schema.parse({ schemaVersion: "v1", id: "run:1", instanceId: "instance:1", eventId: "event:1", agentId: "agent:1", revisionId: "revision:1", snapshotHash: hash, orchestrationInstanceId: "orchestration:1", state: "succeeded", createdAt: now, startedAt: null, completedAt: now, budgetUsage, terminationReason: null, traceId: "trace:1" })).toThrow();
    expect(() => operationReceiptSchema.parse({ schemaVersion: "v2", operationId: "op:1", operationHash: hash, kind: "issue.close", status: "succeeded", attempt: 1, attemptedAt: "2026-09-09T11:00:00.000Z", completedAt: now })).toThrow(/complete before/i);
  });

  it("keeps interruptions, inbox items, and exact grants strict", () => {
    const operation = operationFixture("issue.comment.create");
    const pending = { schemaVersion: "v1", id: "i:1", runId: "r:1", taskId: "t:1", stepId: "s:1", kind: "effect_approval", state: "pending", eligibleResponders: [{ kind: "owner", id: "u:1" }], nonceHash: hash, createdAt: now, expiresAt: "2026-09-09T11:00:00.000Z", resolvedAt: null, operation, operationHash: hash, decision: null } as const;
    expect(interruptionSchema.parse(pending).kind).toBe("effect_approval");
    expect(() => interruptionSchema.parse({ ...pending, decision: "approve_exact" })).toThrow(/pending/i);
    expect(() => interruptionSchema.parse({ ...pending, state: "approved", decision: "approve_exact" })).toThrow(/timestamp/i);
    expect(inboxItemSchema.parse({ schemaVersion: "v1", id: "in:1", instanceId: "x:1", runId: "r:1", createdAt: now, updatedAt: now, status: "open", severity: "attention", title: "Approval", summary: "Review", kind: "interruption", interruptionId: "i:1" }).kind).toBe("interruption");
    const grantBase = { schemaVersion: "v2", id: "g:1", instanceId: "x:1", runId: "r:1", eventId: "e:1", repository, issuedAt: now, expiresAt: "2026-09-09T11:00:00.000Z", nonce: "n".repeat(32) } as const;
    expect(runGrantV2Schema.parse({ ...grantBase, scopes: [{ kind: "operation.execute", operationId: "op:1", operationKind: "issue.comment.create", operationHash: hash, interruptionId: "i:1" }] }).schemaVersion).toBe("v2");
    expect(runGrantV2Schema.parse({ ...grantBase, scopes: [{ kind: "network", capability: "workspace.network.connect", capabilityRequestId: "request:1", interruptionId: "i:1", hosts: ["registry.npmjs.org"] }] }).scopes[0]).toMatchObject({ hosts: ["registry.npmjs.org"] });
    expect(() => runGrantV2Schema.parse({ ...grantBase, scopes: [{ kind: "workspace", capabilities: ["workspace.network.connect"] }] })).toThrow();
  });
});
