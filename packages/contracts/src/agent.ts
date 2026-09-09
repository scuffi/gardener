import { z } from "zod";
import { effectCapabilitySchema, observationCapabilitySchema, requestedCapabilitySetSchema, effectiveCapabilitySetSchema, workspaceCapabilitySchema } from "./capabilities";
import { agentEligibilitySchema } from "./eligibility";
import { repositoryEventTriggerSchema } from "./events";
import { authoringPrincipalSchema, githubNumericIdSchema } from "./identity";
import { policyModeSchema, instancePolicyV1Schema } from "./policies";
import { repositoryRefSchema, repositorySelectorSchema } from "./repository";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const identifier = z.string().regex(/^[a-z0-9](?:[a-z0-9._-]{0,253}[a-z0-9])?$/);
const relativePath = z.string().min(1).max(1_024).refine((path) => !path.startsWith("/") && !path.endsWith("/") && !path.includes("\\") && path.split("/").every((component) => component.length > 0 && component !== "." && component !== ".."), "package paths must be normalized POSIX-relative paths");
// Padding alone is not enough for canonical base64: unused low bits in the
// final quantum must also be zero, otherwise multiple strings encode the same bytes.
const base64 = z.string().max(2_800_000).regex(
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/][AQgw]==|[A-Za-z0-9+/]{2}[AEIMQUYcgkosw048]=)?$/,
  "expected canonical base64 bytes",
);

export const agentPackageFileV1Schema = z.object({
  path: relativePath,
  mediaType: z.string().regex(/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/).max(100),
  bytesBase64: base64,
}).strict();
export type AgentPackageFileV1 = z.infer<typeof agentPackageFileV1Schema>;

/** Exact authored package bytes. The parser never replaces this representation with normalized text. */
export const agentSourceV1Schema = z.object({
  schemaVersion: z.literal("v1"),
  agentMd: z.object({ path: z.literal("AGENT.md"), mediaType: z.literal("text/markdown"), bytesBase64: base64 }).strict(),
  files: z.array(agentPackageFileV1Schema).max(100).default([]),
}).strict().superRefine((source, context) => {
  const paths = new Set<string>(["AGENT.md"]); let encodedSize = source.agentMd.bytesBase64.length;
  source.files.forEach((file, index) => {
    if (paths.has(file.path)) context.addIssue({ code: "custom", path: ["files", index, "path"], message: "package paths must be unique" });
    paths.add(file.path); encodedSize += file.bytesBase64.length;
  });
  if (encodedSize > 14_000_000) context.addIssue({ code: "custom", message: "agent package exceeds the 10 MiB encoded-size budget" });
});
export type AgentSourceV1 = z.infer<typeof agentSourceV1Schema>;

export const agentLimitsV1Schema = z.object({
  runtimeSeconds: z.number().int().positive().max(86_400).default(900),
  maxTurns: z.number().int().positive().max(128).default(24),
  maxToolCalls: z.number().int().positive().max(1_024).default(80),
  maxTasks: z.number().int().positive().max(256).default(32),
  maxParallelTasks: z.number().int().positive().max(64).default(8),
  inputTokens: z.number().int().positive().max(2_000_000).default(64_000),
  outputTokens: z.number().int().positive().max(1_000_000).default(16_000),
  costUsd: z.number().nonnegative().max(1_000).default(2),
  operations: z.number().int().positive().max(100).default(10),
  artifactBytes: z.number().int().positive().max(1_000_000_000).default(50_000_000),
  retriesPerStep: z.number().int().nonnegative().max(10).default(2),
}).strict();
export type AgentLimitsV1 = z.infer<typeof agentLimitsV1Schema>;

