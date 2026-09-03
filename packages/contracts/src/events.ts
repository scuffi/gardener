import { z } from "zod";
import { githubIdentitySchema } from "./identity";
import { repositoryRefSchema } from "./repository";

export const issueResourceSchema = z.object({
  id: z.string().min(1),
  number: z.number().int().positive(),
  title: z.string().max(1_024),
  body: z.string().max(65_536).nullable().default(null),
  state: z.enum(["open", "closed"]),
  labels: z.array(z.string().min(1).max(100)).max(100).default([]),
  author: z.string().min(1).max(255),
  authorIdentity: githubIdentitySchema.optional(),
  htmlUrl: z.url(),
  updatedAt: z.iso.datetime().optional(),
}).strict();
export type IssueResource = z.infer<typeof issueResourceSchema>;

export const issueEventActionSchema = z.enum([
  "opened", "edited", "reopened", "closed", "labeled", "unlabeled", "assigned", "unassigned",
]);
export type IssueEventAction = z.infer<typeof issueEventActionSchema>;

/** Signed transport metadata is intentionally outside this normalized envelope. */
export const normalizedIssueEventSchema = z.object({
  schemaVersion: z.literal("v1"),
  id: z.string().min(1).max(255),
  deliveryId: z.string().min(1).max(255),
  instanceId: z.string().min(1).max(255),
  kind: z.literal("github.issue"),
  action: issueEventActionSchema,
  occurredAt: z.iso.datetime(),
  repository: repositoryRefSchema,
  actor: githubIdentitySchema.optional(),
  issue: issueResourceSchema,
}).strict();

export const pullRequestResourceSchema = z.object({
  id: z.string().min(1),
  number: z.number().int().positive(),
  title: z.string().max(1_024),
  body: z.string().max(65_536).nullable().default(null),
  state: z.enum(["open", "closed"]),
  draft: z.boolean(),
  merged: z.boolean().default(false),
  labels: z.array(z.string().min(1).max(100)).max(100).default([]),
  author: z.string().min(1).max(255),
  authorIdentity: githubIdentitySchema.optional(),
  htmlUrl: z.url(),
  head: z.object({ ref: z.string().min(1).max(255), sha: z.string().regex(/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/) }).strict(),
  base: z.object({ ref: z.string().min(1).max(255), sha: z.string().regex(/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/) }).strict(),
  updatedAt: z.iso.datetime().optional(),
}).strict();
export type PullRequestResource = z.infer<typeof pullRequestResourceSchema>;

export const pullRequestEventActionSchema = z.enum([
  "opened", "edited", "reopened", "closed", "synchronize", "ready_for_review", "converted_to_draft",
  "labeled", "unlabeled", "review_requested", "review_request_removed",
]);
export type PullRequestEventAction = z.infer<typeof pullRequestEventActionSchema>;

export const normalizedPullRequestEventSchema = z.object({
  schemaVersion: z.literal("v1"),
  id: z.string().min(1).max(255),
  deliveryId: z.string().min(1).max(255),
  instanceId: z.string().min(1).max(255),
  kind: z.literal("github.pull_request"),
  action: pullRequestEventActionSchema,
  occurredAt: z.iso.datetime(),
  repository: repositoryRefSchema,
  actor: githubIdentitySchema.optional(),
  pullRequest: pullRequestResourceSchema,
}).strict();

export const connectEventSchema = z.discriminatedUnion("kind", [normalizedIssueEventSchema, normalizedPullRequestEventSchema]);
export const normalizedEventSchema = connectEventSchema;
export type NormalizedIssueEvent = z.infer<typeof normalizedIssueEventSchema>;
export type NormalizedPullRequestEvent = z.infer<typeof normalizedPullRequestEventSchema>;
export type ConnectEvent = z.infer<typeof connectEventSchema>;
export type NormalizedEvent = ConnectEvent;
