import { z } from "zod";
import { githubNumericIdSchema } from "./identity";
import { operationKindSchema } from "./operations";

export const observationCapabilityValues = [
  "github.repository.metadata.read",
  "github.issue.read",
  "github.pull_request.read",
  "github.comment.read",
  "github.review.read",
  "github.discussion.read",
  "github.check.read",
  "github.contents.read",
  "github.commit.read",
  "github.release.read",
] as const;
export const observationCapabilitySchema = z.enum(observationCapabilityValues);
export type ObservationCapability = z.infer<typeof observationCapabilitySchema>;

export const workspaceCapabilityValues = [
  "workspace.fs.read",
  "workspace.fs.write",
  "workspace.git.read",
  "workspace.git.write-local",
  "workspace.exec.shell",
  "workspace.exec.javascript",
  "workspace.exec.container",
  "workspace.network.connect",
  "workspace.dependencies.install",
  "workspace.artifacts.publish",
] as const;
export const workspaceCapabilitySchema = z.enum(workspaceCapabilityValues);
export type WorkspaceCapability = z.infer<typeof workspaceCapabilitySchema>;

export const effectCapabilitySchema = operationKindSchema;
export type EffectCapability = z.infer<typeof effectCapabilitySchema>;

function uniqueValues(values: readonly string[], context: z.RefinementCtx, path: PropertyKey[]): void {
  if (new Set(values).size !== values.length) context.addIssue({ code: "custom", path, message: "capabilities must be unique" });
}

export const requestedCapabilitySetSchema = z.object({
  observation: z.array(observationCapabilitySchema).max(observationCapabilityValues.length).default([]),
  workspace: z.array(workspaceCapabilitySchema).max(workspaceCapabilityValues.length).default([]),
  effects: z.array(effectCapabilitySchema).max(operationKindSchema.options.length).default([]),
}).strict().superRefine((value, context) => {
  uniqueValues(value.observation, context, ["observation"]);
  uniqueValues(value.workspace, context, ["workspace"]);
  uniqueValues(value.effects, context, ["effects"]);
});
export type RequestedCapabilitySet = z.infer<typeof requestedCapabilitySetSchema>;

export const capabilityPolicyModeSchema = z.enum(["disabled", "approval", "automatic"]);
export type CapabilityPolicyMode = z.infer<typeof capabilityPolicyModeSchema>;

export const effectiveCapabilitySetSchema = z.object({
  observation: z.array(observationCapabilitySchema).max(observationCapabilityValues.length),
  workspace: z.array(z.object({
    capability: workspaceCapabilitySchema,
    mode: capabilityPolicyModeSchema,
  }).strict()).max(workspaceCapabilityValues.length),
  effects: z.array(z.object({
    capability: effectCapabilitySchema,
    mode: capabilityPolicyModeSchema,
  }).strict()).max(operationKindSchema.options.length),
}).strict().superRefine((value, context) => {
  uniqueValues(value.observation, context, ["observation"]);
  uniqueValues(value.workspace.map((item) => item.capability), context, ["workspace"]);
  uniqueValues(value.effects.map((item) => item.capability), context, ["effects"]);
});
export type EffectiveCapabilitySet = z.infer<typeof effectiveCapabilitySetSchema>;

export const capabilityCatalogEntrySchema = z.object({
  id: z.union([observationCapabilitySchema, workspaceCapabilitySchema, effectCapabilitySchema]),
  category: z.enum(["observation", "workspace", "effect"]),
  description: z.string().min(1).max(500),
  runtimeGrant: z.enum(["safe_one_run", "revision_required", "never"]),
}).strict();
export type CapabilityCatalogEntry = z.infer<typeof capabilityCatalogEntrySchema>;

export const capabilityCatalog = Object.freeze([
  ...observationCapabilityValues.map((id) => ({ id, category: "observation" as const, description: `Observe ${id}.`, runtimeGrant: "safe_one_run" as const })),
  ...workspaceCapabilityValues.map((id) => ({
    id,
    category: "workspace" as const,
    description: `Use ${id} in the run-scoped Cloudflare Computer workspace.`,
    runtimeGrant: "safe_one_run" as const,
  })),
  ...operationKindSchema.options.map((id) => ({
    id,
    category: "effect" as const,
    description: `Propose the persistent effect ${id}.`,
    runtimeGrant: "revision_required" as const,
  })),
] satisfies CapabilityCatalogEntry[]);

export const publicNetworkHostnameSchema = z.hostname().transform((value) => value.toLowerCase()).refine((value) => {
  if (value === "localhost" || value.endsWith(".localhost") || value.endsWith(".local") || value.endsWith(".internal") || value.endsWith(".home.arpa")) return false;
  if (value === "metadata.google.internal" || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(value) || value.includes(":")) return false;
  return true;
}, "network host must be a public DNS hostname; resolved addresses must also be checked at execution time");

const capabilityRequestBaseSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9:_-]{1,255}$/),
  reason: z.string().trim().min(1).max(2_000),
  requestedAt: z.iso.datetime(),
});

export const runtimeCapabilityRequestSchema = z.discriminatedUnion("kind", [
  capabilityRequestBaseSchema.extend({ kind: z.literal("observation"), capability: observationCapabilitySchema }).strict(),
  capabilityRequestBaseSchema.extend({ kind: z.literal("workspace"), capability: workspaceCapabilitySchema.exclude(["workspace.exec.container", "workspace.network.connect"]) }).strict(),
  capabilityRequestBaseSchema.extend({
    kind: z.literal("container"), capability: z.literal("workspace.exec.container"), imageProfile: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/), maxRuntimeSeconds: z.number().int().positive().max(3_600),
  }).strict(),
  capabilityRequestBaseSchema.extend({
    kind: z.literal("network"), capability: z.literal("workspace.network.connect"), hosts: z.array(publicNetworkHostnameSchema).min(1).max(20),
  }).strict().superRefine((request, context) => {
    if (new Set(request.hosts).size !== request.hosts.length) context.addIssue({ code: "custom", path: ["hosts"], message: "network hosts must be unique" });
  }),
  capabilityRequestBaseSchema.extend({ kind: z.literal("persistent_effect"), capabilities: z.array(effectCapabilitySchema).min(1).max(operationKindSchema.options.length) }).strict(),
  capabilityRequestBaseSchema.extend({ kind: z.literal("actor_broadening"), actorIds: z.array(githubNumericIdSchema).min(1).max(100) }).strict(),
  capabilityRequestBaseSchema.extend({ kind: z.literal("authority_increase"), requestedMode: z.enum(["approval", "automatic"]) }).strict(),
  capabilityRequestBaseSchema.extend({ kind: z.literal("credentials"), credentialKind: z.string().trim().min(1).max(100) }).strict(),
  capabilityRequestBaseSchema.extend({ kind: z.literal("policy_edit"), policyId: z.string().min(1).max(255) }).strict(),
]);
export type RuntimeCapabilityRequest = z.infer<typeof runtimeCapabilityRequestSchema>;

export const runtimeGrantClassificationSchema = z.enum(["safe_one_run", "revision_required", "never"]);
export type RuntimeGrantClassification = z.infer<typeof runtimeGrantClassificationSchema>;
