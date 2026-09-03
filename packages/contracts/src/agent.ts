import { z } from "zod";
import { normalizedIssueEventSchema } from "./events";
import { operationSchema } from "./operations";

export const agentProposalSchema = z.object({
  operation: operationSchema,
  rationale: z.string().min(1).max(5_000),
  evidenceIds: z.array(z.string().min(1).max(255)).max(100).default([]),
}).strict();
export type AgentProposal = z.infer<typeof agentProposalSchema>;

export const agentResultSchema = z.object({
  schemaVersion: z.literal("v1").default("v1"),
  summary: z.string().min(1).max(10_000),
  evidence: z.array(z.object({
    id: z.string().min(1).max(255),
    kind: z.enum(["issue", "pull_request", "repository", "check", "file", "tool"]),
    resourceId: z.string().min(1).max(1_024),
    excerpt: z.string().max(10_000).optional(),
  }).strict()).max(1_000),
  usage: z.object({
    model: z.string().min(1).max(255),
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    costUsd: z.number().nonnegative().optional(),
  }).strict(),
  artifacts: z.array(z.object({ id: z.string().min(1), kind: z.enum(["log", "report", "diff"]), name: z.string().min(1), sizeBytes: z.number().int().nonnegative() }).strict()).max(100).default([]),
  proposals: z.array(agentProposalSchema).max(100),
}).strict();
export type AgentResult = z.infer<typeof agentResultSchema>;

export const agentStartRequestSchema = z.object({
  schemaVersion: z.literal("v1"),
  runId: z.string().min(1).max(255),
  model: z.string().min(1).max(255),
  instructions: z.string().min(1).max(50_000),
  event: normalizedIssueEventSchema,
  maxOperations: z.number().int().positive().max(100).default(10),
  maxInputTokens: z.number().int().positive().max(2_000_000).default(32_000),
  maxOutputTokens: z.number().int().positive().max(8_192).default(800),
}).strict();
export type AgentStartRequest = z.infer<typeof agentStartRequestSchema>;

export const agentRunHandleSchema = z.object({ runId: z.string().min(1), executionId: z.string().min(1) }).strict();
export type AgentRunHandle = z.infer<typeof agentRunHandleSchema>;

export const agentRunStatusSchema = z.object({
  runId: z.string().min(1), executionId: z.string().min(1),
  state: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]),
  error: z.string().max(2_000).optional(),
}).strict();
export type AgentRunStatus = z.infer<typeof agentRunStatusSchema>;

/** Harness-neutral lifecycle. Implementations must make start idempotent by runId. */
export interface AgentRuntime {
  start(request: AgentStartRequest): Promise<AgentRunHandle>;
  status(handle: AgentRunHandle): Promise<AgentRunStatus>;
  result(handle: AgentRunHandle): Promise<AgentResult | null>;
  cancel(handle: AgentRunHandle): Promise<void>;
}
