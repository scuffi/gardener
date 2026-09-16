import {
  compiledAgentRevisionV1Schema,
  repositoryEventV2Schema,
  type CompiledAgentRevisionV1,
  type InstancePolicyV1,
  type RepositoryEventV2,
} from "@gardener/contracts";
import {
  AgentRunSnapshotValidationError,
  canonicalSha256,
  createAgentRunSnapshot,
  evaluateEventEligibility,
} from "@gardener/core";
import { HARNESS_ADAPTER_VERSIONS } from "./harness";
import {
  audit,
  getSetting,
  instancePolicySnapshot,
  repositoryPauseSetting,
  WorkspacePolicyReadError,
} from "./instance-state";
import { admitEventAgentRun, getAssignment, getRun } from "./persistence";
import {
  getRepositoryPolicy,
  RepositoryPolicyReadError,
  type RepositoryPolicyView,
} from "./repository-policy";
import type { Env } from "./env";
import { createInitialFlueRequest, ensureInitialFlueDispatch } from "./flue-native-runtime";
import {
  FLUE_NATIVE_DRIVER,
  FLUE_NATIVE_PROFILE,
  FLUE_NATIVE_REQUEST_PROTOCOL,
} from "./flue-native-protocol";
import { ZodError } from "zod";

interface ActiveAssignmentRevisionRow {
  assignment_id: string;
  agent_id: string;
  revision_id: string;
  compiled_json: string;
  compiled_hash: string;
}

export function isCurrentFlueRun(run: {
  harnessId: string;
  harnessVersion: string;
  runtimeDriver?: string;
  nativeProfile?: string | null;
  nativeRequestProtocol?: string | null;
}): boolean {
  return run.runtimeDriver === FLUE_NATIVE_DRIVER
    && run.nativeProfile === FLUE_NATIVE_PROFILE
    && run.nativeRequestProtocol === FLUE_NATIVE_REQUEST_PROTOCOL
    && run.harnessId === "flue"
    && run.harnessVersion === HARNESS_ADAPTER_VERSIONS.flue;
}

export interface AdmittedAgentRun {
  runId: string;
  agentId: string;
  revisionId: string;
  created: boolean;
}

function deterministicParseCode(error: unknown): "invalid_json" | "invalid_schema" | null {
  if (error instanceof SyntaxError) return "invalid_json";
  if (error instanceof ZodError) return "invalid_schema";
  return null;
}

async function recordUnconfiguredPolicy(db: D1Database, repositoryId: string): Promise<void> {
  await db.prepare(`
    INSERT OR IGNORE INTO audit_records(actor, action, resource_type, resource_id, detail_json)
    VALUES ('runtime', 'repository.policy_unconfigured', 'repository', ?, NULL)
  `).bind(repositoryId).run();
}

