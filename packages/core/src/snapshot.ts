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
    throw new Error("run versions do not match the compiled agent revision");
  }
  if (!assignment.enabled || assignment.removedAt !== null) throw new Error("run snapshot requires an enabled, non-removed assignment");
  if (assignment.agentId !== revision.agentId) throw new Error("assignment Agent does not match the compiled revision");
  const [assignmentConfigHash, repositoryPolicyHash, workspacePolicyHash] = await Promise.all([
    calculateAssignmentConfigHash(assignment),
    calculateRepositoryPolicyHash(repositoryPolicy),
    calculateWorkspacePolicyHash(workspacePolicy),
  ]);
  if (assignment.configHash !== assignmentConfigHash) throw new Error("assignment config hash does not match canonical assignment configuration");
  if (repositoryPolicy.policyHash !== repositoryPolicyHash) throw new Error("repository policy hash does not match canonical repository policy");
  if (workspacePolicy.policyHash !== workspacePolicyHash) throw new Error("workspace policy hash does not match canonical workspace policy");
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
  const snapshotHash = await canonicalSha256(content);
  return deepFreeze(agentRunSnapshotV1Schema.parse({ schemaVersion: "v1", createdAt: (options.now?.() ?? new Date()).toISOString(), snapshotHash, ...content }));
}
