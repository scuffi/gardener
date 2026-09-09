import { parseDocument } from "yaml";
import { z } from "zod";
import {
  agentDraftV1Schema,
  agentLimitsV1Schema,
  agentProvenanceV1Schema,
  agentRevisionV1Schema,
  agentSourceV1Schema,
  agentSpecV1Schema,
  compiledAgentRevisionV1Schema,
  repositoryEventTriggerSchema,
  requestedCapabilitySetSchema,
  agentEligibilitySchema,
  policyModeSchema,
  type AgentDraftV1,
  type AgentPackageFileV1,
  type AgentProvenanceV1,
  type AgentRevisionV1,
  type AgentSourceV1,
  type AgentSpecV1,
  type CompiledAgentRevisionV1,
  type RepositoryRef,
} from "@gardener/contracts";
import { canonicalSha256, deepFreeze } from "./stable";

const packagePath = z.string().min(1).max(1_024);
const githubIdInputSchema = z.union([
  z.string().regex(/^[1-9][0-9]{0,31}$/),
  z.number().int().positive().max(Number.MAX_SAFE_INTEGER).transform(String),
]);
const repositoryInputSchema = z.union([githubIdInputSchema, z.literal("this")]);
const frontmatterLimitsSchema = z.object({
  "runtime-seconds": z.number().int().positive().max(86_400).optional(),
  "max-turns": z.number().int().positive().max(128).optional(),
  "max-tool-calls": z.number().int().positive().max(1_024).optional(),
  "max-tasks": z.number().int().positive().max(256).optional(),
  "max-parallel-tasks": z.number().int().positive().max(64).optional(),
  "input-tokens": z.number().int().positive().max(2_000_000).optional(),
  "output-tokens": z.number().int().positive().max(1_000_000).optional(),
  "cost-usd": z.number().nonnegative().max(1_000).optional(),
  operations: z.number().int().positive().max(100).optional(),
  "artifact-bytes": z.number().int().positive().max(1_000_000_000).optional(),
  "retries-per-step": z.number().int().nonnegative().max(10).optional(),
}).strict().default({});
const frontmatterEligibilitySchema = z.object({
  "actor-ids": z.array(githubIdInputSchema).max(100).optional(),
  "resource-author-ids": z.array(githubIdInputSchema).max(100).optional(),
  "labels-any": z.array(z.string()).max(50).optional(),
  "labels-all": z.array(z.string()).max(50).optional(),
  "base-branches": z.array(z.string()).max(50).optional(),
  "include-draft-pull-requests": z.boolean().optional(),
}).strict().default({});
const agentFrontmatterSchema = z.object({
  schema: z.literal("gardener.agent/v1"),
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().min(1).max(1_000),
  triggers: z.array(repositoryEventTriggerSchema).min(1).max(100),
  repositories: z.array(repositoryInputSchema).min(1).max(1_000),
  capabilities: requestedCapabilitySetSchema.optional(),
  "authority-ceiling": policyModeSchema.optional(),
  limits: frontmatterLimitsSchema,
  skills: z.array(packagePath).max(50).optional(),
  evals: z.array(packagePath).max(100).optional(),
  eligibility: frontmatterEligibilitySchema,
}).strict();

type AgentFrontmatter = z.infer<typeof agentFrontmatterSchema>;

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const result = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) result[index] = binary.charCodeAt(index);
  return result;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

export function createAgentSource(agentMd: string | Uint8Array, files: readonly AgentPackageFileV1[] = []): AgentSourceV1 {
  const bytes = typeof agentMd === "string" ? new TextEncoder().encode(agentMd) : agentMd;
  return agentSourceV1Schema.parse({ schemaVersion: "v1", agentMd: { path: "AGENT.md", mediaType: "text/markdown", bytesBase64: encodeBase64(bytes) }, files: [...files] });
}

export function agentSourceText(sourceInput: AgentSourceV1 | unknown): string {
  const source = agentSourceV1Schema.parse(sourceInput);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(decodeBase64(source.agentMd.bytesBase64));
  } catch {
    throw new Error("AGENT.md must contain valid UTF-8 bytes");
  }
}

