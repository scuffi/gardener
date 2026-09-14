import { z } from "zod";
import { effectiveCapabilitySetSchema, observationCapabilitySchema, workspaceCapabilitySchema } from "./capabilities";
import { repositoryEventTriggerSchema } from "./events";
import { githubNumericIdSchema } from "./identity";
import { operationKindSchema } from "./operations";
import { policyModeSchema } from "./policies";

const id = z.string().regex(/^[A-Za-z0-9:._-]{1,255}$/);
const agentId = z.string().regex(/^[a-z0-9](?:[a-z0-9._-]{0,253}[a-z0-9])?$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.iso.datetime();
const displayName = z.string().trim().min(1).max(255);

/** An Agent is enabled for exactly one structurally assigned repository. */
export const agentRepositoryAssignmentV1Schema = z.object({
  schemaVersion: z.literal("v1"), id, version: z.number().int().positive(), configHash: hash,
  agentId, agentDisplayName: displayName.optional(), repositoryId: githubNumericIdSchema, repositoryDisplayName: displayName.optional(),
  enabled: z.boolean(), authorityCeiling: policyModeSchema,
  createdAt: timestamp, updatedAt: timestamp, removedAt: timestamp.nullable(),
}).strict().superRefine((assignment, context) => {
  if (Date.parse(assignment.updatedAt) < Date.parse(assignment.createdAt)) context.addIssue({ code: "custom", path: ["updatedAt"], message: "assignment update cannot precede creation" });
});
export type AgentRepositoryAssignmentV1 = z.infer<typeof agentRepositoryAssignmentV1Schema>;

const assignmentHistoryBase = z.object({
  schemaVersion: z.literal("v1"), id, assignmentId: id, assignmentVersion: z.number().int().positive(), actorUserId: id, createdAt: timestamp,
});
export const assignmentHistoryDetailsSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("added"), repositoryId: githubNumericIdSchema, agentId }).strict(),
  z.object({ action: z.literal("enabled") }).strict(),
  z.object({ action: z.literal("paused") }).strict(),
  z.object({ action: z.literal("resumed") }).strict(),
  z.object({ action: z.literal("disabled") }).strict(),
  z.object({ action: z.literal("removed") }).strict(),
  z.object({ action: z.literal("authority_narrowed"), from: policyModeSchema, to: policyModeSchema }).strict(),
  z.object({ action: z.literal("authority_widened"), from: policyModeSchema, to: policyModeSchema }).strict(),
]);
export type AssignmentHistoryDetails = z.infer<typeof assignmentHistoryDetailsSchema>;
export const agentRepositoryAssignmentHistoryV1Schema = assignmentHistoryBase.extend({ details: assignmentHistoryDetailsSchema }).strict();
export type AgentRepositoryAssignmentHistoryV1 = z.infer<typeof agentRepositoryAssignmentHistoryV1Schema>;

/** Repository-local authority. Missing capability modes are disabled. */
export const repositoryPolicyV1Schema = z.object({
  schemaVersion: z.literal("v1"), repositoryId: githubNumericIdSchema, repositoryDisplayName: displayName.optional(), version: z.number().int().positive(), policyHash: hash,
  operationModes: z.partialRecord(operationKindSchema, policyModeSchema),
  allowedObservations: z.array(observationCapabilitySchema).max(observationCapabilitySchema.options.length),
  workspaceModes: z.partialRecord(workspaceCapabilitySchema, policyModeSchema),
}).strict().superRefine((policy, context) => {
  if (new Set(policy.allowedObservations).size !== policy.allowedObservations.length) context.addIssue({ code: "custom", path: ["allowedObservations"], message: "observation capabilities must be unique" });
});
export type RepositoryPolicyV1 = z.infer<typeof repositoryPolicyV1Schema>;

const modeRank = { disabled: 0, approval: 1, automatic: 2 } as const;
export const effectiveAuthorityLayersV1Schema = z.object({
  workspace: policyModeSchema,
  repository: policyModeSchema,
  agent: policyModeSchema,
  assignment: policyModeSchema,
  effective: policyModeSchema,
}).strict().superRefine((layers, context) => {
  const expected = ([layers.workspace, layers.repository, layers.agent, layers.assignment] as const).reduce((narrowest, mode) => modeRank[mode] < modeRank[narrowest] ? mode : narrowest, "automatic");
  if (layers.effective !== expected) context.addIssue({ code: "custom", path: ["effective"], message: "effective authority must be the most restrictive layer" });
});
export type EffectiveAuthorityLayersV1 = z.infer<typeof effectiveAuthorityLayersV1Schema>;

export const effectiveEffectAuthorityV1Schema = z.object({
  capability: operationKindSchema,
  layers: effectiveAuthorityLayersV1Schema,
}).strict();
export type EffectiveEffectAuthorityV1 = z.infer<typeof effectiveEffectAuthorityV1Schema>;

export const effectiveAssignmentPolicyV1Schema = z.object({
  authority: z.array(effectiveEffectAuthorityV1Schema).max(operationKindSchema.options.length),
  capabilities: effectiveCapabilitySetSchema,
}).strict();
export type EffectiveAssignmentPolicyV1 = z.infer<typeof effectiveAssignmentPolicyV1Schema>;

export const assignmentOverlapConflictV1Schema = z.object({
  assignmentId: id, assignmentVersion: z.number().int().positive(), agentId, agentDisplayName: displayName.optional(),
  activeRevisionId: id,
  /** Canonical 64-hex hash of compiled revision content, never the agent_<hash> compiled revision ID. */
  activeRevisionCompiledHash: hash,
  sharedTriggers: z.array(repositoryEventTriggerSchema).min(1).max(repositoryEventTriggerSchema.options.length),
  sharedEffects: z.array(operationKindSchema).min(1).max(operationKindSchema.options.length),
}).strict();
export type AssignmentOverlapConflictV1 = z.infer<typeof assignmentOverlapConflictV1Schema>;

export const assignmentOverlapWarningV1Schema = z.object({
  schemaVersion: z.literal("v1"), assignmentEpoch: z.number().int().nonnegative(), repositoryId: githubNumericIdSchema,
  candidate: z.object({ agentId, revisionId: id, revisionCompiledHash: hash, assignmentId: id, assignmentVersion: z.number().int().positive() }).strict(),
  conflicts: z.array(assignmentOverlapConflictV1Schema).min(1), fingerprint: hash,
}).strict();
export type AssignmentOverlapWarningV1 = z.infer<typeof assignmentOverlapWarningV1Schema>;
