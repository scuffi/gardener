import { z } from "zod";

export const githubNumericIdSchema = z.string().regex(/^[1-9][0-9]{0,31}$/, "expected a numeric GitHub id");
export const githubAccountTypeSchema = z.enum(["User", "Organization", "Bot", "Mannequin"]);
export type GitHubAccountType = z.infer<typeof githubAccountTypeSchema>;

/** Provider-attested identity. Login is only a mutable display hint; id is authoritative. */
export const githubIdentitySchema = z.object({
  id: githubNumericIdSchema,
  login: z.string().trim().min(1).max(255),
  accountType: githubAccountTypeSchema,
}).strict();
export type GitHubIdentity = z.infer<typeof githubIdentitySchema>;

export const gardenerPrincipalSchema = z.object({
  kind: z.enum(["owner", "member", "publisher", "system", "channel"]),
  id: z.string().regex(/^[A-Za-z0-9:_-]{1,255}$/),
  displayName: z.string().trim().min(1).max(255).optional(),
}).strict();
export type GardenerPrincipal = z.infer<typeof gardenerPrincipalSchema>;

export const authoringPrincipalSchema = z.discriminatedUnion("provider", [
  z.object({ provider: z.literal("github"), identity: githubIdentitySchema }).strict(),
  z.object({ provider: z.literal("gardener"), principal: gardenerPrincipalSchema }).strict(),
  z.object({ provider: z.literal("oauth_client"), clientId: z.string().regex(/^[A-Za-z0-9:_-]{1,255}$/) }).strict(),
]);
export type AuthoringPrincipal = z.infer<typeof authoringPrincipalSchema>;
