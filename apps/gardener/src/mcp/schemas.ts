import { z } from "zod";

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/);
const cursor = z.string().min(1).max(256);
const source = z.string().min(1).max(262_144);
const contentHash = z.string().min(16).max(128).regex(/^[A-Za-z0-9_-]+$/);

function jsonComplexity(value: unknown): { valid: boolean; nodes: number; depth: number; bytes: number } {
  let nodes = 0;
  let maxDepth = 0;
  let valid = true;
  const visit = (item: unknown, depth: number): void => {
    nodes += 1;
    maxDepth = Math.max(maxDepth, depth);
    if (nodes > 2_000 || depth > 10) return;
    if (item === null || typeof item === "string" || typeof item === "boolean") return;
    if (typeof item === "number") {
      if (!Number.isFinite(item)) valid = false;
      return;
    }
    if (Array.isArray(item)) {
      if (item.length > 200) valid = false;
      for (const child of item) visit(child, depth + 1);
      return;
    }
    if (typeof item === "object") {
      const entries = Object.entries(item as Record<string, unknown>);
      if (entries.length > 200) valid = false;
      for (const [key, child] of entries) {
        if (key.length > 128 || !/^[\w .:@/-]+$/.test(key)) valid = false;
        visit(child, depth + 1);
      }
      return;
    }
    valid = false;
  };
  visit(value, 0);
  let bytes = Number.POSITIVE_INFINITY;
  try {
    bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    valid = false;
  }
  return { valid, nodes, depth: maxDepth, bytes };
}

export const boundedJsonSchema = z.unknown().superRefine((value, ctx) => {
  const complexity = jsonComplexity(value);
  if (!complexity.valid || complexity.nodes > 2_000 || complexity.depth > 10 || complexity.bytes > 131_072) {
    ctx.addIssue({ code: "custom", message: "JSON value exceeds the allowed structure or size" });
  }
});

const supportingFile = z.object({
  path: z.string().min(1).max(256).regex(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/),
  content: z.string().max(65_536),
}).strict();

export const listAgentsInputSchema = z.object({
  cursor: cursor.optional(),
  limit: z.number().int().min(1).max(50).default(25),
}).strict();

export const getAgentInputSchema = z.object({
  agentId: id,
  revisionId: id.optional(),
  includeSource: z.boolean().default(false),
}).strict();

export const catalogInputSchema = z.object({
  query: z.string().max(128).optional(),
  cursor: cursor.optional(),
  limit: z.number().int().min(1).max(100).default(50),
}).strict();

export const validateInputSchema = z.object({
  source,
  supportingFiles: z.array(supportingFile).max(32).default([]),
}).strict();

export const explainInputSchema = z.object({
  agentId: id.optional(),
  revisionId: id.optional(),
  source: source.optional(),
}).strict().superRefine((value, ctx) => {
  if (!value.source && !value.agentId) ctx.addIssue({ code: "custom", message: "Provide source or agentId" });
  if (value.source && (value.agentId || value.revisionId)) ctx.addIssue({ code: "custom", message: "Source and stored revision are mutually exclusive" });
});

export const diffInputSchema = z.object({
  agentId: id,
  fromRevisionId: id,
  toRevisionId: id,
}).strict();

const simulationEvent = z.object({
  kind: z.string().min(1).max(64),
  action: z.string().min(1).max(64),
  repositoryId: id,
  resourceType: z.string().min(1).max(64),
  resourceId: id,
  resourceNumber: z.number().int().positive().max(2_147_483_647).optional(),
  facts: boundedJsonSchema.optional(),
}).strict();

export const simulateInputSchema = z.object({
  agentId: id.optional(),
  revisionId: id.optional(),
  source: source.optional(),
  event: simulationEvent,
  maxSteps: z.number().int().min(1).max(64).default(16),
}).strict().superRefine((value, ctx) => {
  if (!value.source && !value.agentId) ctx.addIssue({ code: "custom", message: "Provide source or agentId" });
  if (value.source && (value.agentId || value.revisionId)) ctx.addIssue({ code: "custom", message: "Source and stored revision are mutually exclusive" });
});

export const publishDraftInputSchema = z.object({
  agentId: id.optional(),
  source,
  supportingFiles: z.array(supportingFile).max(32).default([]),
  expectedDraftVersion: z.number().int().nonnegative().max(2_147_483_647).optional(),
  idempotencyKey: z.string().min(16).max(128).regex(/^[A-Za-z0-9._:-]+$/),
  sourceHash: contentHash.optional(),
}).strict();

export const getRunTraceInputSchema = z.object({
  runId: id,
  cursor: cursor.optional(),
  limit: z.number().int().min(1).max(100).default(50),
}).strict();

export type ListAgentsInput = z.infer<typeof listAgentsInputSchema>;
export type GetAgentInput = z.infer<typeof getAgentInputSchema>;
export type CatalogInput = z.infer<typeof catalogInputSchema>;
export type ValidateInput = z.infer<typeof validateInputSchema>;
export type ExplainInput = z.infer<typeof explainInputSchema>;
export type DiffInput = z.infer<typeof diffInputSchema>;
export type SimulateInput = z.infer<typeof simulateInputSchema>;
export type PublishDraftInput = z.infer<typeof publishDraftInputSchema>;
export type GetRunTraceInput = z.infer<typeof getRunTraceInputSchema>;

export function assertSourceBundleSize(input: { source: string; supportingFiles?: readonly { content: string }[] }): void {
  const encoder = new TextEncoder();
  let bytes = encoder.encode(input.source).byteLength;
  for (const file of input.supportingFiles ?? []) bytes += encoder.encode(file.content).byteLength;
  if (bytes > 524_288) throw new Error("Agent source bundle is too large");
}