function splitFrontmatter(text: string): { yaml: string; behavior: string } {
  const normalized = text.replace(/\r\n?/g, "\n");
  if (!normalized.startsWith("---\n")) throw new Error("AGENT.md must begin with YAML frontmatter delimited by ---");
  const closing = normalized.indexOf("\n---\n", 4);
  if (closing < 0) throw new Error("AGENT.md frontmatter is missing its closing --- delimiter");
  return { yaml: normalized.slice(4, closing), behavior: normalized.slice(closing + 5).trim() };
}

function parseFrontmatter(yaml: string): AgentFrontmatter {
  const document = parseDocument(yaml, { strict: true, uniqueKeys: true, merge: false });
  if (document.errors.length) throw new Error(`Invalid AGENT.md YAML: ${document.errors.map((error) => error.message).join("; ")}`);
  if (document.warnings.length) throw new Error(`Invalid AGENT.md YAML: ${document.warnings.map((warning) => warning.message).join("; ")}`);
  return agentFrontmatterSchema.parse(document.toJS({ maxAliasCount: 0 }));
}

function semanticSpec(frontmatter: AgentFrontmatter, behavior: string): AgentSpecV1 {
  const limits = frontmatter.limits;
  const eligibility = frontmatter.eligibility;
  return agentSpecV1Schema.parse({
    schemaVersion: frontmatter.schema,
    name: frontmatter.name,
    description: frontmatter.description,
    triggers: frontmatter.triggers,
    repositories: frontmatter.repositories,
    requestedCapabilities: frontmatter.capabilities ?? {},
    behavior,
    authorityCeiling: frontmatter["authority-ceiling"] ?? "approval",
    limits: {
      runtimeSeconds: limits["runtime-seconds"], maxTurns: limits["max-turns"], maxToolCalls: limits["max-tool-calls"], maxTasks: limits["max-tasks"],
      maxParallelTasks: limits["max-parallel-tasks"], inputTokens: limits["input-tokens"], outputTokens: limits["output-tokens"],
      costUsd: limits["cost-usd"], operations: limits.operations, artifactBytes: limits["artifact-bytes"], retriesPerStep: limits["retries-per-step"],
    },
    skills: frontmatter.skills ?? [], evals: frontmatter.evals ?? [],
    eligibility: {
      actorIds: eligibility["actor-ids"], resourceAuthorIds: eligibility["resource-author-ids"], labelsAny: eligibility["labels-any"],
      labelsAll: eligibility["labels-all"], baseBranches: eligibility["base-branches"], includeDraftPullRequests: eligibility["include-draft-pull-requests"],
    },
  });
}

export function parseAgentSource(sourceInput: AgentSourceV1 | unknown): AgentSpecV1 {
  const source = agentSourceV1Schema.parse(sourceInput);
  const { yaml, behavior } = splitFrontmatter(agentSourceText(source));
  const spec = semanticSpec(parseFrontmatter(yaml), behavior);
  const files = new Map(source.files.map((file) => [file.path, file]));
  for (const path of [...spec.skills, ...spec.evals]) if (!files.has(path)) throw new Error(`Referenced package file does not exist: ${path}`);
  for (const path of spec.skills) {
    const file = files.get(path)!;
    if (!path.startsWith("skills/") || !path.endsWith(".md") || file.mediaType !== "text/markdown") throw new Error(`Skill references must be Markdown files under skills/: ${path}`);
  }
  for (const path of spec.evals) {
    const file = files.get(path)!;
    if (!path.startsWith("evals/") || !/\.(?:ya?ml|json)$/.test(path) || !["application/yaml", "application/json", "text/yaml"].includes(file.mediaType)) throw new Error(`Eval references must be YAML or JSON files under evals/: ${path}`);
  }
  return spec;
}

export interface AgentSourceValidationIssue { path: string; message: string }
export interface AgentSourceValidation { valid: boolean; spec?: AgentSpecV1; issues: AgentSourceValidationIssue[] }
export function validateAgentSource(sourceInput: unknown): AgentSourceValidation {
  try { return { valid: true, spec: parseAgentSource(sourceInput), issues: [] }; }
  catch (error) {
    if (error instanceof z.ZodError) return { valid: false, issues: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })) };
    return { valid: false, issues: [{ path: "AGENT.md", message: error instanceof Error ? error.message : "invalid agent source" }] };
  }
}

