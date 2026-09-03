import { z } from "zod";
import { workflowConditionSchema } from "./conditions";
import { issueEventActionSchema, pullRequestEventActionSchema } from "./events";
import { githubNumericIdSchema } from "./identity";
import { operationKindSchema } from "./operations";
import { policySchema } from "./policies";

export const workflowTriggerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("event"), events: z.array(z.literal("github.issue")).min(1) }).strict(),
  z.object({ kind: z.literal("manual") }).strict(),
  z.object({ kind: z.literal("schedule"), cron: z.string().trim().min(5).max(100) }).strict(),
]);

export const workflowLimitsSchema = z.object({
  runtimeSeconds: z.number().int().positive().max(3_600).default(300),
  inputTokens: z.number().int().positive().max(1_000_000).default(32_000),
  outputTokens: z.number().int().positive().max(1_000_000).default(8_000),
  costUsd: z.number().nonnegative().max(100).default(1),
  retries: z.number().int().nonnegative().max(10).default(2),
  operations: z.number().int().positive().max(100).default(10),
}).strict();

export const workspaceRequirementsSchema = z.object({
  enabled: z.boolean().default(false),
  experimental: z.boolean().default(false),
  network: z.enum(["denied", "allowlist"]).default("denied"),
  allowedHosts: z.array(z.string().min(1).max(255)).max(50).default([]),
}).strict().superRefine((value, context) => {
  if (value.network === "denied" && value.allowedHosts.length) context.addIssue({ code: "custom", path: ["allowedHosts"], message: "denied network cannot have allowed hosts" });
});

export const workflowDefinitionSchema = z.object({
  schemaVersion: z.literal("v1"),
  id: z.string().min(1).max(255),
  name: z.string().min(1).max(255),
  revision: z.number().int().positive(),
  paused: z.boolean().default(true),
  triggers: z.array(workflowTriggerSchema).min(1).max(20),
  repositories: z.array(z.string().min(1).max(255)).min(1).max(1_000),
  instructions: z.string().min(1).max(50_000),
  runtime: z.enum(["workers-ai.issue-gardener", "mock"]),
  model: z.string().min(1).max(255),
  readTools: z.array(z.enum(["issue", "pull_request", "repository", "checks", "files"])).max(10).default(["issue"]),
  workspace: workspaceRequirementsSchema.default({ enabled: false, experimental: false, network: "denied", allowedHosts: [] }),
  allowedOperations: z.array(operationKindSchema).max(20).default([]),
  limits: workflowLimitsSchema.default({ runtimeSeconds: 300, inputTokens: 32_000, outputTokens: 8_000, costUsd: 1, retries: 2, operations: 10 }),
}).strict();
export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;
export const workflowDefinitionV1Schema = workflowDefinitionSchema;
export type WorkflowDefinitionV1 = WorkflowDefinition;

export const workflowTriggerV2Schema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("github.issue"), actions: z.array(issueEventActionSchema).min(1).max(issueEventActionSchema.options.length) }).strict(),
  z.object({ kind: z.literal("github.pull_request"), actions: z.array(pullRequestEventActionSchema).min(1).max(pullRequestEventActionSchema.options.length) }).strict(),
  z.object({ kind: z.literal("manual") }).strict(),
  z.object({ kind: z.literal("schedule"), cron: z.string().trim().min(5).max(100) }).strict(),
]);
export type WorkflowTriggerV2 = z.infer<typeof workflowTriggerV2Schema>;

export const workflowRuntimeV2Schema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("workers-ai.issue-gardener"), model: z.literal("deployment-default"), instructions: z.string().min(1).max(50_000) }).strict(),
  z.object({ kind: z.literal("workers-ai.pull-request-gardener"), model: z.literal("deployment-default"), instructions: z.string().min(1).max(50_000) }).strict(),
]);
export type WorkflowRuntimeV2 = z.infer<typeof workflowRuntimeV2Schema>;

export const workflowCapabilitiesV2Schema = z.object({
  read: z.array(z.enum(["issue", "pull_request", "repository", "checks", "files"])).max(10).default([]),
  propose: z.array(operationKindSchema).max(operationKindSchema.options.length).default([]),
  maximumMode: z.enum(["approval", "instance_policy"]).default("approval"),
}).strict().superRefine((capabilities, context) => {
  if (new Set(capabilities.read).size !== capabilities.read.length) context.addIssue({ code: "custom", path: ["read"], message: "read capabilities must be unique" });
  if (new Set(capabilities.propose).size !== capabilities.propose.length) context.addIssue({ code: "custom", path: ["propose"], message: "proposed operations must be unique" });
});
export type WorkflowCapabilitiesV2 = z.infer<typeof workflowCapabilitiesV2Schema>;

