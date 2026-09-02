import { z } from "zod";
import { operationKindSchema } from "./operations";

export const policyModeSchema = z.enum(["disabled", "approval", "automatic"]);
export type PolicyMode = z.infer<typeof policyModeSchema>;

export const policySchema = z.object({
  schemaVersion: z.literal("v1"),
  id: z.string().min(1).max(255),
  name: z.string().min(1).max(255),
  modes: z.record(operationKindSchema, policyModeSchema),
  allowedMergeMethods: z.array(z.enum(["merge", "squash", "rebase"])).min(1).default(["squash"]),
  requiredChecks: z.array(z.string().min(1).max(255)).max(100).default([]),
  maxCommentLength: z.number().int().positive().max(10_000).default(10_000),
  maxChangedFiles: z.number().int().positive().max(100).default(100),
  deniedPathPrefixes: z.array(z.string().min(1).max(1_024)).max(100).default([".github/workflows/", ".env"]),
}).strict();
export type Policy = z.infer<typeof policySchema>;
export type PolicySnapshot = Readonly<Policy>;

export const policyDecisionSchema = z.object({
  outcome: z.enum(["denied", "approval_required", "authorized"]),
  operationId: z.string().min(1),
  mode: policyModeSchema,
  reasons: z.array(z.string().min(1)).min(1),
}).strict();
export type PolicyDecision = z.infer<typeof policyDecisionSchema>;
