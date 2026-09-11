import {
  compiledAgentRevisionV1Schema,
  repositoryEventV2Schema,
  type CompiledAgentRevisionV1,
  type RepositoryEventV2,
} from "@gardener/contracts";
import {
  canonicalSha256,
  createAgentRunSnapshot,
  evaluateEventEligibility,
} from "@gardener/core";
import { HARNESS_ADAPTER_VERSIONS } from "./harness";
import { audit, getSetting, instancePolicySnapshot, repositoryPauseSetting } from "./instance-state";
import { admitEventAgentRun, getRun } from "./persistence";
import type { Env } from "./env";
import type { AgentRunWorkflowPayload } from "./runtime";

interface ActiveRevisionRow {
  agent_id: string;
  revision_id: string;
  compiled_json: string;
  compiled_hash: string;
}

export function isCurrentFlueRun(run: { harnessId: string; harnessVersion: string }): boolean {
  return run.harnessId === "flue" && run.harnessVersion === HARNESS_ADAPTER_VERSIONS.flue;
}

export interface AdmittedAgentRun {
  runId: string;
  agentId: string;
  revisionId: string;
  created: boolean;
}

/**
 * Admit every independently eligible Agent revision for one immutable event.
 * Authority is pinned in the run snapshot before any Workflow is created.
 */
export async function admitAgentRunsForEvent(
  env: Env,
  eventInput: RepositoryEventV2 | unknown,
  expectedEnvelopeHash: string,
): Promise<AdmittedAgentRun[]> {
  const event = repositoryEventV2Schema.parse(eventInput);
  if (await getSetting(env.DB, "global_paused") !== "false") return [];
  if (await getSetting(env.DB, repositoryPauseSetting(event.repository.id)) === "true") return [];
  const repository = await env.DB.prepare(
    "SELECT active FROM repositories WHERE id = ? AND installation_id = ?",
  ).bind(event.repository.id, event.repository.installationId).first<{ active: number }>();
  if (repository?.active !== 1) return [];

  const policy = await instancePolicySnapshot(env.DB);
  const { results } = await env.DB.prepare(`
    SELECT a.id AS agent_id, ar.id AS revision_id, ar.compiled_json, ar.compiled_hash
    FROM agents a
    JOIN agent_activations aa ON aa.agent_id = a.id
    JOIN agent_revisions ar ON ar.agent_id = a.id AND ar.id = aa.revision_id
    WHERE a.enabled = 1
    ORDER BY a.id
  `).all<ActiveRevisionRow>();

  const admitted: AdmittedAgentRun[] = [];
  for (const row of results) {
    let revision: CompiledAgentRevisionV1;
    try {
      revision = compiledAgentRevisionV1Schema.parse(JSON.parse(row.compiled_json));
    } catch {
      await audit(env.DB, "runtime", "agent_revision.invalid", "agent_revision", row.revision_id);
      continue;
    }
    if (revision.agentId !== row.agent_id || revision.revisionId !== row.revision_id) continue;
    if (await canonicalSha256(revision) !== row.compiled_hash) {
      await audit(env.DB, "runtime", "agent_revision.hash_mismatch", "agent_revision", row.revision_id);
      continue;
    }
    const decision = evaluateEventEligibility(revision, event);
    if (!decision.eligible) continue;

    const admissionKey = await canonicalSha256({
      eventId: event.id,
      envelopeHash: expectedEnvelopeHash,
      agentId: row.agent_id,
      revisionId: row.revision_id,
      compiledHash: row.compiled_hash,
    });
    const runId = `run_${admissionKey}`;
    const existing = await getRun(env.DB, runId);
    let runSnapshotHash: string;
    let created = false;
    if (existing) {
      // Historical runs retain their original harness identity. A webhook
      // redelivery must never restart one through a different runtime.
      if (!isCurrentFlueRun(existing)) {
        admitted.push({ runId, agentId: row.agent_id, revisionId: row.revision_id, created: false });
        continue;
      }
      runSnapshotHash = existing.runSnapshotHash;
    } else {
      const snapshot = await createAgentRunSnapshot(revision, policy, {
        runId,
        harness: { id: "flue", version: HARNESS_ADAPTER_VERSIONS.flue },
        versions: {
          runtime: revision.runtimeVersion,
          capabilityCatalog: revision.capabilityCatalogVersion,
          compiler: revision.compiler.version,
        },
        now: () => new Date(event.occurredAt),
      });
      if (
        event.kind !== "github.issue"
        || event.action !== "opened"
        || !snapshot.effectiveCapabilities.observation.includes("github.issue.read")
        || snapshot.effectiveCapabilities.effects.find((item) => item.capability === "issue.comment.create")?.mode !== "automatic"
      ) continue;
      const policySnapshotHash = await canonicalSha256(snapshot.instancePolicy);
      const capabilitySnapshotHash = await canonicalSha256(snapshot.effectiveCapabilities);
      const result = await admitEventAgentRun(env.DB, {
        admissionId: `admission_${admissionKey}`,
        admissionKey,
        id: runId,
        kind: "live",
        repositoryEventId: event.id,
        agentId: row.agent_id,
        agentRevisionId: row.revision_id,
        workflowInstanceId: runId,
        parentRunId: null,
        status: "queued",
        runSnapshot: snapshot,
        runSnapshotHash: snapshot.snapshotHash,
        policySnapshot: snapshot.instancePolicy,
        policySnapshotHash,
        capabilitySnapshot: snapshot.effectiveCapabilities,
        capabilitySnapshotHash,
        harnessId: "flue",
        harnessVersion: HARNESS_ADAPTER_VERSIONS.flue,
        budgets: revision.spec.limits,
      });
      runSnapshotHash = result.run.runSnapshotHash;
      created = result.created;
    }

    await ensureWorkflow(env, runId, { runId, runSnapshotHash }, created);
    if (created) {
      await audit(env.DB, "runtime", "agent_run.admitted", "agent_run", runId, {
        eventId: event.id,
        agentId: row.agent_id,
        revisionId: row.revision_id,
      });
    }
    admitted.push({ runId, agentId: row.agent_id, revisionId: row.revision_id, created });
  }
  return admitted;
}

async function ensureWorkflow(
  env: Pick<Env, "DB" | "AGENT_RUN_WORKFLOW">,
  id: string,
  params: AgentRunWorkflowPayload,
  newlyCreated: boolean,
): Promise<void> {
  const binding = env.AGENT_RUN_WORKFLOW as Workflow<AgentRunWorkflowPayload>;
  if (newlyCreated) {
    await binding.create({ id, params });
    return;
  }
  let instance: WorkflowInstance;
  let status: Awaited<ReturnType<WorkflowInstance["status"]>>;
  try {
    instance = await binding.get(id);
    status = await instance.status();
  } catch {
    await binding.create({ id, params });
    return;
  }
  if (["queued", "running", "paused", "waiting", "waitingForPause", "complete"].includes(status.status)) return;
  if (status.status === "unknown") {
    await binding.create({ id, params });
    return;
  }
  const run = await getRun(env.DB, id);
  if (run && !["completed", "completed_with_errors", "failed", "cancelled"].includes(run.status)) {
    await instance.restart();
  }
}
