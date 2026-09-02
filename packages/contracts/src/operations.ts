import { z } from "zod";
import { repositoryRefSchema } from "./repository";

export const operationKindSchema = z.enum([
  "issue.label.add", "issue.label.remove", "issue.comment.create", "issue.comment.update",
  "issue.close", "issue.reopen", "pull_request.review.submit", "branch.create",
  "commit.create", "pull_request.open", "pull_request.update", "pull_request.merge",
]);
export type OperationKind = z.infer<typeof operationKindSchema>;
export const issueOperationKindSchema = z.enum([
  "issue.label.add", "issue.label.remove", "issue.comment.create",
  "issue.comment.update", "issue.close", "issue.reopen",
]);
export type IssueOperationKind = z.infer<typeof issueOperationKindSchema>;

const shaSchema = z.string().regex(/^[a-fA-F0-9]{7,64}$/);
const operationBaseSchema = z.object({
  schemaVersion: z.literal("v1"),
  id: z.string().regex(/^[A-Za-z0-9:_-]{1,255}$/),
  repository: repositoryRefSchema,
});
const issueBase = operationBaseSchema.extend({
  issueNumber: z.number().int().positive(),
  expectedIssueState: z.enum(["open", "closed"]),
});
const pullBase = operationBaseSchema.extend({
  pullNumber: z.number().int().positive(),
  expectedHeadSha: shaSchema,
});
const branchName = z.string().trim().min(1).max(255);
const body = z.string().min(1).max(10_000);

export const issueOperationSchema = z.discriminatedUnion("kind", [
  issueBase.extend({ kind: z.literal("issue.label.add"), label: z.string().trim().min(1).max(100) }).strict(),
  issueBase.extend({ kind: z.literal("issue.label.remove"), label: z.string().trim().min(1).max(100) }).strict(),
  issueBase.extend({ kind: z.literal("issue.comment.create"), body }).strict(),
  issueBase.extend({ kind: z.literal("issue.comment.update"), commentId: z.string().regex(/^\d+$/), body }).strict(),
  issueBase.extend({ kind: z.literal("issue.close") }).strict(),
  issueBase.extend({ kind: z.literal("issue.reopen") }).strict(),
]);
export type IssueOperation = z.infer<typeof issueOperationSchema>;

export const operationSchema = z.discriminatedUnion("kind", [
  ...issueOperationSchema.options,
  pullBase.extend({
    kind: z.literal("pull_request.review.submit"),
    event: z.enum(["comment", "approve", "request_changes"]),
    body: z.string().max(10_000).default(""),
    comments: z.array(z.object({ path: z.string().min(1).max(1_024), line: z.number().int().positive(), body }).strict()).max(100).default([]),
  }).strict(),
  operationBaseSchema.extend({ kind: z.literal("branch.create"), branch: branchName, fromSha: shaSchema }).strict(),
  operationBaseSchema.extend({
    kind: z.literal("commit.create"), branch: branchName, expectedHeadSha: shaSchema,
    message: z.string().min(1).max(1_000),
    files: z.array(z.object({ path: z.string().min(1).max(1_024), content: z.string().max(1_000_000).nullable() }).strict()).min(1).max(100),
  }).strict(),
  operationBaseSchema.extend({
    kind: z.literal("pull_request.open"), head: branchName, base: branchName,
    title: z.string().min(1).max(256), body: z.string().max(65_536).default(""), draft: z.boolean().default(true),
  }).strict(),
  pullBase.extend({ kind: z.literal("pull_request.update"), title: z.string().min(1).max(256).optional(), body: z.string().max(65_536).optional(), draft: z.boolean().optional() }).strict(),
  pullBase.extend({
    kind: z.literal("pull_request.merge"), method: z.enum(["merge", "squash", "rebase"]),
    expectedDraft: z.literal(false), requiredChecks: z.array(z.string().min(1).max(255)).min(1).max(100),
  }).strict(),
]);
export type Operation = z.infer<typeof operationSchema>;

export const operationReceiptSchema = z.object({
  schemaVersion: z.literal("v1"),
  operationId: z.string().min(1),
  kind: operationKindSchema,
  status: z.enum(["succeeded", "failed", "skipped"]),
  attemptedAt: z.iso.datetime(),
  completedAt: z.iso.datetime(),
  providerRequestId: z.string().min(1).optional(),
  resourceUrl: z.url().optional(),
  error: z.object({ code: z.string().min(1), message: z.string().min(1).max(2_000), retryable: z.boolean() }).strict().optional(),
}).strict().superRefine((receipt, context) => {
  if (receipt.status === "failed" && !receipt.error) context.addIssue({ code: "custom", message: "failed receipts require an error", path: ["error"] });
  if (receipt.status !== "failed" && receipt.error) context.addIssue({ code: "custom", message: "only failed receipts may contain an error", path: ["error"] });
});
export type OperationReceipt = z.infer<typeof operationReceiptSchema>;
