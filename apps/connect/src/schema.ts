import {
  operationSchema,
  repositoryEventV2Schema,
  repositoryRefSchema,
  type Operation,
  type RepositoryEventV2,
} from "@gardener/contracts";
import { z } from "zod";

export { operationSchema, repositoryEventV2Schema, repositoryRefSchema };
export type { Operation, RepositoryEventV2 };

export const grantRequestSchema = z.object({
  instanceId: z.string().min(1),
  runId: z.string().min(1).max(200),
  eventId: z.string().min(1).max(255),
  repository: repositoryRefSchema,
  operations: z.array(operationSchema).min(1).max(20),
}).strict();

export function isAllowedCallbackUrl(value: string): boolean {
  const url = new URL(value);
  if (url.username || url.password) return false;
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (local) return url.protocol === "http:" || url.protocol === "https:";
  return url.protocol === "https:" && url.port === "" && url.hostname.endsWith(".workers.dev");
}

export const callbackUrlSchema = z.url().refine(
  isAllowedCallbackUrl,
  "callback URL must be a public HTTPS workers.dev URL (or loopback for local development)",
);

export const cloudflareAccessCredentialsSchema = z.object({
  clientId: z.string().trim().min(1).max(512),
  clientSecret: z.string().trim().min(1).max(512),
}).strict();

export const instanceClaimSchema = z.object({
  instanceId: z.string().min(1),
  callbackUrl: callbackUrlSchema,
  cloudflareAccess: cloudflareAccessCredentialsSchema.nullable().optional(),
}).strict();

export const githubNumericIdSchema = z.string().regex(/^[1-9]\d*$/, "GitHub user id must be a positive integer");

export const githubLoginSchema = z.string().min(1).max(39).regex(
  /^(?!.*--)[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/,
  "Invalid GitHub login",
);

export const identityAssertionSchema = z.object({
  typ: z.literal("gardener-identity"),
  sub: githubNumericIdSchema,
  instanceId: z.string().min(1),
  githubLogin: githubLoginSchema,
  instanceOwner: z.boolean(),
  jti: z.string().regex(/^identity_[A-Za-z0-9_-]{43}$/, "Invalid identity assertion id"),
}).strict();

export const signedIdentityAssertionSchema = identityAssertionSchema.extend({
  iss: z.url(),
  aud: z.string().min(1),
  iat: z.number().int().nonnegative(),
  exp: z.number().int().positive(),
}).strict();

export const installationSetupSchema = z.object({
  redirectUri: callbackUrlSchema.optional(),
}).strict();

export const instanceInstallationSetupSchema = installationSetupSchema.extend({
  githubUserId: githubNumericIdSchema,
}).strict();

export const githubUsernameResolutionSchema = z.object({
  login: githubLoginSchema,
}).strict();

export function parseRepositoryFullName(value: string): { owner: string; name: string } | null {
  const parts = value.split("/");
  if (parts.length !== 2) return null;
  const [owner, name] = parts;
  if (!owner || !name || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner) || !/^[A-Za-z0-9_.-]{1,100}$/.test(name) || name === "." || name === "..") return null;
  return { owner, name };
}
