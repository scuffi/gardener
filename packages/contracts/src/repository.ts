import { z } from "zod";
import { githubNumericIdSchema } from "./identity";

const name = z.string().trim().min(1).max(255).regex(/^[A-Za-z0-9_.-]+$/);

/** Immutable Connect-resolved repository identity. Owner/name are display hints. */
export const repositoryRefSchema = z.object({
  provider: z.literal("github"),
  id: githubNumericIdSchema,
  installationId: githubNumericIdSchema,
  owner: name,
  name,
  defaultBranch: z.string().trim().min(1).max(255),
}).strict();
export type RepositoryRef = z.infer<typeof repositoryRefSchema>;

export const issueRefSchema = z.object({ id: githubNumericIdSchema, number: z.number().int().positive() }).strict();
export const pullRequestRefSchema = z.object({ id: githubNumericIdSchema, number: z.number().int().positive() }).strict();
export const discussionRefSchema = z.object({ id: githubNumericIdSchema, number: z.number().int().positive() }).strict();
export type IssueRef = z.infer<typeof issueRefSchema>;
export type PullRequestRef = z.infer<typeof pullRequestRefSchema>;
export type DiscussionRef = z.infer<typeof discussionRefSchema>;