/** Admit every independently eligible exact-repository assignment. */
export async function admitAgentRunsForEvent(
  env: Env,
  eventInput: RepositoryEventV2 | unknown,
  expectedEnvelopeHash: string,
): Promise<AdmittedAgentRun[]> {
  const event = repositoryEventV2Schema.parse(eventInput);
  if (await canonicalSha256(event) !== expectedEnvelopeHash) throw new Error("Repository event envelope hash mismatch");
  if (await getSetting(env.DB, "global_paused") !== "false") return [];
  if (await getSetting(env.DB, repositoryPauseSetting(event.repository.id)) === "true") return [];
  const repository = await env.DB.prepare(
    "SELECT active FROM repositories WHERE id = ? AND installation_id = ?",
  ).bind(event.repository.id, event.repository.installationId).first<{ active: number }>();
  if (repository?.active !== 1) return [];

  const { results } = await env.DB.prepare(`
    SELECT ara.id AS assignment_id, ara.agent_id, ar.id AS revision_id, ar.compiled_json, ar.compiled_hash
    FROM agent_repository_assignments ara
    JOIN agent_activations aa ON aa.agent_id = ara.agent_id
    JOIN agent_revisions ar ON ar.agent_id = ara.agent_id AND ar.id = aa.revision_id
    WHERE ara.repository_id = ? AND ara.enabled = 1 AND ara.removed_at IS NULL
    ORDER BY ara.agent_id
  `).bind(event.repository.id).all<ActiveAssignmentRevisionRow>();

  let workspacePolicy: InstancePolicyV1 | null = null;
  let repositoryPolicy: RepositoryPolicyView | null = null;
  let policyUnavailable = false;
  const admitted: AdmittedAgentRun[] = [];
  for (const row of results) {
    let revision: CompiledAgentRevisionV1;
    try {
      revision = compiledAgentRevisionV1Schema.parse(JSON.parse(row.compiled_json));
    } catch (error) {
      const code = deterministicParseCode(error);
      if (!code) throw error;
      await audit(env.DB, "runtime", "agent_revision.invalid", "agent_revision", row.revision_id, { code });
      continue;
    }
    if (revision.agentId !== row.agent_id || revision.revisionId !== row.revision_id) continue;
    if (await canonicalSha256(revision) !== row.compiled_hash) {
      await audit(env.DB, "runtime", "agent_revision.hash_mismatch", "agent_revision", row.revision_id);
      continue;
    }
    let assignment;
    try {
      assignment = await getAssignment(env.DB, row.assignment_id);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "assignment_config_hash_invalid") throw error;
      await audit(env.DB, "runtime", "assignment.invalid", "agent_repository_assignment", row.assignment_id, {
        code: "config_hash_mismatch",
      });
      continue;
    }
    if (!assignment || !assignment.enabled || assignment.removedAt !== null
      || assignment.agentId !== row.agent_id || assignment.repositoryId !== event.repository.id) continue;
    if (!evaluateEventEligibility(revision, event, assignment.repositoryId).eligible) continue;

    const admissionKey = await canonicalSha256({ eventId: event.id, agentId: row.agent_id, revisionId: row.revision_id });
    const runId = `run_${admissionKey}`;
    const existing = await getRun(env.DB, runId);
    if (existing) {
      if (!isCurrentFlueRun(existing)) {
        if (!["completed", "completed_with_errors", "failed", "cancelled"].includes(existing.status)) {
          throw new Error("legacy workflow-v1 run cannot be resumed by the Flue-native runtime");
        }
      } else if (!existing.cancelRequestedAt) await ensureInitialFlueDispatch(env, runId);
      admitted.push({ runId, agentId: row.agent_id, revisionId: row.revision_id, created: false });
      continue;
    }

    if (!workspacePolicy && !policyUnavailable) {
      try {
        [workspacePolicy, repositoryPolicy] = await Promise.all([
          instancePolicySnapshot(env.DB),
          getRepositoryPolicy(env.DB, event.repository.id),
        ]);
        if (!repositoryPolicy?.configured) {
          // Missing repository authority is represented by the complete all-disabled snapshot returned
          // by getRepositoryPolicy. It must not suppress the Agent's model run: policy gates effects,
          // not whether a matching assigned Agent gets to observe and reason about its trigger event.
          await recordUnconfiguredPolicy(env.DB, event.repository.id);
        }
      } catch (error) {
        const explicitCode = error instanceof RepositoryPolicyReadError
          ? error.code
          : error instanceof WorkspacePolicyReadError
            ? error.code
            : deterministicParseCode(error);
        if (!explicitCode) throw error;
        await audit(env.DB, "runtime", "policy.invalid", "repository", event.repository.id, { code: explicitCode });
        policyUnavailable = true;
      }
    }
    if (policyUnavailable || !workspacePolicy || !repositoryPolicy) continue;

    let snapshot: Awaited<ReturnType<typeof createAgentRunSnapshot>>;
    try {
      snapshot = await createAgentRunSnapshot(revision, workspacePolicy, repositoryPolicy.policy, assignment, {
        runId,
        harness: { id: "flue", version: HARNESS_ADAPTER_VERSIONS.flue },
        versions: {
          runtime: revision.runtimeVersion,
          capabilityCatalog: revision.capabilityCatalogVersion,
          compiler: revision.compiler.version,
        },
        now: () => new Date(event.occurredAt),
      });
    } catch (error) {
      if (!(error instanceof AgentRunSnapshotValidationError)) throw error;
      await audit(env.DB, "runtime", "run_admission.invalid", "agent_repository_assignment", row.assignment_id, { code: error.code });
      continue;
    }
    // Trigger/eligibility and assignment state decide whether the Agent runs. Frozen capabilities
    // decide what that run may observe through tools and which proposed effects may execute.
    if (event.kind !== "github.issue" || event.action !== "opened") continue;
    const capabilitySnapshotHash = await canonicalSha256(snapshot.effectiveCapabilities);
    const initialRequest = await createInitialFlueRequest({
      runId,
      agentRevisionId: row.revision_id,
      runSnapshotHash: snapshot.snapshotHash,
      policySnapshotHash: workspacePolicy.policyHash,
      runSnapshot: snapshot,
      event,
      modelId: env.AI_MODEL,
      admittedAt: new Date().toISOString(),
    });
    const result = await admitEventAgentRun(env.DB, {
        admissionId: `admission_${admissionKey}`,
        admissionKey,
        id: runId,
        kind: "live",
        repositoryEventId: event.id,
        agentId: row.agent_id,
        agentRevisionId: row.revision_id,
        workflowInstanceId: null,
        runtimeDriver: FLUE_NATIVE_DRIVER,
        nativeModelId: env.AI_MODEL,
        nativeProfile: FLUE_NATIVE_PROFILE,
        nativeRequestProtocol: FLUE_NATIVE_REQUEST_PROTOCOL,
        parentRunId: null,
        status: "queued",
        runSnapshot: snapshot,
        runSnapshotHash: snapshot.snapshotHash,
        policySnapshot: workspacePolicy,
        policySnapshotHash: workspacePolicy.policyHash,
        capabilitySnapshot: snapshot.effectiveCapabilities,
        capabilitySnapshotHash,
        harnessId: "flue",
        harnessVersion: HARNESS_ADAPTER_VERSIONS.flue,
        budgets: revision.spec.limits,
        repositoryId: snapshot.repository.id,
        assignmentId: snapshot.assignment.id,
        assignmentVersion: snapshot.assignment.version,
        assignmentConfigHash: snapshot.assignment.configHash,
        repositoryPolicyHash: snapshot.repository.policyHash,
        repositoryPolicyVersion: snapshot.repository.policyVersion,
        initialHarnessRequest: {
          requestId: initialRequest.requestId,
          harnessId: initialRequest.snapshot.harness.id,
          harnessVersion: initialRequest.snapshot.harness.adapterVersion,
          requestJson: JSON.stringify(initialRequest),
          requestHash: await canonicalSha256(initialRequest),
        },
    });
    // Dispatch and persistence failures escape; the durable outbox remains available to Cron.
    await ensureInitialFlueDispatch(env, result.run.id);
    if (result.created) await audit(env.DB, "runtime", "agent_run.admitted", "agent_run", result.run.id, { eventId: event.id, agentId: row.agent_id, revisionId: row.revision_id });
    admitted.push({ runId: result.run.id, agentId: row.agent_id, revisionId: row.revision_id, created: result.created });
  }
  return admitted;
}
