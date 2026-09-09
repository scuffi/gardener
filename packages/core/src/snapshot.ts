import { agentRunSnapshotV1Schema, compiledAgentRevisionV1Schema, instancePolicyV1Schema, type AgentRunSnapshotV1, type CompiledAgentRevisionV1, type InstancePolicyV1 } from "@gardener/contracts";
import { resolveEffectiveCapabilities } from "./capabilities";
import { canonicalSha256, deepFreeze } from "./stable";

export interface CreateAgentRunSnapshotOptions {
  runId: string;
  harness: { id: string; version: string };
  versions: { runtime: string; capabilityCatalog: string; compiler: string };
  now?: () => Date;
}

export async function createAgentRunSnapshot(revisionInput: CompiledAgentRevisionV1 | unknown, policyInput: InstancePolicyV1 | unknown, options: CreateAgentRunSnapshotOptions): Promise<Readonly<AgentRunSnapshotV1>> {
  const revision = compiledAgentRevisionV1Schema.parse(revisionInput);
  const instancePolicy = instancePolicyV1Schema.parse(policyInput);
  if (options.versions.runtime !== revision.runtimeVersion || options.versions.capabilityCatalog !== revision.capabilityCatalogVersion || options.versions.compiler !== revision.compiler.version) {
    throw new Error("run versions do not match the compiled agent revision");
  }
  const effectiveCapabilities = resolveEffectiveCapabilities(revision, instancePolicy);
  const content = { runId: options.runId, revision, instancePolicy, effectiveCapabilities, harness: options.harness, versions: options.versions };
  const snapshotHash = await canonicalSha256(content);
  return deepFreeze(agentRunSnapshotV1Schema.parse({ schemaVersion: "v1", createdAt: (options.now?.() ?? new Date()).toISOString(), snapshotHash, ...content }));
}
