import { z } from "zod";
import { gardenerPrincipalSchema, githubIdentitySchema } from "./identity";
import { repositoryRefSchema } from "./repository";

const id = z.string().min(1).max(255);
const text = z.string().max(65_536);
const sha = z.string().regex(/^[a-fA-F0-9]{40}$/);
const labels = z.array(z.string().trim().min(1).max(100)).max(100).default([]);

export const repositoryEventKindValues = [
  "github.issue", "github.pull_request", "github.issue_comment", "github.pull_request_comment",
  "github.pull_request_review", "github.pull_request_review_comment", "github.discussion",
  "github.discussion_comment", "github.check_run", "github.check_suite", "github.push",
  "github.release", "gardener.manual", "gardener.scheduled",
] as const;
export const repositoryEventKindSchema = z.enum(repositoryEventKindValues);
export type RepositoryEventKind = z.infer<typeof repositoryEventKindSchema>;

export const issueEventActions = ["opened", "edited", "reopened", "closed", "labeled", "unlabeled", "assigned", "unassigned", "milestoned", "demilestoned", "locked", "unlocked", "typed", "untyped", "transferred", "deleted", "pinned", "unpinned"] as const;
export const pullRequestEventActions = ["opened", "edited", "reopened", "closed", "synchronize", "ready_for_review", "converted_to_draft", "labeled", "unlabeled", "assigned", "unassigned", "milestoned", "demilestoned", "locked", "unlocked", "enqueued", "dequeued", "review_requested", "review_request_removed", "auto_merge_enabled", "auto_merge_disabled"] as const;
export const commentEventActions = ["created", "edited", "deleted"] as const;
export const reviewEventActions = ["submitted", "edited", "dismissed"] as const;
export const discussionEventActions = ["created", "edited", "deleted", "transferred", "pinned", "unpinned", "locked", "unlocked", "category_changed", "labeled", "unlabeled", "answered", "unanswered"] as const;
export const checkRunEventActions = ["created", "rerequested", "completed", "requested_action"] as const;
export const checkSuiteEventActions = ["requested", "rerequested", "completed"] as const;
export const pushEventActions = ["pushed"] as const;
export const releaseEventActions = ["created", "edited", "deleted", "published", "unpublished", "prereleased", "released"] as const;
export const manualEventActions = ["requested"] as const;
export const scheduledEventActions = ["triggered"] as const;

export const issueEventActionSchema = z.enum(issueEventActions);
export const pullRequestEventActionSchema = z.enum(pullRequestEventActions);
export const commentEventActionSchema = z.enum(commentEventActions);
export const reviewEventActionSchema = z.enum(reviewEventActions);
export const discussionEventActionSchema = z.enum(discussionEventActions);
export const checkRunEventActionSchema = z.enum(checkRunEventActions);
export const checkSuiteEventActionSchema = z.enum(checkSuiteEventActions);
export const releaseEventActionSchema = z.enum(releaseEventActions);

export const issueResourceV2Schema = z.object({
  id, number: z.number().int().positive(), title: z.string().max(1_024), body: text.nullable(),
  state: z.enum(["open", "closed"]), labels, locked: z.boolean(), updatedAt: z.iso.datetime(), htmlUrl: z.url(),
}).strict();
export type IssueResourceV2 = z.infer<typeof issueResourceV2Schema>;

export const pullRequestResourceV2Schema = z.object({
  id, number: z.number().int().positive(), title: z.string().max(1_024), body: text.nullable(),
  state: z.enum(["open", "closed"]), draft: z.boolean(), merged: z.boolean(), labels,
  head: z.object({ ref: z.string().min(1).max(255), sha }).strict(),
  base: z.object({ ref: z.string().min(1).max(255), sha }).strict(),
  updatedAt: z.iso.datetime(), htmlUrl: z.url(),
}).strict();
export type PullRequestResourceV2 = z.infer<typeof pullRequestResourceV2Schema>;

export const commentResourceV2Schema = z.object({ id, body: text, updatedAt: z.iso.datetime(), htmlUrl: z.url() }).strict();
export const reviewResourceV2Schema = z.object({ id, state: z.enum(["pending", "commented", "approved", "changes_requested", "dismissed"]), body: text, submittedAt: z.iso.datetime().nullable(), commitSha: sha }).strict();
export const reviewCommentResourceV2Schema = commentResourceV2Schema.extend({ path: z.string().min(1).max(1_024), line: z.number().int().positive().nullable(), commitSha: sha }).strict();
export const discussionResourceV2Schema = z.object({ id, number: z.number().int().positive(), title: z.string().max(1_024), body: text, state: z.enum(["open", "closed"]), answered: z.boolean(), labels, updatedAt: z.iso.datetime(), htmlUrl: z.url() }).strict();
export const checkRunResourceV2Schema = z.object({ id, name: z.string().min(1).max(255), headSha: sha, status: z.enum(["queued", "in_progress", "completed", "waiting", "pending"]), conclusion: z.enum(["action_required", "cancelled", "failure", "neutral", "skipped", "stale", "startup_failure", "success", "timed_out"]).nullable(), detailsUrl: z.url().nullable() }).strict();
export const checkSuiteResourceV2Schema = z.object({ id, headSha: sha, status: z.enum(["queued", "in_progress", "completed", "waiting", "pending"]), conclusion: z.string().min(1).max(100).nullable() }).strict();
export const pushResourceV2Schema = z.object({ ref: z.string().min(1).max(255), before: sha, after: sha, forced: z.boolean(), created: z.boolean(), deleted: z.boolean(), commitCount: z.number().int().nonnegative().max(10_000) }).strict();
export const releaseResourceV2Schema = z.object({ id, tagName: z.string().min(1).max(255), targetCommitish: z.string().min(1).max(255), name: z.string().max(255).nullable(), body: text.nullable(), draft: z.boolean(), prerelease: z.boolean(), publishedAt: z.iso.datetime().nullable(), updatedAt: z.iso.datetime(), htmlUrl: z.url() }).strict();

