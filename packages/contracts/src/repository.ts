import { z } from "zod";

const identifier = z.string().trim().min(1).max(255);

/** A connector-independent, immutable reference to one GitHub repository. */
export const repositoryRefSchema = z.object({
  provider: z.literal("github").default("github"),
  id: identifier,
  installationId: identifier,
  owner: identifier.regex(/^[A-Za-z0-9_.-]+$/),
  name: identifier.regex(/^[A-Za-z0-9_.-]+$/),
  defaultBranch: z.string().trim().min(1).max(255).optional(),
}).strict();

export const repositorySchema = repositoryRefSchema;
export type RepositoryRef = z.infer<typeof repositoryRefSchema>;
export type Repository = RepositoryRef;

export const issueRefSchema = z.object({
  id: identifier,
  number: z.number().int().positive(),
}).strict();
export type IssueRef = z.infer<typeof issueRefSchema>;

export const pullRequestRefSchema = z.object({
  id: identifier,
  number: z.number().int().positive(),
}).strict();
export type PullRequestRef = z.infer<typeof pullRequestRefSchema>;
