import {
  agentRepositoryAssignmentV1Schema,
  agentRunSnapshotV1Schema,
  compiledAgentRevisionV1Schema,
  instancePolicyV1Schema,
  repositoryPolicyV1Schema,
  type AgentRepositoryAssignmentV1,
  type AgentRunSnapshotV1,
  type CompiledAgentRevisionV1,
  type InstancePolicyV1,
  type RepositoryPolicyV1,
} from "@gardener/contracts";
import { resolveEffectiveCapabilities, resolveEffectiveMode } from "./capabilities";
import { canonicalSha256, deepFreeze } from "./stable";

export interface CreateAgentRunSnapshotOptions {
  runId: string;
  harness: { id: string; version: string };
  versions: { runtime: string; capabilityCatalog: string; compiler: string };
  now?: () => Date;
}

export type AgentRunSnapshotValidationErrorCode =
  | "revision_version_mismatch"
  | "assignment_not_active"
  | "assignment_agent_mismatch"
  | "assignment_hash_mismatch"
  | "repository_policy_hash_mismatch"
  | "workspace_policy_hash_mismatch";

const snapshotValidationMessages: Record<AgentRunSnapshotValidationErrorCode, string> = {
  revision_version_mismatch: "run versions do not match the compiled agent revision",
  assignment_not_active: "run snapshot requires an enabled, non-removed assignment",
  assignment_agent_mismatch: "assignment Agent does not match the compiled revision",
  assignment_hash_mismatch: "assignment config hash does not match canonical assignment configuration",
  repository_policy_hash_mismatch: "repository policy hash does not match canonical repository policy",
  workspace_policy_hash_mismatch: "workspace policy hash does not match canonical workspace policy",
};

/** Stable classification for deterministic snapshot-construction rejections. */
export class AgentRunSnapshotValidationError extends Error {
  readonly name = "AgentRunSnapshotValidationError";

  constructor(readonly code: AgentRunSnapshotValidationErrorCode) {
    super(snapshotValidationMessages[code]);
  }
}

type AgentRunSnapshotHashContent = Omit<AgentRunSnapshotV1, "schemaVersion" | "createdAt" | "snapshotHash">;

/** Returns the complete canonical content bound by an Agent run snapshot hash. */
export function agentRunSnapshotHashContent(snapshot: AgentRunSnapshotV1): AgentRunSnapshotHashContent {
  return {
    runId: snapshot.runId,
    revision: snapshot.revision,
    assignment: snapshot.assignment,
    repository: snapshot.repository,
    workspace: snapshot.workspace,
    effectiveConstraints: snapshot.effectiveConstraints,
    effectiveAuthority: snapshot.effectiveAuthority,
    effectiveCapabilities: snapshot.effectiveCapabilities,
    harness: snapshot.harness,
    versions: snapshot.versions,
  };
}

/** Hashes only assignment configuration; identity/version/audit/display fields are bound separately. */
export async function calculateAssignmentConfigHash(assignment: Omit<AgentRepositoryAssignmentV1, "configHash"> | AgentRepositoryAssignmentV1): Promise<string> {
  const parsed = agentRepositoryAssignmentV1Schema.parse({ ...assignment, configHash: "configHash" in assignment ? assignment.configHash : "0".repeat(64) });
  return canonicalSha256({
    agentId: parsed.agentId,
    repositoryId: parsed.repositoryId,
    enabled: parsed.enabled,
    authorityCeiling: parsed.authorityCeiling,
    removedAt: parsed.removedAt,
  });
}

/** Hashes the complete repository authority layer, excluding transport/display metadata and its attested hash. */
export async function calculateRepositoryPolicyHash(policy: Omit<RepositoryPolicyV1, "policyHash"> | RepositoryPolicyV1): Promise<string> {
  const parsed = repositoryPolicyV1Schema.parse({ ...policy, policyHash: "policyHash" in policy ? policy.policyHash : "0".repeat(64) });
  return canonicalSha256({
    repositoryId: parsed.repositoryId,
    operationModes: parsed.operationModes,
    allowedObservations: [...parsed.allowedObservations].sort(),
    workspaceModes: parsed.workspaceModes,
  });
}

