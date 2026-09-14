import {
  compiledAgentRevisionV1Schema,
  effectiveCapabilitySetSchema,
  instancePolicyV1Schema,
  repositoryPolicyV1Schema,
  agentRepositoryAssignmentV1Schema,
  runtimeCapabilityRequestSchema,
  type AgentRepositoryAssignmentV1,
  type CompiledAgentRevisionV1,
  type EffectiveCapabilitySet,
  type InstancePolicyV1,
  type PolicyMode,
  type RepositoryPolicyV1,
  type RuntimeCapabilityRequest,
  type RuntimeGrantClassification,
} from "@gardener/contracts";
import { deepFreeze } from "./stable";

const modeRank: Record<PolicyMode, number> = { disabled: 0, approval: 1, automatic: 2 };
export function resolveEffectiveMode(
  workspaceCeiling: PolicyMode,
  repositoryMode: PolicyMode | undefined,
  agentCeiling: PolicyMode,
  assignmentCeiling: PolicyMode,
): PolicyMode {
  const modes: PolicyMode[] = [workspaceCeiling, repositoryMode ?? "disabled", agentCeiling, assignmentCeiling];
  return modes.reduce((narrowest, mode) => modeRank[mode] < modeRank[narrowest] ? mode : narrowest, "automatic");
}

/** Every layer can only narrow authority. Missing repository capability policy fails closed. */
export function resolveEffectiveCapabilities(
  revisionInput: CompiledAgentRevisionV1 | unknown,
  workspacePolicyInput: InstancePolicyV1 | unknown,
  repositoryPolicyInput: RepositoryPolicyV1 | unknown,
  assignmentInput: AgentRepositoryAssignmentV1 | unknown,
): Readonly<EffectiveCapabilitySet> {
  const revision = compiledAgentRevisionV1Schema.parse(revisionInput);
  const workspacePolicy = instancePolicyV1Schema.parse(workspacePolicyInput);
  const repositoryPolicy = repositoryPolicyV1Schema.parse(repositoryPolicyInput);
  const assignment = agentRepositoryAssignmentV1Schema.parse(assignmentInput);
  if (assignment.agentId !== revision.agentId) throw new Error("assignment Agent does not match the compiled revision");
  if (assignment.repositoryId !== repositoryPolicy.repositoryId) throw new Error("assignment repository does not match repository policy");
  const requested = revision.spec.requestedCapabilities;
  const workspaceObservations = new Set(workspacePolicy.allowedObservations);
  const repositoryObservations = new Set(repositoryPolicy.allowedObservations);
  const observation = requested.observation.filter((capability) => workspaceObservations.has(capability) && repositoryObservations.has(capability));
  const workspace = requested.workspace.flatMap((capability) => {
    const workspaceMode = workspacePolicy.workspaceModes[capability] ?? "disabled";
    const repositoryMode = repositoryPolicy.workspaceModes[capability] ?? "disabled";
    const mode = modeRank[workspaceMode] <= modeRank[repositoryMode] ? workspaceMode : repositoryMode;
    return mode === "disabled" ? [] : [{ capability, mode }];
  });
  const effects = requested.effects.flatMap((capability) => {
    const mode = resolveEffectiveMode(workspacePolicy.operationModes[capability], repositoryPolicy.operationModes[capability], revision.spec.authorityCeiling, assignment.authorityCeiling);
    return mode === "disabled" ? [] : [{ capability, mode }];
  });
  return deepFreeze(effectiveCapabilitySetSchema.parse({ observation, workspace, effects }));
}

/** Execution-time DNS guard. Re-run for every connection to prevent DNS rebinding. */
export function networkResolutionIsPublic(addresses: readonly string[]): boolean {
  if (addresses.length === 0) return false;
  return addresses.every((address) => {
    if (address.includes(":")) return false; // IPv6 remains denied until a complete classifier is installed.
    const octets = address.split(".").map(Number);
    if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return false;
    const [a, b] = octets as [number, number, number, number];
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && (b === 0 || b === 168)) return false;
    if (a === 198 && (b === 18 || b === 19 || b === 51)) return false;
    if (a === 203 && b === 0) return false;
    return true;
  });
}

export function classifyRuntimeCapabilityRequest(requestInput: RuntimeCapabilityRequest | unknown): RuntimeGrantClassification {
  const request = runtimeCapabilityRequestSchema.parse(requestInput);
  switch (request.kind) {
    case "observation":
    case "workspace":
    case "container":
    case "network":
      return "safe_one_run";
    case "persistent_effect":
    case "actor_broadening":
    case "authority_increase":
      return "revision_required";
    case "credentials":
    case "policy_edit":
      return "never";
  }
}
