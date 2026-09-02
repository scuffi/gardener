import { z } from "zod";
import { repositoryRefSchema } from "./repository";

export const issueResourceSchema = z.object({
  id: z.string().min(1),
  number: z.number().int().positive(),
  title: z.string().max(1_024),
  body: z.string().max(65_536).nullable().default(null),
  state: z.enum(["open", "closed"]),
  labels: z.array(z.string().min(1).max(100)).max(100).default([]),
  author: z.string().min(1).max(255),
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
  issue: issueResourceSchema,
}).strict();

export const connectEventSchema = normalizedIssueEventSchema;
export const normalizedEventSchema = normalizedIssueEventSchema;
export type NormalizedIssueEvent = z.infer<typeof normalizedIssueEventSchema>;
export type ConnectEvent = NormalizedIssueEvent;
export type NormalizedEvent = NormalizedIssueEvent;
