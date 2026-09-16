import { z } from "zod";
import { githubNumericIdSchema } from "./identity";
import { repositoryRefSchema } from "./repository";

export const operationKindValues = [
  "issue.label.add", "issue.label.remove", "issue.comment.create", "issue.comment.update", "issue.close", "issue.reopen", "issue.assignee.add", "issue.assignee.remove",
  "pull_request.comment.create", "pull_request.comment.update", "pull_request.review.submit", "pull_request.reviewer.request", "pull_request.reviewer.remove", "pull_request.update",
  "branch.create", "commit.create", "pull_request.open_draft", "pull_request.merge",
  "discussion.comment.create", "discussion.comment.update", "discussion.answer.mark", "discussion.answer.unmark", "discussion.close", "discussion.reopen",
  "check.rerun",
  "release.create", "release.update", "release.publish", "release.delete",
] as const;
export const operationKindSchema = z.enum(operationKindValues);
export type OperationKind = z.infer<typeof operationKindSchema>;
export const operationFamilySchema = z.enum(["issue", "pull_request", "git", "discussion", "check", "release"]);
export const operationCatalogEntrySchema = z.object({ kind: operationKindSchema, family: operationFamilySchema, persistent: z.literal(true), highImpact: z.boolean() }).strict();
export type OperationCatalogEntry = z.infer<typeof operationCatalogEntrySchema>;
export const operationCatalog: readonly OperationCatalogEntry[] = Object.freeze(operationKindValues.map((kind) => operationCatalogEntrySchema.parse({
  kind,
  family: kind.startsWith("issue.") ? "issue" : kind.startsWith("pull_request.") ? "pull_request" : kind === "branch.create" || kind === "commit.create" ? "git" : kind.startsWith("discussion.") ? "discussion" : kind.startsWith("check.") ? "check" : "release",
  persistent: true,
  highImpact: kind === "pull_request.merge" || kind === "release.publish" || kind === "release.delete",
})));

export const shaSchema = z.string().regex(/^[a-fA-F0-9]{40}$/);
export function isValidGitBranchName(value: string): boolean {
  const components = value.split("/");
  return value !== "@" && !value.startsWith("/") && !value.endsWith("/") && !value.endsWith(".") &&
    !value.includes("..") && !value.includes("//") && !value.includes("@{") && !/[~^:?*[\\\x00-\x20\x7f]/.test(value) &&
    components.every((component) => component.length > 0 && !component.startsWith(".") && !component.endsWith(".") && !component.endsWith(".lock"));
}
export const branchNameSchema = z.string().trim().min(1).max(255).refine(isValidGitBranchName, "invalid Git branch name");
export const gardenerBranchNameSchema = branchNameSchema.refine((value) => value.startsWith("gardener/"), "branch must use the gardener/ namespace");

const operationIdSchema = z.string().regex(/^[A-Za-z0-9:_-]{1,255}$/);
const canonicalBase64Schema = z.string().regex(
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/][AQgw]==|[A-Za-z0-9+/]{2}[AEIMQUYcgkosw048]=)?$/,
  "expected canonical base64 content",
);
const operationBase = z.object({ schemaVersion: z.literal("v2"), id: operationIdSchema, repository: repositoryRefSchema });
const expectedTimestamp = z.iso.datetime();
const body = z.string().min(1).max(65_536);
const issueBase = operationBase.extend({ issueNumber: z.number().int().positive(), expectedIssueState: z.enum(["open", "closed"]), expectedIssueUpdatedAt: expectedTimestamp });
const pullBase = operationBase.extend({
  pullNumber: z.number().int().positive(), expectedHeadSha: shaSchema, expectedBaseRef: branchNameSchema,
  expectedBaseSha: shaSchema, expectedState: z.enum(["open", "closed"]), expectedDraft: z.boolean(), expectedPullUpdatedAt: expectedTimestamp,
});
const discussionBase = operationBase.extend({ discussionNumber: z.number().int().positive(), expectedDiscussionState: z.enum(["open", "closed"]), expectedDiscussionUpdatedAt: expectedTimestamp });
const commentUpdate = { commentId: githubNumericIdSchema, expectedCommentUpdatedAt: expectedTimestamp, body } as const;
const requiredCheckSchema = z.object({ context: z.string().trim().min(1).max(255), appId: z.number().int().positive() }).strict();