export interface CompileAgentRevisionOptions {
  agentId: string; revision: number; revisionId: string; provenance: AgentProvenanceV1; repositories: readonly RepositoryRef[];
  thisRepositoryId?: string; compilerVersion: string; capabilityCatalogVersion: string; runtimeVersion: string; now?: () => Date;
}
export interface CompiledAgentRevisionResult { revision: Readonly<AgentRevisionV1>; compiled: Readonly<CompiledAgentRevisionV1> }

export async function compileAgentRevision(sourceInput: AgentSourceV1 | unknown, options: CompileAgentRevisionOptions): Promise<CompiledAgentRevisionResult> {
  const source = agentSourceV1Schema.parse(sourceInput);
  const spec = parseAgentSource(source);
  const normalizedSource = { ...source, files: [...source.files].sort((left, right) => left.path.localeCompare(right.path)) };
  const sourceHash = await canonicalSha256(normalizedSource);
  const fileByPath = new Map(source.files.map((file) => [file.path, file]));
  const referencedFiles = await Promise.all([
    ...spec.skills.map(async (path) => ({ path, hash: await canonicalSha256(fileByPath.get(path)!.bytesBase64), kind: "skill" as const })),
    ...spec.evals.map(async (path) => ({ path, hash: await canonicalSha256(fileByPath.get(path)!.bytesBase64), kind: "eval" as const })),
  ]);
  referencedFiles.sort((left, right) => left.path.localeCompare(right.path));
  const available = new Map(options.repositories.map((repository) => [repository.id, repository]));
  const resolvedIds = spec.repositories.map((selector) => selector === "this" ? options.thisRepositoryId : selector);
  if (resolvedIds.some((value) => value === undefined)) throw new Error("Repository shorthand 'this' requires compile-time immutable resolution");
  if (new Set(resolvedIds).size !== resolvedIds.length) throw new Error("repository selectors must resolve to unique immutable IDs");
  const repositories = (resolvedIds as string[]).map((repositoryId) => {
    const repository = available.get(repositoryId);
    if (!repository) throw new Error(`Repository is not installed or available: ${repositoryId}`);
    return repository;
  });
  const immutableRepositoryIds = repositories.map((repository) => repository.id).sort();
  const compiledSpec = { ...spec, repositories: immutableRepositoryIds };
  const semanticHash = await canonicalSha256({ spec: compiledSpec, referencedFiles });
  const now = (options.now?.() ?? new Date()).toISOString();
  const provenance = agentProvenanceV1Schema.parse(options.provenance);
  const revision = agentRevisionV1Schema.parse({ schemaVersion: "v1", agentId: options.agentId, revision: options.revision, revisionId: options.revisionId, source, spec, sourceHash, semanticHash, provenance, createdAt: now });
  const compiledIdentity = { agentId: options.agentId, revision: options.revision, revisionId: options.revisionId, sourceHash, semanticHash, repositoryIds: repositories.map((repository) => repository.id), compilerVersion: options.compilerVersion, capabilityCatalogVersion: options.capabilityCatalogVersion, runtimeVersion: options.runtimeVersion };
  const compiledRevisionId = `agent_${await canonicalSha256(compiledIdentity)}`;
  const compiled = compiledAgentRevisionV1Schema.parse({
    schemaVersion: "v1", compiledRevisionId, agentId: options.agentId, revision: options.revision, revisionId: options.revisionId,
    sourceHash, semanticHash, spec: compiledSpec, repositories, referencedFiles, compiler: { id: "gardener-agent-compiler", version: options.compilerVersion },
    capabilityCatalogVersion: options.capabilityCatalogVersion, runtimeVersion: options.runtimeVersion, compiledAt: now,
  });
  return { revision: deepFreeze(revision), compiled: deepFreeze(compiled) };
}

export function createPausedAgentDraft(input: Omit<AgentDraftV1, "schemaVersion" | "status">): Readonly<AgentDraftV1> {
  return deepFreeze(agentDraftV1Schema.parse({ schemaVersion: "v1", status: "paused", ...input }));
}
