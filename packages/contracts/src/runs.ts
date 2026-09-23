import { z } from "zod";
import { operationSchema, operationReceiptSchema } from "./operations";

const id = z.string().regex(/^[A-Za-z0-9:._-]{1,255}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.iso.datetime();
function precedesOrEquals(left: string, right: string): boolean { return Date.parse(left) <= Date.parse(right); }

export const runStateSchema = z.enum(["queued", "running", "waiting", "succeeded", "failed", "cancelled"]);
export const taskStateSchema = z.enum(["queued", "running", "waiting", "succeeded", "failed", "cancelled"]);
export const stepStateSchema = z.enum(["pending", "running", "waiting", "succeeded", "failed", "cancelled", "skipped"]);
export const stepKindSchema = z.enum(["resolve", "model", "tool", "child_agent", "interruption", "proposal", "effect", "checkpoint", "cleanup"]);

export const runBudgetUsageV1Schema = z.object({
  turns: z.number().int().nonnegative(), toolCalls: z.number().int().nonnegative(), tasksCreated: z.number().int().nonnegative(), activeParallelTasks: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(), costUsd: z.number().nonnegative(),
  operations: z.number().int().nonnegative(), artifactBytes: z.number().int().nonnegative(), runtimeSeconds: z.number().nonnegative(),
}).strict();
export type RunBudgetUsageV1 = z.infer<typeof runBudgetUsageV1Schema>;

export const agentRunV1Schema = z.object({
  schemaVersion: z.literal("v1"), id, instanceId: id, eventId: id, agentId: id, revisionId: id, snapshotHash: hash,
  orchestrationInstanceId: id, state: runStateSchema, createdAt: timestamp, startedAt: timestamp.nullable(), completedAt: timestamp.nullable(),
  budgetUsage: runBudgetUsageV1Schema, terminationReason: z.string().max(1_000).nullable(), traceId: id,
}).strict().superRefine((run, context) => {
  if (run.state === "queued" && (run.startedAt !== null || run.completedAt !== null)) context.addIssue({ code: "custom", message: "queued run cannot have lifecycle timestamps" });
  if ((run.state === "running" || run.state === "waiting") && (run.startedAt === null || run.completedAt !== null)) context.addIssue({ code: "custom", message: "active run requires startedAt and no completedAt" });
  if (["succeeded", "failed", "cancelled"].includes(run.state) && run.completedAt === null) context.addIssue({ code: "custom", path: ["completedAt"], message: "terminal run requires completedAt" });
  if ((run.state === "succeeded" || run.state === "failed") && run.startedAt === null) context.addIssue({ code: "custom", path: ["startedAt"], message: "completed execution requires startedAt" });
  if (["succeeded", "failed", "cancelled"].includes(run.state) && run.budgetUsage.activeParallelTasks !== 0) context.addIssue({ code: "custom", path: ["budgetUsage", "activeParallelTasks"], message: "terminal run cannot retain active parallel tasks" });
  if (run.startedAt !== null && !precedesOrEquals(run.createdAt, run.startedAt)) context.addIssue({ code: "custom", path: ["startedAt"], message: "run cannot start before creation" });
  if (run.completedAt !== null && (!precedesOrEquals(run.createdAt, run.completedAt) || (run.startedAt !== null && !precedesOrEquals(run.startedAt, run.completedAt)))) context.addIssue({ code: "custom", path: ["completedAt"], message: "run completion chronology is invalid" });
});
export type AgentRunV1 = z.infer<typeof agentRunV1Schema>;

export const agentTaskV1Schema = z.object({
  schemaVersion: z.literal("v1"), id, runId: id, parentTaskId: id.nullable(), kind: z.enum(["main", "subagent", "evaluation", "workspace"]),
  state: taskStateSchema, ordinal: z.number().int().nonnegative(), assignedCapabilitiesHash: hash, workspaceId: id.nullable(),
  createdAt: timestamp, startedAt: timestamp.nullable(), completedAt: timestamp.nullable(), errorCode: z.string().max(100).nullable(),
}).strict().superRefine((task, context) => {
  if (task.state === "queued" && (task.startedAt !== null || task.completedAt !== null)) context.addIssue({ code: "custom", message: "queued task cannot have lifecycle timestamps" });
  if ((task.state === "running" || task.state === "waiting") && (task.startedAt === null || task.completedAt !== null)) context.addIssue({ code: "custom", message: "active task requires startedAt and no completedAt" });
  if (["succeeded", "failed", "cancelled"].includes(task.state) && task.completedAt === null) context.addIssue({ code: "custom", path: ["completedAt"], message: "terminal task requires completedAt" });
  if ((task.state === "succeeded" || task.state === "failed") && task.startedAt === null) context.addIssue({ code: "custom", path: ["startedAt"], message: "completed execution requires startedAt" });
  if (task.startedAt !== null && !precedesOrEquals(task.createdAt, task.startedAt)) context.addIssue({ code: "custom", path: ["startedAt"], message: "task cannot start before creation" });
  if (task.completedAt !== null && (!precedesOrEquals(task.createdAt, task.completedAt) || (task.startedAt !== null && !precedesOrEquals(task.startedAt, task.completedAt)))) context.addIssue({ code: "custom", path: ["completedAt"], message: "task completion chronology is invalid" });
});
export type AgentTaskV1 = z.infer<typeof agentTaskV1Schema>;

export const agentStepV1Schema = z.object({
  schemaVersion: z.literal("v1"), id, runId: id, taskId: id, parentStepId: id.nullable(), kind: stepKindSchema, state: stepStateSchema,
  ordinal: z.number().int().nonnegative(), attempt: z.number().int().positive(), inputHash: hash, outputHash: hash.nullable(),
  artifactIds: z.array(id).max(100), startedAt: timestamp.nullable(), completedAt: timestamp.nullable(), retryable: z.boolean().nullable(), errorCode: z.string().max(100).nullable(),
}).strict().superRefine((step, context) => {
  if (step.state === "pending" && (step.startedAt !== null || step.completedAt !== null)) context.addIssue({ code: "custom", message: "pending step cannot have lifecycle timestamps" });
  if ((step.state === "running" || step.state === "waiting") && (step.startedAt === null || step.completedAt !== null)) context.addIssue({ code: "custom", message: "active step requires startedAt and no completedAt" });
  if (["succeeded", "failed", "cancelled", "skipped"].includes(step.state) && step.completedAt === null) context.addIssue({ code: "custom", path: ["completedAt"], message: "terminal step requires completedAt" });
  if ((step.state === "succeeded" || step.state === "failed") && step.startedAt === null) context.addIssue({ code: "custom", path: ["startedAt"], message: "completed execution requires startedAt" });
  if (step.startedAt !== null && step.completedAt !== null && !precedesOrEquals(step.startedAt, step.completedAt)) context.addIssue({ code: "custom", path: ["completedAt"], message: "step completion cannot precede start" });
});
export type AgentStepV1 = z.infer<typeof agentStepV1Schema>;

export const agentArtifactV1Schema = z.object({
  schemaVersion: z.literal("v1"), id, runId: id, taskId: id.nullable(), stepId: id.nullable(),
  kind: z.enum(["repository_snapshot", "patch", "log", "report", "trace", "model_input", "model_output", "tool_output", "test_result", "eval_result"]),
  name: z.string().min(1).max(255), mediaType: z.string().min(1).max(100), sizeBytes: z.number().int().nonnegative().max(1_000_000_000), hash,
  storage: z.object({ provider: z.enum(["r2", "d1", "computer", "inline"]), key: z.string().min(1).max(1_024) }).strict(),
  trust: z.enum(["trusted_system", "untrusted_repository", "untrusted_model", "untrusted_tool", "human_authored"]), createdAt: timestamp, expiresAt: timestamp.nullable(),
}).strict().superRefine((artifact, context) => {
  if (artifact.expiresAt !== null && Date.parse(artifact.expiresAt) <= Date.parse(artifact.createdAt)) context.addIssue({ code: "custom", path: ["expiresAt"], message: "artifact expiry must follow creation" });
});
export type AgentArtifactV1 = z.infer<typeof agentArtifactV1Schema>;

export const agentEffectProposalV1Schema = z.object({
  schemaVersion: z.literal("v1"), id, runId: id, stepId: id, operation: operationSchema, operationHash: hash,
  rationale: z.string().trim().min(1).max(5_000), evidenceArtifactIds: z.array(id).max(100), createdAt: timestamp,
}).strict();
export type AgentEffectProposalV1 = z.infer<typeof agentEffectProposalV1Schema>;

export const agentEffectResultV1Schema = z.object({ proposalId: id, receipt: operationReceiptSchema }).strict();
export type AgentEffectResultV1 = z.infer<typeof agentEffectResultV1Schema>;
