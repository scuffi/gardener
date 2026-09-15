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
import type { AgentRunWorkflowPayload } from "./runtime";
import { ZodError } from "zod";

interface ActiveAssignmentRevisionRow {
  assignment_id: string;
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

function deterministicParseCode(error: unknown): "invalid_json" | "invalid_schema" | null {
  if (error instanceof SyntaxError) return "invalid_json";
  if (error instanceof ZodError) return "invalid_schema";
  return null;
}

function isWorkflowInstanceNotFound(error: unknown): boolean {
  if (typeof error === "object" && error !== null && "code" in error
    && (error as { code?: unknown }).code === "instance.not_found") return true;
  return error instanceof Error && error.message.startsWith("instance.not_found");
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
      if (isCurrentFlueRun(existing)) await ensureWorkflow(env, runId, { runId, runSnapshotHash: existing.runSnapshotHash }, false);
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
          // This latch is per event; the unconfigured-policy audit is permanently deduped by migration 0007.
          await recordUnconfiguredPolicy(env.DB, event.repository.id);
          policyUnavailable = true;
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
    if (policyUnavailable || !workspacePolicy || !repositoryPolicy?.configured) continue;

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
    if (
      event.kind !== "github.issue"
      || event.action !== "opened"
      || !snapshot.effectiveCapabilities.observation.includes("github.issue.read")
      || snapshot.effectiveCapabilities.effects.find((item) => item.capability === "issue.comment.create")?.mode !== "automatic"
    ) continue;
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
    });
    // Workflow and persistence failures must escape so the event lease is released and redelivery reconciles this run.
    await ensureWorkflow(env, result.run.id, { runId: result.run.id, runSnapshotHash: result.run.runSnapshotHash }, result.created);
    if (result.created) await audit(env.DB, "runtime", "agent_run.admitted", "agent_run", result.run.id, { eventId: event.id, agentId: row.agent_id, revisionId: row.revision_id });
    admitted.push({ runId: result.run.id, agentId: row.agent_id, revisionId: row.revision_id, created: result.created });
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
  try {
    instance = await binding.get(id);
  } catch (error) {
    if (!isWorkflowInstanceNotFound(error)) throw error;
    await binding.create({ id, params });
    return;
  }
  const status = await instance.status();
  if (["queued", "running", "paused", "waiting", "waitingForPause", "complete"].includes(status.status)) return;
  if (status.status === "unknown") {
    await binding.create({ id, params });
    return;
  }
  const run = await getRun(env.DB, id);
  if (run && !["completed", "completed_with_errors", "failed", "cancelled"].includes(run.status)) await instance.restart();
}