/** Hashes the complete workspace authority and constraint layer. */
export async function calculateWorkspacePolicyHash(policy: Omit<InstancePolicyV1, "policyHash"> | InstancePolicyV1): Promise<string> {
  const parsed = instancePolicyV1Schema.parse({ ...policy, policyHash: "policyHash" in policy ? policy.policyHash : "0".repeat(64) });
  return canonicalSha256({
    operationModes: parsed.operationModes,
    allowedObservations: [...parsed.allowedObservations].sort(),
    workspaceModes: parsed.workspaceModes,
    allowedMergeMethods: [...parsed.allowedMergeMethods].sort(),
    requiredChecks: [...parsed.requiredChecks].sort(),
    maxCommentLength: parsed.maxCommentLength,
    maxChangedFiles: parsed.maxChangedFiles,
    deniedPathPrefixes: [...parsed.deniedPathPrefixes].sort(),
  });
}

export async function createAgentRunSnapshot(
  revisionInput: CompiledAgentRevisionV1 | unknown,
  workspacePolicyInput: InstancePolicyV1 | unknown,
  repositoryPolicyInput: RepositoryPolicyV1 | unknown,
  assignmentInput: AgentRepositoryAssignmentV1 | unknown,
  options: CreateAgentRunSnapshotOptions,
): Promise<Readonly<AgentRunSnapshotV1>> {
  const revision = compiledAgentRevisionV1Schema.parse(revisionInput);
  const workspacePolicy = instancePolicyV1Schema.parse(workspacePolicyInput);
  const repositoryPolicy = repositoryPolicyV1Schema.parse(repositoryPolicyInput);
  const assignment = agentRepositoryAssignmentV1Schema.parse(assignmentInput);
  if (options.versions.runtime !== revision.runtimeVersion || options.versions.capabilityCatalog !== revision.capabilityCatalogVersion || options.versions.compiler !== revision.compiler.version) {
    throw new AgentRunSnapshotValidationError("revision_version_mismatch");
  }
  if (!assignment.enabled || assignment.removedAt !== null) throw new AgentRunSnapshotValidationError("assignment_not_active");
  if (assignment.agentId !== revision.agentId) throw new AgentRunSnapshotValidationError("assignment_agent_mismatch");
  const [assignmentConfigHash, repositoryPolicyHash, workspacePolicyHash] = await Promise.all([
    calculateAssignmentConfigHash(assignment),
    calculateRepositoryPolicyHash(repositoryPolicy),
    calculateWorkspacePolicyHash(workspacePolicy),
  ]);
  if (assignment.configHash !== assignmentConfigHash) throw new AgentRunSnapshotValidationError("assignment_hash_mismatch");
  if (repositoryPolicy.policyHash !== repositoryPolicyHash) throw new AgentRunSnapshotValidationError("repository_policy_hash_mismatch");
  if (workspacePolicy.policyHash !== workspacePolicyHash) throw new AgentRunSnapshotValidationError("workspace_policy_hash_mismatch");
  const effectiveCapabilities = resolveEffectiveCapabilities(revision, workspacePolicy, repositoryPolicy, assignment);
  const effectiveAuthority = revision.spec.requestedCapabilities.effects.map((capability) => {
    const workspace = workspacePolicy.operationModes[capability];
    const repository = repositoryPolicy.operationModes[capability] ?? "disabled";
    const agent = revision.spec.authorityCeiling;
    const assignmentMode = assignment.authorityCeiling;
    return { capability, layers: { workspace, repository, agent, assignment: assignmentMode, effective: resolveEffectiveMode(workspace, repository, agent, assignmentMode) } };
  }).sort((left, right) => left.capability.localeCompare(right.capability));
  const effectiveConstraints = {
    allowedMergeMethods: [...workspacePolicy.allowedMergeMethods].sort(),
    requiredChecks: [...workspacePolicy.requiredChecks].sort(),
    maxCommentLength: workspacePolicy.maxCommentLength,
    maxChangedFiles: workspacePolicy.maxChangedFiles,
    deniedPathPrefixes: [...workspacePolicy.deniedPathPrefixes].sort(),
  };
  const content = {
    runId: options.runId,
    revision,
    assignment: { id: assignment.id, version: assignment.version, configHash: assignmentConfigHash },
    repository: { id: assignment.repositoryId, policyHash: repositoryPolicyHash, policyVersion: repositoryPolicy.version },
    workspace: { policyHash: workspacePolicyHash, policyVersion: workspacePolicy.version },
    effectiveConstraints,
    effectiveAuthority,
    effectiveCapabilities,
    harness: options.harness,
    versions: options.versions,
  };
  const createdAt = (options.now?.() ?? new Date()).toISOString();
  const draft = agentRunSnapshotV1Schema.parse({ schemaVersion: "v1", createdAt, snapshotHash: "0".repeat(64), ...content });
  const snapshotHash = await canonicalSha256(agentRunSnapshotHashContent(draft));
  return deepFreeze(agentRunSnapshotV1Schema.parse({ ...draft, snapshotHash }));
}
