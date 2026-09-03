import { z } from "zod";

export const githubNumericIdSchema = z.string().regex(/^[1-9][0-9]{0,31}$/, "expected a numeric GitHub id");

export const githubAccountTypeSchema = z.enum(["User", "Organization", "Bot", "Mannequin"]);
export type GitHubAccountType = z.infer<typeof githubAccountTypeSchema>;

/** A Connect-attested GitHub identity. Login is a mutable display hint; id is the stable identifier. */
export const githubIdentitySchema = z.object({
  id: githubNumericIdSchema,
  login: z.string().min(1).max(255),
  accountType: githubAccountTypeSchema,
}).strict();
export type GitHubIdentity = z.infer<typeof githubIdentitySchema>;
