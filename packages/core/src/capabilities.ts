import {
  compiledAgentRevisionV1Schema,
  effectiveCapabilitySetSchema,
  instancePolicyV1Schema,
  runtimeCapabilityRequestSchema,
  type CompiledAgentRevisionV1,
  type EffectiveCapabilitySet,
  type InstancePolicyV1,
  type PolicyMode,
  type RuntimeCapabilityRequest,
  type RuntimeGrantClassification,
} from "@gardener/contracts";
import { deepFreeze } from "./stable";

const modeRank: Record<PolicyMode, number> = { disabled: 0, approval: 1, automatic: 2 };
function narrowerMode(left: PolicyMode, right: PolicyMode): PolicyMode {
  return modeRank[left] <= modeRank[right] ? left : right;
}

/** Agent source can only narrow instance authority; it can never grant a capability. */
export function resolveEffectiveCapabilities(
  revisionInput: CompiledAgentRevisionV1 | unknown,
  policyInput: InstancePolicyV1 | unknown,
): Readonly<EffectiveCapabilitySet> {
  const revision = compiledAgentRevisionV1Schema.parse(revisionInput);
  const policy = instancePolicyV1Schema.parse(policyInput);
  const requested = revision.spec.requestedCapabilities;
  const allowedObservations = new Set(policy.allowedObservations);
  const observation = requested.observation.filter((capability) => allowedObservations.has(capability));
  const workspace = requested.workspace.flatMap((capability) => {
    const mode = policy.workspaceModes[capability] ?? "disabled";
    return mode === "disabled" ? [] : [{ capability, mode }];
  });
  const effects = requested.effects.flatMap((capability) => {
    const mode = narrowerMode(policy.operationModes[capability], revision.spec.authorityCeiling);
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
    case "repository_expansion":
    case "persistent_effect":
    case "actor_broadening":
    case "authority_increase":
      return "revision_required";
    case "credentials":
    case "policy_edit":
      return "never";
  }
}