const operationOptions = [
  issueBase.extend({ kind: z.literal("issue.label.add"), label: z.string().trim().min(1).max(100) }).strict(),
  issueBase.extend({ kind: z.literal("issue.label.remove"), label: z.string().trim().min(1).max(100) }).strict(),
  issueBase.extend({ kind: z.literal("issue.comment.create"), body }).strict(),
  issueBase.extend({ kind: z.literal("issue.comment.update"), ...commentUpdate }).strict(),
  issueBase.extend({ kind: z.literal("issue.close"), expectedIssueState: z.literal("open") }).strict(),
  issueBase.extend({ kind: z.literal("issue.reopen"), expectedIssueState: z.literal("closed") }).strict(),
  issueBase.extend({ kind: z.literal("issue.assignee.add"), assigneeId: githubNumericIdSchema }).strict(),
  issueBase.extend({ kind: z.literal("issue.assignee.remove"), assigneeId: githubNumericIdSchema }).strict(),

  pullBase.extend({ kind: z.literal("pull_request.comment.create"), body }).strict(),
  pullBase.extend({ kind: z.literal("pull_request.comment.update"), ...commentUpdate }).strict(),
  pullBase.extend({
    kind: z.literal("pull_request.review.submit"), expectedState: z.literal("open"), event: z.enum(["comment", "approve", "request_changes"]),
    body: z.string().max(65_536), comments: z.array(z.object({ path: z.string().min(1).max(1_024), line: z.number().int().positive(), side: z.enum(["LEFT", "RIGHT"]), body }).strict()).max(100),
  }).strict().superRefine((value, context) => {
    if (value.event !== "approve" && !value.body.trim() && value.comments.length === 0) context.addIssue({ code: "custom", path: ["body"], message: "comment and request-changes reviews require content" });
  }),
  pullBase.extend({ kind: z.literal("pull_request.reviewer.request"), reviewerIds: z.array(githubNumericIdSchema).min(1).max(15) }).strict(),
  pullBase.extend({ kind: z.literal("pull_request.reviewer.remove"), reviewerIds: z.array(githubNumericIdSchema).min(1).max(15) }).strict(),
  pullBase.extend({ kind: z.literal("pull_request.update"), title: z.string().trim().min(1).max(256).optional(), body: z.string().max(65_536).optional(), draft: z.boolean().optional(), state: z.enum(["open", "closed"]).optional() }).strict().superRefine((value, context) => {
    if (value.title === undefined && value.body === undefined && value.draft === undefined && value.state === undefined) context.addIssue({ code: "custom", message: "pull request update requires at least one change" });
    if (value.draft !== undefined && (value.title !== undefined || value.body !== undefined || value.state !== undefined)) {
      context.addIssue({ code: "custom", message: "draft state must be updated in a separate exact operation" });
    }
  }),
  operationBase.extend({ kind: z.literal("branch.create"), branch: gardenerBranchNameSchema, fromSha: shaSchema, expectedAbsent: z.literal(true) }).strict(),
  operationBase.extend({
    kind: z.literal("commit.create"), branch: gardenerBranchNameSchema, expectedHeadSha: shaSchema, message: z.string().trim().min(1).max(1_000),
    files: z.array(z.object({ path: z.string().min(1).max(1_024).refine((path) => !path.startsWith("/") && !path.endsWith("/") && !path.includes("\\") && path.split("/").every((component) => component.length > 0 && component !== "." && component !== ".."), "invalid repository path"), contentBase64: canonicalBase64Schema.max(1_400_000).nullable() }).strict()).min(1).max(100),
  }).strict().superRefine((value, context) => {
    const paths = new Set<string>(); let encodedBytes = 0;
    value.files.forEach((file, index) => { if (paths.has(file.path)) context.addIssue({ code: "custom", path: ["files", index, "path"], message: "commit file paths must be unique" }); paths.add(file.path); encodedBytes += file.contentBase64?.length ?? 0; });
    if (encodedBytes > 7_000_000) context.addIssue({ code: "custom", path: ["files"], message: "encoded commit content exceeds the 5 MiB budget" });
  }),
  operationBase.extend({
    kind: z.literal("pull_request.open_draft"), head: gardenerBranchNameSchema, base: branchNameSchema, expectedHeadSha: shaSchema, expectedBaseSha: shaSchema,
    title: z.string().trim().min(1).max(256), body: z.string().max(65_536), draft: z.literal(true),
  }).strict(),
  pullBase.extend({
    kind: z.literal("pull_request.merge"), expectedState: z.literal("open"), expectedDraft: z.literal(false), method: z.enum(["merge", "squash", "rebase"]),
    requiredChecks: z.array(requiredCheckSchema).min(1).max(100), expectedBranchProtectionHash: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),

  discussionBase.extend({ kind: z.literal("discussion.comment.create"), body }).strict(),
  discussionBase.extend({ kind: z.literal("discussion.comment.update"), ...commentUpdate }).strict(),
  discussionBase.extend({ kind: z.literal("discussion.answer.mark"), answerCommentId: githubNumericIdSchema, expectedAnswerCommentId: githubNumericIdSchema.nullable() }).strict(),
  discussionBase.extend({ kind: z.literal("discussion.answer.unmark"), expectedAnswerCommentId: githubNumericIdSchema }).strict(),
  discussionBase.extend({ kind: z.literal("discussion.close"), expectedDiscussionState: z.literal("open") }).strict(),
  discussionBase.extend({ kind: z.literal("discussion.reopen"), expectedDiscussionState: z.literal("closed") }).strict(),

  operationBase.extend({ kind: z.literal("check.rerun"), checkRunId: githubNumericIdSchema, expectedHeadSha: shaSchema, expectedStatus: z.literal("completed"), expectedConclusion: z.string().trim().min(1).max(100).nullable() }).strict(),

  operationBase.extend({
    kind: z.literal("release.create"), tagName: z.string().trim().min(1).max(255), targetCommitSha: shaSchema, expectedTagAbsent: z.literal(true),
    name: z.string().trim().min(1).max(255), body: z.string().max(65_536), draft: z.literal(true), prerelease: z.boolean(),
  }).strict(),
  operationBase.extend({
    kind: z.literal("release.update"), releaseId: githubNumericIdSchema, expectedTagName: z.string().min(1).max(255), expectedTargetCommitSha: shaSchema, expectedDraft: z.boolean(), expectedPrerelease: z.boolean(), expectedReleaseUpdatedAt: expectedTimestamp,
    name: z.string().trim().min(1).max(255).optional(), body: z.string().max(65_536).optional(), prerelease: z.boolean().optional(),
  }).strict().superRefine((value, context) => { if (value.name === undefined && value.body === undefined && value.prerelease === undefined) context.addIssue({ code: "custom", message: "release update requires at least one change" }); }),
  operationBase.extend({ kind: z.literal("release.publish"), releaseId: githubNumericIdSchema, expectedTagName: z.string().min(1).max(255), expectedTargetCommitSha: shaSchema, expectedDraft: z.literal(true), expectedPrerelease: z.boolean(), expectedPublished: z.literal(false), expectedReleaseUpdatedAt: expectedTimestamp }).strict(),
  operationBase.extend({ kind: z.literal("release.delete"), releaseId: githubNumericIdSchema, expectedTagName: z.string().min(1).max(255), expectedTargetCommitSha: shaSchema, expectedDraft: z.boolean(), expectedPublished: z.boolean(), expectedReleaseUpdatedAt: expectedTimestamp }).strict(),
] as const;

const reservedMarker = /(?:<!--\s*gardener-operation:|gardener-operation:|gardener-idempotency:)/i;
function collectStrings(value: unknown, output: string[]): void {
  if (typeof value === "string") output.push(value);
  else if (Array.isArray(value)) value.forEach((item) => collectStrings(item, output));
  else if (value && typeof value === "object") Object.values(value).forEach((item) => collectStrings(item, output));
}

export const operationSchema = z.discriminatedUnion("kind", operationOptions).superRefine((operation, context) => {
  const strings: string[] = [];
  if (
    operation.kind === "issue.comment.create" ||
    operation.kind === "pull_request.review.submit" ||
    operation.kind === "pull_request.open_draft"
  ) {
    const marker = `<!-- gardener-operation:${operation.id} -->`;
    const bodyWithoutExactMarker = operation.body === marker
      ? ""
      : operation.body.endsWith(`\n${marker}`)
        ? operation.body.slice(0, -(marker.length + 1))
        : operation.body;
    collectStrings({ ...operation, body: bodyWithoutExactMarker }, strings);
  } else {
    collectStrings(operation, strings);
  }
  if (strings.some((value) => reservedMarker.test(value))) context.addIssue({ code: "custom", message: "operation contains a reserved idempotency marker" });
  if ((operation.kind === "pull_request.reviewer.request" || operation.kind === "pull_request.reviewer.remove") && new Set(operation.reviewerIds).size !== operation.reviewerIds.length) context.addIssue({ code: "custom", path: ["reviewerIds"], message: "reviewer IDs must be unique" });
  if (operation.kind === "pull_request.merge") {
    const checks = operation.requiredChecks.map((check) => `${check.appId}:${check.context}`);
    if (new Set(checks).size !== checks.length) context.addIssue({ code: "custom", path: ["requiredChecks"], message: "required checks must be unique" });
  }
});
export type Operation = z.infer<typeof operationSchema>;

export const operationReceiptSchema = z.object({
  schemaVersion: z.literal("v2"), operationId: operationIdSchema, operationHash: z.string().regex(/^[a-f0-9]{64}$/), kind: operationKindSchema,
  status: z.enum(["succeeded", "failed", "skipped", "conflicted"]), attempt: z.number().int().positive().max(20), attemptedAt: z.iso.datetime(), completedAt: z.iso.datetime(),
  providerRequestId: z.string().min(1).max(255).optional(), resourceUrl: z.url().optional(),
  error: z.object({ code: z.string().min(1).max(100), message: z.string().min(1).max(2_000), retryable: z.boolean() }).strict().optional(),
}).strict().superRefine((receipt, context) => {
  if (Date.parse(receipt.completedAt) < Date.parse(receipt.attemptedAt)) context.addIssue({ code: "custom", path: ["completedAt"], message: "operation cannot complete before it was attempted" });
  if ((receipt.status === "failed" || receipt.status === "conflicted") && !receipt.error) context.addIssue({ code: "custom", path: ["error"], message: "failed and conflicted receipts require an error" });
  if ((receipt.status === "succeeded" || receipt.status === "skipped") && receipt.error) context.addIssue({ code: "custom", path: ["error"], message: "successful receipts cannot contain an error" });
});
export type OperationReceipt = z.infer<typeof operationReceiptSchema>;
