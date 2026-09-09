import { z } from "zod";
import { observationCapabilitySchema, publicNetworkHostnameSchema, workspaceCapabilitySchema } from "./capabilities";
import { operationKindSchema } from "./operations";
import { repositoryRefSchema } from "./repository";

const id = z.string().regex(/^[A-Za-z0-9:._-]{1,255}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const unparameterizedWorkspaceCapabilitySchema = workspaceCapabilitySchema.exclude(["workspace.exec.container", "workspace.network.connect"]);

export const runGrantScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("observation"), capabilities: z.array(observationCapabilitySchema).min(1).max(observationCapabilitySchema.options.length) }).strict(),
  z.object({ kind: z.literal("workspace"), capabilities: z.array(unparameterizedWorkspaceCapabilitySchema).min(1).max(unparameterizedWorkspaceCapabilitySchema.options.length) }).strict(),
  z.object({
    kind: z.literal("container"), capability: z.literal("workspace.exec.container"), capabilityRequestId: id, interruptionId: id,
    imageProfile: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/), maxRuntimeSeconds: z.number().int().positive().max(3_600),
  }).strict(),
  z.object({
    kind: z.literal("network"), capability: z.literal("workspace.network.connect"), capabilityRequestId: id, interruptionId: id,
    hosts: z.array(publicNetworkHostnameSchema).min(1).max(20),
  }).strict().superRefine((scope, context) => {
    if (new Set(scope.hosts).size !== scope.hosts.length) context.addIssue({ code: "custom", path: ["hosts"], message: "network hosts must be unique" });
  }),
  z.object({ kind: z.literal("operation.execute"), operationId: id, operationKind: operationKindSchema, operationHash: hash, interruptionId: id.nullable() }).strict(),
]);
export type RunGrantScope = z.infer<typeof runGrantScopeSchema>;

export const runGrantV2Schema = z.object({
  schemaVersion: z.literal("v2"), id, instanceId: id, runId: id, eventId: id, repository: repositoryRefSchema,
  scopes: z.array(runGrantScopeSchema).min(1).max(50), issuedAt: z.iso.datetime(), expiresAt: z.iso.datetime(), nonce: z.string().min(32).max(512),
}).strict().superRefine((grant, context) => {
  if (Date.parse(grant.expiresAt) <= Date.parse(grant.issuedAt)) context.addIssue({ code: "custom", path: ["expiresAt"], message: "grant must expire after it is issued" });
});
export type RunGrantV2 = z.infer<typeof runGrantV2Schema>;
