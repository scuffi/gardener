import { describe, expect, it } from "vitest";
import { operationDetail } from "./operation-detail";

const repository = { provider: "github", id: "9", installationId: "7", owner: "acme", name: "widgets", defaultBranch: "main" } as const;
const base = { schemaVersion: "v1", repository } as const;
const sha = "abcdef1234567890abcdef1234567890abcdef12";

const cases: Array<[string, Record<string, unknown>, string]> = [
  ["issue.label.add", { ...base, id: "1", kind: "issue.label.add", issueNumber: 4, expectedIssueState: "open", label: "bug" }, "Add label"],
  ["issue.label.remove", { ...base, id: "2", kind: "issue.label.remove", issueNumber: 4, expectedIssueState: "open", label: "bug" }, "Remove label"],
  ["issue.comment.create", { ...base, id: "3", kind: "issue.comment.create", issueNumber: 4, expectedIssueState: "open", body: "Note" }, "Post on issue"],
  ["issue.comment.update", { ...base, id: "4", kind: "issue.comment.update", issueNumber: 4, expectedIssueState: "open", commentId: "8", body: "Edit" }, "Edit Gardener comment"],
  ["issue.close", { ...base, id: "5", kind: "issue.close", issueNumber: 4, expectedIssueState: "open" }, "Close issue"],
  ["issue.reopen", { ...base, id: "6", kind: "issue.reopen", issueNumber: 4, expectedIssueState: "closed" }, "Reopen issue"],
  ["branch.create", { ...base, id: "7", kind: "branch.create", branch: "gardener/fix", fromSha: sha }, "Create branch"],
  ["commit.create", { ...base, id: "8", kind: "commit.create", branch: "gardener/fix", expectedHeadSha: sha, message: "Fix", files: [{ path: `${"nested/".repeat(30)}file.ts`, content: "changed" }] }, "write nested/"],
  ["pull_request.open", { ...base, id: "9", kind: "pull_request.open", head: "gardener/fix", base: "main", expectedHeadSha: sha, expectedBaseSha: sha, title: "Fix", body: "Details", draft: true }, "Open draft pull request"],
  ["pull_request.update", { ...base, id: "10", kind: "pull_request.update", pullNumber: 3, expectedHeadSha: sha, expectedBaseRef: "main", expectedBaseSha: sha, expectedState: "open", expectedDraft: true, title: "Updated", body: "Body", draft: false, state: "closed" }, "Mark ready for review"],
  ["pull_request.review.submit", { ...base, id: "11", kind: "pull_request.review.submit", pullNumber: 3, expectedHeadSha: sha, expectedBaseRef: "main", expectedBaseSha: sha, expectedState: "open", expectedDraft: false, event: "request_changes", body: "Please revise", comments: [{ path: `${"deep/".repeat(30)}file.ts`, line: 10, body: "This needs a focused regression test." }] }, "deep/"],
  ["pull_request.merge", { ...base, id: "12", kind: "pull_request.merge", pullNumber: 3, expectedHeadSha: sha, expectedBaseRef: "main", expectedBaseSha: sha, expectedState: "open", expectedDraft: false, method: "squash", requiredChecks: [{ context: "test", appId: 123 }] }, "Required checks"],
];

describe("operationDetail", () => {
  for (const [kind, operation, expected] of cases) {
    it(`summarizes ${kind} with bounded output`, () => {
      const detail = operationDetail(operation);
      expect(detail).toContain(expected);
      expect(detail.length).toBeLessThan(1_200);
    });
  }

  it("fails closed for malformed stored operations", () => {
    expect(operationDetail({ kind: "pull_request.merge" })).toMatch(/invalid/);
  });
});