/** Client-authored no-code content. Server-owned identity, revision, state, hashes, and policy are deliberately absent. */
export const workflowSpecV2Schema = z.object({
  name: z.string().trim().min(1).max(255),
  description: z.string().trim().max(1_000).default(""),
  triggers: z.array(workflowTriggerV2Schema).min(1).max(20),
  repositoryIds: z.array(githubNumericIdSchema).min(1).max(1_000),
  condition: workflowConditionSchema.nullable().default(null),
  runtime: workflowRuntimeV2Schema,
  capabilities: workflowCapabilitiesV2Schema,
  workspace: workspaceRequirementsSchema.default({ enabled: false, experimental: false, network: "denied", allowedHosts: [] }),
  limits: workflowLimitsSchema.default({ runtimeSeconds: 300, inputTokens: 32_000, outputTokens: 8_000, costUsd: 1, retries: 2, operations: 10 }),
}).strict().superRefine((definition, context) => {
  if (new Set(definition.repositoryIds).size !== definition.repositoryIds.length) {
    context.addIssue({ code: "custom", path: ["repositoryIds"], message: "repository ids must be unique" });
  }
  const triggerKinds = definition.triggers.map((trigger) => trigger.kind);
  if (new Set(triggerKinds).size !== triggerKinds.length) {
    context.addIssue({ code: "custom", path: ["triggers"], message: "trigger kinds must be unique" });
  }
  for (const [index, trigger] of definition.triggers.entries()) {
    if ("actions" in trigger && new Set(trigger.actions).size !== trigger.actions.length) {
      context.addIssue({ code: "custom", path: ["triggers", index, "actions"], message: "trigger actions must be unique" });
    }
  }
});
export type WorkflowSpecV2 = z.infer<typeof workflowSpecV2Schema>;

/** Server-authored immutable revision envelope for a no-code workflow specification. */
export const workflowDefinitionV2Schema = z.object({
  schemaVersion: z.literal("v2"),
  workflowId: z.string().regex(/^[a-z0-9](?:[a-z0-9._-]{0,253}[a-z0-9])?$/),
  revision: z.number().int().positive(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  spec: workflowSpecV2Schema,
}).strict();
export type WorkflowDefinitionV2 = z.infer<typeof workflowDefinitionV2Schema>;

export const anyWorkflowDefinitionSchema = z.union([workflowDefinitionV1Schema, workflowDefinitionV2Schema]);
export type AnyWorkflowDefinition = z.infer<typeof anyWorkflowDefinitionSchema>;

export const compiledWorkflowPlanV2Schema = z.object({
  schemaVersion: z.literal("v2"),
  planId: z.string().regex(/^plan_[a-f0-9]{64}$/),
  workflowId: z.string().min(1).max(255),
  revision: z.number().int().positive(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  compiledAt: z.iso.datetime(),
  triggers: z.array(z.string().min(1).max(255)).min(1).max(100),
  repositoryIds: z.array(githubNumericIdSchema).min(1).max(1_000),
  condition: workflowConditionSchema.nullable(),
  conditionResolver: z.object({
    id: z.literal("signed-event-facts"),
    version: z.literal(1),
    catalogVersion: z.literal("2026-09-03.1"),
  }).strict(),
  requiredGitHubPermissions: z.array(z.string().min(1).max(100)).max(20),
  runtime: z.object({
    kind: z.enum(["workers-ai.issue-gardener", "workers-ai.pull-request-gardener"]),
    resolvedModel: z.string().min(1).max(255),
    instructions: z.string().min(1).max(50_000),
  }).strict(),
  capabilities: workflowCapabilitiesV2Schema,
  workspace: workspaceRequirementsSchema,
  limits: workflowLimitsSchema,
}).strict();
export type CompiledWorkflowPlanV2 = z.infer<typeof compiledWorkflowPlanV2Schema>;

export const compiledPlanSchema = z.object({
  schemaVersion: z.literal("v1"),
  planId: z.string().min(1).max(255),
  sourceWorkflowId: z.string().min(1).max(255),
  sourceRevision: z.number().int().positive(),
  compiledAt: z.iso.datetime(),
  definition: workflowDefinitionSchema,
  policy: policySchema,
}).strict();
export type CompiledPlan = z.infer<typeof compiledPlanSchema>;
