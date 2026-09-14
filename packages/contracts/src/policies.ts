import { z } from "zod";
import { observationCapabilitySchema, workspaceCapabilitySchema } from "./capabilities";
import { operationKindSchema } from "./operations";

export const policyModeSchema = z.enum(["disabled", "approval", "automatic"]);
export type PolicyMode = z.infer<typeof policyModeSchema>;

export const instancePolicyV1Schema = z.object({
  schemaVersion: z.literal("v1"),
  id: z.string().regex(/^[A-Za-z0-9:_-]{1,255}$/),
  version: z.number().int().positive(),
  policyHash: z.string().regex(/^[a-f0-9]{64}$/),
  operationModes: z.record(operationKindSchema, policyModeSchema),
  allowedObservations: z.array(observationCapabilitySchema).max(observationCapabilitySchema.options.length),
  workspaceModes: z.partialRecord(workspaceCapabilitySchema, policyModeSchema),
  allowedMergeMethods: z.array(z.enum(["merge", "squash", "rebase"])).min(1).max(3),
  requiredChecks: z.array(z.string().trim().min(1).max(255)).max(100),
  maxCommentLength: z.number().int().positive().max(65_536),
  maxChangedFiles: z.number().int().positive().max(100),
  deniedPathPrefixes: z.array(z.string().min(1).max(1_024)).max(100),
}).strict().superRefine((policy, context) => {
  if (new Set(policy.allowedObservations).size !== policy.allowedObservations.length) context.addIssue({ code: "custom", path: ["allowedObservations"], message: "observation capabilities must be unique" });
  if (new Set(policy.requiredChecks).size !== policy.requiredChecks.length) context.addIssue({ code: "custom", path: ["requiredChecks"], message: "required checks must be unique" });
});
export type InstancePolicyV1 = z.infer<typeof instancePolicyV1Schema>;
export type InstancePolicySnapshotV1 = Readonly<InstancePolicyV1>;

export const policyDecisionSchema = z.object({
  outcome: z.enum(["denied", "approval_required", "authorized"]),
  operationId: z.string().min(1).max(255),
  mode: policyModeSchema,
  reasons: z.array(z.string().min(1).max(1_000)).min(1).max(100),
}).strict();
export type PolicyDecision = z.infer<typeof policyDecisionSchema>;