/** Strict semantic representation produced from YAML frontmatter plus the Markdown body. */
export const agentSpecV1Schema = z.object({
  schemaVersion: z.literal("gardener.agent/v1"),
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().min(1).max(1_000),
  triggers: z.array(repositoryEventTriggerSchema).min(1).max(100),
  repositories: z.array(repositorySelectorSchema).min(1).max(1_000),
  requestedCapabilities: requestedCapabilitySetSchema.default({ observation: [], workspace: [], effects: [] }),
  behavior: z.string().trim().min(1).max(100_000),
  authorityCeiling: policyModeSchema.default("approval"),
  limits: agentLimitsV1Schema.default({ runtimeSeconds: 900, maxTurns: 24, maxToolCalls: 80, maxTasks: 32, maxParallelTasks: 8, inputTokens: 64_000, outputTokens: 16_000, costUsd: 2, operations: 10, artifactBytes: 50_000_000, retriesPerStep: 2 }),
  skills: z.array(relativePath).max(50).default([]),
  evals: z.array(relativePath).max(100).default([]),
  eligibility: agentEligibilitySchema.default({ actorIds: [], resourceAuthorIds: [], labelsAny: [], labelsAll: [], baseBranches: [], includeDraftPullRequests: true }),
}).strict().superRefine((spec, context) => {
  for (const key of ["triggers", "repositories", "skills", "evals"] as const) {
    if (new Set(spec[key]).size !== spec[key].length) context.addIssue({ code: "custom", path: [key], message: `${key} must be unique` });
  }
});
export type AgentSpecV1 = z.infer<typeof agentSpecV1Schema>;

/** Executable semantics: authored repository shorthand has been replaced by immutable IDs. */
export const compiledAgentSpecV1Schema = agentSpecV1Schema.safeExtend({
  repositories: z.array(githubNumericIdSchema).min(1).max(1_000),
});
export type CompiledAgentSpecV1 = z.infer<typeof compiledAgentSpecV1Schema>;

export const agentProvenanceV1Schema = z.object({
  source: z.enum(["dashboard", "git", "mcp", "api", "migration"]),
  authoredBy: authoringPrincipalSchema,
  publishedBy: authoringPrincipalSchema,
  authoredAt: z.iso.datetime(),
  publishedAt: z.iso.datetime(),
  repositoryContext: z.object({ repositoryId: githubNumericIdSchema }).strict().optional(),
  git: z.object({ repositoryId: z.string().regex(/^[1-9][0-9]{0,31}$/), commitSha: z.string().regex(/^[a-fA-F0-9]{40}$/), path: relativePath }).strict().optional(),
}).strict().superRefine((provenance, context) => {
  if (Date.parse(provenance.publishedAt) < Date.parse(provenance.authoredAt)) context.addIssue({ code: "custom", path: ["publishedAt"], message: "publication cannot precede authorship" });
  if (provenance.source === "git" && !provenance.git) context.addIssue({ code: "custom", path: ["git"], message: "Git provenance requires a commit binding" });
});
export type AgentProvenanceV1 = z.infer<typeof agentProvenanceV1Schema>;

export const agentDraftV1Schema = z.object({
  schemaVersion: z.literal("v1"), draftId: identifier, agentId: identifier.nullable(), status: z.literal("paused"),
  source: agentSourceV1Schema, provenance: agentProvenanceV1Schema, createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
}).strict().superRefine((draft, context) => {
  if (Date.parse(draft.updatedAt) < Date.parse(draft.createdAt)) context.addIssue({ code: "custom", path: ["updatedAt"], message: "draft update cannot precede creation" });
});
export type AgentDraftV1 = z.infer<typeof agentDraftV1Schema>;

export const agentRevisionV1Schema = z.object({
  schemaVersion: z.literal("v1"), agentId: identifier, revision: z.number().int().positive(), revisionId: identifier,
  source: agentSourceV1Schema, spec: agentSpecV1Schema, sourceHash: hash, semanticHash: hash,
  provenance: agentProvenanceV1Schema, createdAt: z.iso.datetime(),
}).strict();
export type AgentRevisionV1 = z.infer<typeof agentRevisionV1Schema>;