const githubEventBaseSchema = z.object({
  schemaVersion: z.literal("v2"), id, deliveryId: id, instanceId: id, occurredAt: z.iso.datetime(),
  repository: repositoryRefSchema, actor: githubIdentitySchema, resourceAuthor: githubIdentitySchema.nullable(),
});

const githubEventSchemas = [
  githubEventBaseSchema.extend({ kind: z.literal("github.issue"), action: issueEventActionSchema, issue: issueResourceV2Schema }).strict(),
  githubEventBaseSchema.extend({ kind: z.literal("github.pull_request"), action: pullRequestEventActionSchema, pullRequest: pullRequestResourceV2Schema }).strict(),
  githubEventBaseSchema.extend({ kind: z.literal("github.issue_comment"), action: commentEventActionSchema, issue: issueResourceV2Schema, comment: commentResourceV2Schema }).strict(),
  githubEventBaseSchema.extend({ kind: z.literal("github.pull_request_comment"), action: commentEventActionSchema, pullRequest: pullRequestResourceV2Schema, comment: commentResourceV2Schema }).strict(),
  githubEventBaseSchema.extend({ kind: z.literal("github.pull_request_review"), action: reviewEventActionSchema, pullRequest: pullRequestResourceV2Schema, review: reviewResourceV2Schema }).strict(),
  githubEventBaseSchema.extend({ kind: z.literal("github.pull_request_review_comment"), action: commentEventActionSchema, pullRequest: pullRequestResourceV2Schema, comment: reviewCommentResourceV2Schema }).strict(),
  githubEventBaseSchema.extend({ kind: z.literal("github.discussion"), action: discussionEventActionSchema, discussion: discussionResourceV2Schema }).strict(),
  githubEventBaseSchema.extend({ kind: z.literal("github.discussion_comment"), action: commentEventActionSchema, discussion: discussionResourceV2Schema, comment: commentResourceV2Schema }).strict(),
  githubEventBaseSchema.extend({ kind: z.literal("github.check_run"), action: checkRunEventActionSchema, checkRun: checkRunResourceV2Schema }).strict(),
  githubEventBaseSchema.extend({ kind: z.literal("github.check_suite"), action: checkSuiteEventActionSchema, checkSuite: checkSuiteResourceV2Schema }).strict(),
  githubEventBaseSchema.extend({ kind: z.literal("github.push"), action: z.literal("pushed"), push: pushResourceV2Schema }).strict(),
  githubEventBaseSchema.extend({ kind: z.literal("github.release"), action: releaseEventActionSchema, release: releaseResourceV2Schema }).strict(),
] as const;

const gardenerEventBaseSchema = z.object({
  schemaVersion: z.literal("v2"), id, instanceId: id, occurredAt: z.iso.datetime(), repository: repositoryRefSchema,
  actor: gardenerPrincipalSchema, resourceAuthor: z.null(),
});
const manualEventSchema = gardenerEventBaseSchema.extend({ kind: z.literal("gardener.manual"), action: z.literal("requested"), requestId: id, prompt: z.string().trim().min(1).max(20_000) }).strict();
const scheduledEventSchema = gardenerEventBaseSchema.extend({ kind: z.literal("gardener.scheduled"), action: z.literal("triggered"), scheduleId: id, scheduledFor: z.iso.datetime() }).strict();

export const repositoryEventV2Schema = z.discriminatedUnion("kind", [...githubEventSchemas, manualEventSchema, scheduledEventSchema]);
export type RepositoryEventV2 = z.infer<typeof repositoryEventV2Schema>;

const triggerSelectors = [
  ...issueEventActions.map((action) => `github.issue.${action}`),
  ...pullRequestEventActions.map((action) => `github.pull_request.${action}`),
  ...commentEventActions.flatMap((action) => [`github.issue_comment.${action}`, `github.pull_request_comment.${action}`, `github.pull_request_review_comment.${action}`, `github.discussion_comment.${action}`]),
  ...reviewEventActions.map((action) => `github.pull_request_review.${action}`),
  ...discussionEventActions.map((action) => `github.discussion.${action}`),
  ...checkRunEventActions.map((action) => `github.check_run.${action}`),
  ...checkSuiteEventActions.map((action) => `github.check_suite.${action}`),
  "github.push.pushed",
  ...releaseEventActions.map((action) => `github.release.${action}`),
  "gardener.manual.requested", "gardener.scheduled.triggered",
] as const;
export const repositoryEventTriggerValues = triggerSelectors;
export const repositoryEventTriggerSchema = z.enum(repositoryEventTriggerValues);
export type RepositoryEventTrigger = z.infer<typeof repositoryEventTriggerSchema>;

export function repositoryEventTrigger(event: RepositoryEventV2): RepositoryEventTrigger {
  return `${event.kind}.${event.action}` as RepositoryEventTrigger;
}
