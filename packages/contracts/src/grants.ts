import { z } from "zod";
import { operationKindSchema } from "./operations";
import { repositoryRefSchema } from "./repository";

export const grantScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("repository.read") }).strict(),
  z.object({ kind: z.literal("issue.read"), issueNumber: z.number().int().positive() }).strict(),
  z.object({ kind: z.literal("pull_request.read"), pullNumber: z.number().int().positive() }).strict(),
  z.object({ kind: z.literal("operation.execute"), operations: z.array(operationKindSchema).min(1).max(20) }).strict(),
]);
export type GrantScope = z.infer<typeof grantScopeSchema>;

export const runGrantSchema = z.object({
  schemaVersion: z.literal("v1"),
  id: z.string().min(1).max(255),
  instanceId: z.string().min(1).max(255),
  runId: z.string().min(1).max(255),
  eventId: z.string().min(1).max(255),
  repository: repositoryRefSchema,
  scopes: z.array(grantScopeSchema).min(1).max(50),
  issuedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  nonce: z.string().min(16).max(512),
}).strict().superRefine((grant, context) => {
  if (Date.parse(grant.expiresAt) <= Date.parse(grant.issuedAt)) {
    context.addIssue({ code: "custom", path: ["expiresAt"], message: "grant must expire after it is issued" });
  }
});
export type RunGrant = z.infer<typeof runGrantSchema>;
export const grantSchema = runGrantSchema;
export type Grant = RunGrant;
