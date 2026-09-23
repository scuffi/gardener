import { z } from "zod";
import { githubNumericIdSchema } from "./identity";

const name = z.string().trim().min(1).max(255).regex(/^[A-Za-z0-9_.-]+$/);

/**
 * Repository identity as embedded in an exact operation.
 *
 * `installationId` is optional here because a GitHub Actions run authenticates
 * with the workflow's own `GITHUB_TOKEN` and has no installation identity at
 * all. Synthesising one would write a fabricated value into the audit record,
 * so an Actions-planned operation simply omits it. Every boundary that mints
 * GitHub App installation tokens keeps using `repositoryRefSchema`, which still
 * requires the field.
 */
export const operationRepositoryRefSchema = z.object({
  provider: z.literal("github"),
  id: githubNumericIdSchema,
  installationId: githubNumericIdSchema.optional(),
  owner: name,
  name,
  defaultBranch: z.string().trim().min(1).max(255),
}).strict();
export type OperationRepositoryRef = z.infer<typeof operationRepositoryRefSchema>;

/**
 * Immutable provider-resolved repository identity for installation-backed
 * boundaries. Owner/name are display hints; `installationId` is required
 * because these boundaries cannot act without an installation token.
 */
export const repositoryRefSchema = operationRepositoryRefSchema.extend({
  installationId: githubNumericIdSchema,
}).strict();
export type RepositoryRef = z.infer<typeof repositoryRefSchema>;

/**
 * Narrowing guard for the installation-backed boundaries. Callers that need to
 * mint an installation token must use this instead of assuming the field is
 * populated, so a missing installation fails loudly at the boundary rather than
 * binding `undefined` into a query.
 */
export function isInstallationBackedRepository(
  repository: OperationRepositoryRef,
): repository is RepositoryRef {
  return repository.installationId !== undefined;
}

export const issueRefSchema = z.object({ id: githubNumericIdSchema, number: z.number().int().positive() }).strict();
export const pullRequestRefSchema = z.object({ id: githubNumericIdSchema, number: z.number().int().positive() }).strict();
export const discussionRefSchema = z.object({ id: githubNumericIdSchema, number: z.number().int().positive() }).strict();
export type IssueRef = z.infer<typeof issueRefSchema>;
export type PullRequestRef = z.infer<typeof pullRequestRefSchema>;
export type DiscussionRef = z.infer<typeof discussionRefSchema>;
