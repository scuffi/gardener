import { operationSchema, type Operation } from "@gardener/contracts";

function preview(value: string, limit = 180): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
}

function shortSha(value: string): string { return value.slice(0, 12); }
function pathPreview(value: string): string { return preview(value, 90); }

/** A bounded, exhaustive summary of the exact typed operation awaiting approval. */
export function operationDetail(input: unknown): string {
  const parsed = operationSchema.safeParse(input);
  if (!parsed.success) return "This stored operation is invalid and cannot be approved.";
  const operation: Operation = parsed.data;
  switch (operation.kind) {
    case "issue.label.add": return `Add label “${operation.label}” to issue #${operation.issueNumber}.`;
    case "issue.label.remove": return `Remove label “${operation.label}” from issue #${operation.issueNumber}.`;
    case "issue.comment.create": return `Post on issue #${operation.issueNumber}: “${preview(operation.body)}”`;
    case "issue.comment.update": return `Edit Gardener comment ${operation.commentId} on issue #${operation.issueNumber}: “${preview(operation.body)}”`;
    case "issue.close": return `Close issue #${operation.issueNumber}.`;
    case "issue.reopen": return `Reopen issue #${operation.issueNumber}.`;
    case "branch.create": return `Create branch ${preview(operation.branch, 120)} from ${shortSha(operation.fromSha)}.`;
    case "commit.create": {
      const changes = operation.files.map((file) => `${file.content === null ? "delete" : "write"} ${pathPreview(file.path)}`);
      const visible = changes.slice(0, 6);
      return `Commit “${preview(operation.message, 100)}” to ${preview(operation.branch, 120)} at ${shortSha(operation.expectedHeadSha)}.\n${visible.join("\n")}${changes.length > visible.length ? `\n…and ${changes.length - visible.length} more files` : ""}`;
    }
    case "pull_request.open": return `Open ${operation.draft ? "draft " : ""}pull request “${preview(operation.title, 120)}” from ${preview(operation.head, 100)} at ${shortSha(operation.expectedHeadSha)} into ${preview(operation.base, 100)} at ${shortSha(operation.expectedBaseSha)}.${operation.body ? `\nDescription: “${preview(operation.body)}”` : ""}`;
    case "pull_request.update": {
      const changes = [
        operation.title === undefined ? null : `Title: “${preview(operation.title, 120)}”`,
        operation.body === undefined ? null : `Description: “${preview(operation.body)}”`,
        operation.draft === undefined ? null : operation.draft ? "Convert to draft." : "Mark ready for review.",
        operation.state === undefined ? null : operation.state === "closed" ? "Close the pull request." : "Reopen the pull request.",
      ].filter((change): change is string => change !== null);
      return `Update ${operation.expectedDraft ? "draft " : ""}${operation.expectedState} pull request #${operation.pullNumber} at head ${shortSha(operation.expectedHeadSha)}, targeting ${preview(operation.expectedBaseRef, 100)} at ${shortSha(operation.expectedBaseSha)}.\n${changes.join("\n")}`;
    }
    case "pull_request.review.submit": {
      const samples = operation.comments.slice(0, 3).map((comment) => `${pathPreview(comment.path)}:${comment.line} — “${preview(comment.body, 100)}”`);
      const remaining = operation.comments.length - samples.length;
      return `Submit a ${operation.event.replaceAll("_", " ")} review on ${operation.expectedDraft ? "draft " : ""}${operation.expectedState} pull request #${operation.pullNumber} at head ${shortSha(operation.expectedHeadSha)}, targeting ${preview(operation.expectedBaseRef, 100)} at ${shortSha(operation.expectedBaseSha)}, with ${operation.comments.length} inline ${operation.comments.length === 1 ? "comment" : "comments"}.${operation.body ? `\nReview: “${preview(operation.body)}”` : ""}${samples.length ? `\n${samples.join("\n")}${remaining ? `\n…and ${remaining} more inline comments` : ""}` : ""}`;
    }
    case "pull_request.merge": {
      const checks = operation.requiredChecks.slice(0, 6).map((check) => `${preview(check.context, 60)} (App ${check.appId})`);
      return `${operation.method} merge pull request #${operation.pullNumber} at head ${shortSha(operation.expectedHeadSha)} into ${preview(operation.expectedBaseRef, 100)} at ${shortSha(operation.expectedBaseSha)}.\nRequired checks: ${checks.join(", ")}${operation.requiredChecks.length > checks.length ? `, and ${operation.requiredChecks.length - checks.length} more` : ""}.`;
    }
  }
}
