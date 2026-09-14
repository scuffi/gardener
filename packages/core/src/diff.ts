import { agentSemanticDiffV1Schema, compiledAgentRevisionV1Schema, type AgentSemanticDiffV1, type CompiledAgentRevisionV1, type PolicyMode } from "@gardener/contracts";
import { canonicalJson, deepFreeze } from "./stable";

function difference(left: readonly string[], right: readonly string[]): string[] {
  const other = new Set(right);
  return [...new Set(left)].filter((value) => !other.has(value)).sort();
}
const rank: Record<PolicyMode, number> = { disabled: 0, approval: 1, automatic: 2 };

export function diffAgentRevisions(fromInput: CompiledAgentRevisionV1 | null | unknown, toInput: CompiledAgentRevisionV1 | unknown): Readonly<AgentSemanticDiffV1> {
  const from = fromInput === null ? null : compiledAgentRevisionV1Schema.parse(fromInput);
  const to = compiledAgentRevisionV1Schema.parse(toInput);
  const before = from?.spec;
  const after = to.spec;
  return deepFreeze(agentSemanticDiffV1Schema.parse({
    fromRevisionId: from?.revisionId ?? null,
    toRevisionId: to.revisionId,
    triggers: { added: difference(after.triggers, before?.triggers ?? []), removed: difference(before?.triggers ?? [], after.triggers) },
    capabilities: {
      observationAdded: difference(after.requestedCapabilities.observation, before?.requestedCapabilities.observation ?? []),
      observationRemoved: difference(before?.requestedCapabilities.observation ?? [], after.requestedCapabilities.observation),
      workspaceAdded: difference(after.requestedCapabilities.workspace, before?.requestedCapabilities.workspace ?? []),
      workspaceRemoved: difference(before?.requestedCapabilities.workspace ?? [], after.requestedCapabilities.workspace),
      effectsAdded: difference(after.requestedCapabilities.effects, before?.requestedCapabilities.effects ?? []),
      effectsRemoved: difference(before?.requestedCapabilities.effects ?? [], after.requestedCapabilities.effects),
    },
    authority: { from: before?.authorityCeiling ?? null, to: after.authorityCeiling, increased: before ? rank[after.authorityCeiling] > rank[before.authorityCeiling] : false },
    metadata: {
      name: { from: before?.name ?? null, to: after.name, changed: before?.name !== after.name },
      description: { from: before?.description ?? null, to: after.description, changed: before?.description !== after.description },
    },
    limitsChanged: canonicalJson(before?.limits) !== canonicalJson(after.limits),
    behaviorChanged: before?.behavior !== after.behavior,
    eligibilityChanged: canonicalJson(before?.eligibility) !== canonicalJson(after.eligibility),
    skillsChanged: canonicalJson(from?.referencedFiles.filter((file) => file.kind === "skill") ?? []) !== canonicalJson(to.referencedFiles.filter((file) => file.kind === "skill")),
    evalsChanged: canonicalJson(from?.referencedFiles.filter((file) => file.kind === "eval") ?? []) !== canonicalJson(to.referencedFiles.filter((file) => file.kind === "eval")),
  }));
}
