import { z } from "zod";
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