export const compiledAgentRevisionV1Schema = z.object({
  schemaVersion: z.literal("v1"), compiledRevisionId: z.string().regex(/^agent_[a-f0-9]{64}$/),
  agentId: identifier, revision: z.number().int().positive(), revisionId: identifier, sourceHash: hash, semanticHash: hash,
  spec: compiledAgentSpecV1Schema, repositories: z.array(repositoryRefSchema).min(1).max(1_000),
  referencedFiles: z.array(z.object({ path: relativePath, hash, kind: z.enum(["skill", "eval"]) }).strict()).max(150),
  compiler: z.object({ id: z.literal("gardener-agent-compiler"), version: z.string().min(1).max(100) }).strict(),
  capabilityCatalogVersion: z.string().min(1).max(100), runtimeVersion: z.string().min(1).max(100), compiledAt: z.iso.datetime(),
}).strict().superRefine((revision, context) => {
  const semanticIds = [...revision.spec.repositories].sort();
  const resolvedIds = [...revision.repositories.map((repository) => repository.id)].sort();
  if (semanticIds.length !== resolvedIds.length || semanticIds.some((id, index) => id !== resolvedIds[index])) context.addIssue({ code: "custom", path: ["repositories"], message: "compiled repository references must match immutable semantic repository IDs" });
});
export type CompiledAgentRevisionV1 = z.infer<typeof compiledAgentRevisionV1Schema>;

export const agentRunSnapshotV1Schema = z.object({
  schemaVersion: z.literal("v1"), runId: identifier, createdAt: z.iso.datetime(),
  revision: compiledAgentRevisionV1Schema, instancePolicy: instancePolicyV1Schema, effectiveCapabilities: effectiveCapabilitySetSchema,
  harness: z.object({ id: z.string().min(1).max(255), version: z.string().min(1).max(100) }).strict(),
  versions: z.object({ runtime: z.string().min(1).max(100), capabilityCatalog: z.string().min(1).max(100), compiler: z.string().min(1).max(100) }).strict(),
  snapshotHash: hash,
}).strict();
export type AgentRunSnapshotV1 = z.infer<typeof agentRunSnapshotV1Schema>;

export const agentSemanticDiffV1Schema = z.object({
  fromRevisionId: identifier.nullable(), toRevisionId: identifier,
  triggers: z.object({ added: z.array(repositoryEventTriggerSchema).max(100), removed: z.array(repositoryEventTriggerSchema).max(100) }).strict(),
  repositories: z.object({ added: z.array(githubNumericIdSchema).max(1_000), removed: z.array(githubNumericIdSchema).max(1_000) }).strict(),
  capabilities: z.object({
    observationAdded: z.array(observationCapabilitySchema).max(observationCapabilitySchema.options.length), observationRemoved: z.array(observationCapabilitySchema).max(observationCapabilitySchema.options.length),
    workspaceAdded: z.array(workspaceCapabilitySchema).max(workspaceCapabilitySchema.options.length), workspaceRemoved: z.array(workspaceCapabilitySchema).max(workspaceCapabilitySchema.options.length),
    effectsAdded: z.array(effectCapabilitySchema).max(effectCapabilitySchema.options.length), effectsRemoved: z.array(effectCapabilitySchema).max(effectCapabilitySchema.options.length),
  }).strict(),
  authority: z.object({ from: policyModeSchema.nullable(), to: policyModeSchema, increased: z.boolean() }).strict(),
  metadata: z.object({
    name: z.object({ from: z.string().max(100).nullable(), to: z.string().max(100), changed: z.boolean() }).strict(),
    description: z.object({ from: z.string().max(1_000).nullable(), to: z.string().max(1_000), changed: z.boolean() }).strict(),
  }).strict(),
  limitsChanged: z.boolean(), behaviorChanged: z.boolean(), eligibilityChanged: z.boolean(), skillsChanged: z.boolean(), evalsChanged: z.boolean(),
}).strict();
export type AgentSemanticDiffV1 = z.infer<typeof agentSemanticDiffV1Schema>;
