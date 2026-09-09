import { z } from "zod";
import { effectCapabilitySchema, effectiveCapabilitySetSchema, observationCapabilitySchema, workspaceCapabilitySchema } from "./capabilities";
import { repositoryEventV2Schema } from "./events";
import { agentEffectProposalV1Schema, runBudgetUsageV1Schema } from "./runs";

const id = z.string().regex(/^[A-Za-z0-9:._-]{1,255}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);

export const agentSimulationRequestV1Schema = z.object({
  schemaVersion: z.literal("v1"), simulationId: id, revisionId: id, event: repositoryEventV2Schema,
  mode: z.enum(["validate", "shadow"]), fixtureId: id.nullable(),
}).strict();
export type AgentSimulationRequestV1 = z.infer<typeof agentSimulationRequestV1Schema>;

export const agentSimulationResultV1Schema = z.object({
  schemaVersion: z.literal("v1"), simulationId: id, revisionId: id, eventId: id, status: z.enum(["eligible", "ineligible", "completed", "failed", "blocked"]),
  traceHash: hash, effectiveCapabilities: effectiveCapabilitySetSchema, proposals: z.array(agentEffectProposalV1Schema).max(100),
  deniedRequests: z.array(z.object({ capability: z.union([observationCapabilitySchema, workspaceCapabilitySchema, effectCapabilitySchema]), reason: z.string().min(1).max(1_000) }).strict()).max(100),
  usage: runBudgetUsageV1Schema, summary: z.string().max(10_000), createdAt: z.iso.datetime(), completedAt: z.iso.datetime(),
}).strict();
export type AgentSimulationResultV1 = z.infer<typeof agentSimulationResultV1Schema>;
