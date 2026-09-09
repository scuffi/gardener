import { z } from "zod";
import { agentLimitsV1Schema, runBudgetUsageV1Schema, type AgentLimitsV1, type RunBudgetUsageV1 } from "@gardener/contracts";
import { deepFreeze } from "./stable";

export type RunBudgetDimension = "turns" | "toolCalls" | "tasksCreated" | "activeParallelTasks" | "inputTokens" | "outputTokens" | "costUsd" | "operations" | "artifactBytes" | "runtimeSeconds";
export interface RunBudgetDecision { allowed: boolean; exceeded: RunBudgetDimension[]; next: Readonly<RunBudgetUsageV1> }
export type RunBudgetDelta = Partial<Omit<RunBudgetUsageV1, "activeParallelTasks">> & { activeParallelTasks?: number };

const initial: RunBudgetUsageV1 = { turns: 0, toolCalls: 0, tasksCreated: 0, activeParallelTasks: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, operations: 0, artifactBytes: 0, runtimeSeconds: 0 };
const deltaSchema = z.object({
  turns: z.number().int().nonnegative().optional(), toolCalls: z.number().int().nonnegative().optional(), tasksCreated: z.number().int().nonnegative().optional(),
  activeParallelTasks: z.number().int().min(-64).max(64).optional(), inputTokens: z.number().int().nonnegative().optional(), outputTokens: z.number().int().nonnegative().optional(),
  costUsd: z.number().nonnegative().optional(), operations: z.number().int().nonnegative().optional(), artifactBytes: z.number().int().nonnegative().optional(), runtimeSeconds: z.number().nonnegative().optional(),
}).strict();

export function emptyRunBudgetUsage(): Readonly<RunBudgetUsageV1> { return deepFreeze({ ...initial }); }

export function evaluateRunBudget(limitsInput: AgentLimitsV1 | unknown, usageInput: RunBudgetUsageV1 | unknown, deltaInput: RunBudgetDelta): RunBudgetDecision {
  const limits = agentLimitsV1Schema.parse(limitsInput);
  const usage = runBudgetUsageV1Schema.parse(usageInput);
  const delta = deltaSchema.parse(deltaInput);
  const candidate = Object.fromEntries(Object.entries(usage).map(([key, value]) => [key, value + (delta[key as keyof RunBudgetDelta] ?? 0)]));
  const nextParse = runBudgetUsageV1Schema.safeParse(candidate);
  if (!nextParse.success) return { allowed: false, exceeded: ["activeParallelTasks"], next: deepFreeze(usage) };
  const next = nextParse.data;
  const exceeded: RunBudgetDimension[] = [];
  if ((delta.activeParallelTasks ?? 0) > 0 && (delta.tasksCreated ?? 0) < (delta.activeParallelTasks ?? 0)) exceeded.push("tasksCreated");
  if (next.turns > limits.maxTurns) exceeded.push("turns");
  if (next.toolCalls > limits.maxToolCalls) exceeded.push("toolCalls");
  if (next.tasksCreated > limits.maxTasks) exceeded.push("tasksCreated");
  if (next.activeParallelTasks > limits.maxParallelTasks) exceeded.push("activeParallelTasks");
  if (next.inputTokens > limits.inputTokens) exceeded.push("inputTokens");
  if (next.outputTokens > limits.outputTokens) exceeded.push("outputTokens");
  if (next.costUsd > limits.costUsd) exceeded.push("costUsd");
  if (next.operations > limits.operations) exceeded.push("operations");
  if (next.artifactBytes > limits.artifactBytes) exceeded.push("artifactBytes");
  if (next.runtimeSeconds > limits.runtimeSeconds) exceeded.push("runtimeSeconds");
  return { allowed: exceeded.length === 0, exceeded, next: deepFreeze(next) };
}

export function consumeRunBudget(limits: AgentLimitsV1 | unknown, usage: RunBudgetUsageV1 | unknown, delta: RunBudgetDelta): Readonly<RunBudgetUsageV1> {
  const decision = evaluateRunBudget(limits, usage, delta);
  if (!decision.allowed) throw new Error(`run budget exceeded: ${decision.exceeded.join(", ")}`);
  return decision.next;
}

export function reserveParallelTasks(limits: AgentLimitsV1 | unknown, usage: RunBudgetUsageV1 | unknown, count: number): Readonly<RunBudgetUsageV1> {
  if (!Number.isSafeInteger(count) || count <= 0) throw new Error("parallel task reservation must be a positive integer");
  return consumeRunBudget(limits, usage, { tasksCreated: count, activeParallelTasks: count });
}
export function releaseParallelTasks(limits: AgentLimitsV1 | unknown, usage: RunBudgetUsageV1 | unknown, count: number): Readonly<RunBudgetUsageV1> {
  if (!Number.isSafeInteger(count) || count <= 0) throw new Error("parallel task release must be a positive integer");
  return consumeRunBudget(limits, usage, { activeParallelTasks: -count });
}
