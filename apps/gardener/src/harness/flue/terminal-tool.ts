import {
  agentRunSnapshotV1Schema,
  instancePolicyV1Schema,
  operationSchema,
  repositoryEventV2Schema,
  type AgentRunSnapshotV1,
  type Operation,
  type PolicyMode,
} from "@gardener/contracts";
import {
  agentRunSnapshotHashContent,
  calculateWorkspacePolicyHash,
  canonicalOperationHash,
  canonicalSha256,
} from "@gardener/core";
import type { ToolStep } from "@flue/runtime";
import * as v from "valibot";
import type { Env } from "../../env";
import {
  FLUE_NATIVE_DRIVER,
  FLUE_NATIVE_PROFILE,
  FLUE_NATIVE_REQUEST_PROTOCOL,
} from "../../flue-native-protocol";
import { assertLiveAutomaticAuthority } from "../../instance-state";
import {
  claimEffectExecution,
  createEffect,
  getEffect,
  getRepositoryEvent,
  getRun,
  markEffectNotExecuted,
  markEffectOutcomeUnknown,
  putNativeRunResult,
  recordEffectOutcome,
} from "../../persistence";
import { executeGitHubOperation } from "../../providers/github/client";
import { HARNESS_ADAPTER_VERSIONS, type HarnessRequest } from "../types";

const summary = v.pipe(v.string(), v.minLength(1), v.maxLength(32_000));
const proposal = v.strictObject({
  kind: v.literal("issue_comment_proposal"),
  body: v.pipe(v.string(), v.minLength(1), v.maxLength(65_536)),
  rationale: v.pipe(v.string(), v.minLength(1), v.maxLength(5_000)),
});
export const gardenerTerminalInputSchema = v.variant("outcome", [
  v.strictObject({ outcome: v.literal("abstain"), summary }),
  v.strictObject({ outcome: v.literal("issue_comment"), summary, proposal }),
]);
export type GardenerTerminalInput = v.InferOutput<typeof gardenerTerminalInputSchema>;

export interface ExactCommentEffect {
  effectId: string;
  operation: Operation;
  operationHash: string;
}

/** Frozen effect authority controls execution, never whether the Agent model turn runs. */
export function frozenIssueCommentMode(
  snapshot: Pick<AgentRunSnapshotV1, "effectiveCapabilities">,
): PolicyMode {
  return snapshot.effectiveCapabilities.effects.find(
    (item) => item.capability === "issue.comment.create",
  )?.mode ?? "disabled";
}

export async function constructExactCommentEffect(
  runId: string,
  event: unknown,
  proposalInput: unknown,
): Promise<ExactCommentEffect> {
  const repositoryEvent = repositoryEventV2Schema.parse(event);
  const parsed = v.parse(proposal, proposalInput);
  if (repositoryEvent.kind !== "github.issue" || repositoryEvent.action !== "opened") {
    throw new Error("The bounded runtime supports only github.issue.opened");
  }
  const operationSeed = await canonicalSha256({
    runId,
    kind: "issue.comment.create",
    proposal: parsed,
  });
  const operationId = `op_${operationSeed}`;
  const operation = operationSchema.parse({
    schemaVersion: "v2",
    id: operationId,
    kind: "issue.comment.create",
    repository: repositoryEvent.repository,
    issueNumber: repositoryEvent.issue.number,
    expectedIssueState: repositoryEvent.issue.state,
    expectedIssueUpdatedAt: repositoryEvent.issue.updatedAt,
    body: `${parsed.body}\n<!-- gardener-operation:${operationId} -->`,
  });
  const operationHash = await canonicalOperationHash(operation);
  return { effectId: `effect_${operationHash}`, operation, operationHash };
}

export async function submitGardenerOutput(
  env: Env,
  immutableRequest: HarnessRequest,
  input: unknown,
  step: ToolStep,
) {
  const data = v.parse(gardenerTerminalInputSchema, input);
  const { run, snapshot, event } = await validateNativeBinding(env, immutableRequest);
  if (
    data.outcome === "issue_comment"
    && data.proposal.body.length > snapshot.effectiveConstraints.maxCommentLength
  ) {
    throw new Error("Proposed comment exceeds frozen policy constraints");
  }
  const canonicalResult = {
    schemaVersion: "gardener.native.result/v1",
    profile: run.nativeProfile,
    outcome: data.outcome,
    summary: data.summary,
    ...(data.outcome === "issue_comment" ? { proposal: data.proposal } : {}),
  };
  const resultHash = await canonicalSha256(canonicalResult);
  await step.do("persist-output-v1", async () => {
    await putNativeRunResult(env.DB, run.id, canonicalResult, resultHash);
    return { resultHash };
  });
  if (data.outcome === "abstain") {
    return { output: { outcome: "abstain", persisted: true }, terminate: true };
  }

  const authorityMode = frozenIssueCommentMode(snapshot);
  if (authorityMode !== "automatic") {
    // Preserve the trusted model result and proposal for the visible run, but do not manufacture an
    // executable effect. Durable approval semantics will be added with the permission-model overhaul.
    return {
      output: { outcome: "issue_comment", status: "proposal_only", authorityMode },
      terminate: true,
    };
  }

  const frozen = await constructExactCommentEffect(run.id, event, data.proposal);
  try {
    await step.do("persist-exact-comment-effect-v1", async () => {
      const current = await getRun(env.DB, run.id);
      if (!current) throw new Error("Run disappeared before effect persistence");
      await createEffect(env.DB, {
        id: frozen.effectId,
        operationId: frozen.operation.id,
        runId: run.id,
        taskId: null,
        stepId: null,
        interruptionId: null,
        effectKind: frozen.operation.kind,
        operation: frozen.operation,
        operationHash: frozen.operationHash,
        rationale: data.proposal.rationale,
        policyMode: "automatic",
        policySnapshotHash: current.policySnapshotHash,
        status: "approved",
        requireActiveUncancelledNativeRun: true,
      });
      return { persisted: true };
    });
    const status = await executeExactCommentEffect(env, {
      runId: run.id,
      eventId: run.repositoryEventId!,
      deadlineAt: immutableRequest.budget.deadlineAt,
      attempts: 1 + snapshot.revision.spec.limits.retriesPerStep,
      effect: frozen,
    }, step);
    return { output: { outcome: "issue_comment", status }, terminate: true };
  } catch (error) {
    // A durable callback can commit D1 and still reject before Flue records the
    // step. Never let that leave the exact effect active when this turn ends.
    await settleRunNonterminalEffects(env, run.id, immutableRequest.budget.deadlineAt);
    throw error;
  }
}

type EffectAbandonmentReason = "cancelled" | "authority_denied" | "deadline_expired" | "execution_blocked";

/**
 * Repair the bounded profile's exact effect before any run settlement. An
 * executing row may follow an applied provider call, so only an explicit
 * receipt may make it known; otherwise it is conservatively unknown.
 */
export async function settleRunNonterminalEffects(
  env: Env,
  runId: string,
  deadlineAt: string,
): Promise<void> {
  const { results } = await env.DB.prepare(
    "SELECT id FROM effects WHERE run_id=? AND status IN ('approved','executing') ORDER BY created_at, id",
  ).bind(runId).all<{ id: string }>();
  for (const row of results) {
    const effect = await getEffect(env.DB, row.id);
    if (!effect || effect.runId !== runId) throw new Error("Nonterminal effect binding conflict");
    if (effect.status === "executing") {
      await markEffectOutcomeUnknown(env.DB, {
        effectId: effect.id,
        operationHash: effect.operationHash,
        runId,
      });
      continue;
    }
    if (effect.status !== "approved") continue;
    const run = await getRun(env.DB, runId);
    if (!run) throw new Error("Run disappeared during effect settlement");
    let reason: EffectAbandonmentReason = "execution_blocked";
    if (run.cancelRequestedAt || run.status === "cancelled") reason = "cancelled";
    else if (Date.now() >= Date.parse(deadlineAt)) reason = "deadline_expired";
    else if (["admitted", "queued", "running", "waiting"].includes(run.status)) {
      try {
        await assertLiveAutomaticAuthority(env, runId, operationSchema.parse(effect.operation));
      } catch {
        reason = await authorityAbandonmentReason(env, runId);
      }
    }
    try {
      await markEffectNotExecuted(env.DB, {
        effectId: effect.id,
        operationHash: effect.operationHash,
        runId,
        expectedStatus: "approved",
        reason,
      });
    } catch (error) {
      const raced = await getEffect(env.DB, effect.id);
      if (!raced || raced.runId !== runId || raced.operationHash !== effect.operationHash) throw error;
      if (raced.status === "executing") {
        await markEffectOutcomeUnknown(env.DB, {
          effectId: raced.id,
          operationHash: raced.operationHash,
          runId,
        });
      } else if (!isTerminalEffect(raced.status)) {
        throw error;
      }
    }
  }
}

export async function executeExactCommentEffect(
  env: Env,
  input: {
    runId: string;
    eventId: string;
    deadlineAt: string;
    attempts: number;
    effect: ExactCommentEffect;
  },
  step: ToolStep,
): Promise<string> {
  for (let attempt = 1; attempt <= input.attempts; attempt++) {
    const prior = await requireBoundEffect(env, input.effect);
    if (isTerminalEffect(prior.status)) return prior.status;
    if (Date.now() >= Date.parse(input.deadlineAt)) {
      return abandonBeforeProvider(env, input, step, prior.status, "deadline_expired");
    }
    try {
      await assertLiveAutomaticAuthority(env, input.runId, input.effect.operation);
    } catch {
      return abandonBeforeProvider(
        env,
        input,
        step,
        prior.status,
        await authorityAbandonmentReason(env, input.runId),
      );
    }

    const enteredExecuting = prior.status === "executing";
    let providerAttempted = false;
    try {
      const result = await step.do(`execute-exact-comment-effect-v1-attempt-${attempt}`, async () => {
        const current = await requireBoundEffect(env, input.effect);
        if (isTerminalEffect(current.status)) return { status: current.status };
        await assertLiveAutomaticAuthority(env, input.runId, input.effect.operation);
        if (!await claimEffectExecution(env.DB, {
          effectId: input.effect.effectId,
          operationHash: input.effect.operationHash,
        })) {
          throw new Error("Exact effect could not be claimed");
        }
        await assertLiveAutomaticAuthority(env, input.runId, input.effect.operation);
        providerAttempted = true;
        // A thrown RPC is ambiguous. A bounded retry repeats the exact operation bytes.
        const receipt = await executeGitHubOperation(
          env,
          input.runId,
          input.eventId,
          input.effect.operation,
        );
        const recorded = await recordEffectOutcome(env.DB, {
          effectId: input.effect.effectId,
          operationHash: input.effect.operationHash,
          receipt,
        });
        if (recorded.retryable) throw new Error("Retryable GitHub Gateway failure");
        return { status: recorded.effect.status };
      });
      return result.status;
    } catch {
      const current = await requireBoundEffect(env, input.effect);
      if (isTerminalEffect(current.status)) return current.status;
      if (!providerAttempted && !enteredExecuting) {
        return abandonBeforeProvider(
          env,
          input,
          step,
          current.status,
          await preProviderFailureReason(env, input.runId),
          true,
        );
      }
      if (attempt >= input.attempts) return projectUnknownOutcome(env, input, step);
      try {
        await boundedBackoff(attempt, input.deadlineAt);
      } catch {
        return projectUnknownOutcome(env, input, step);
      }
    }
  }
  return projectUnknownOutcome(env, input, step);
}

async function requireBoundEffect(env: Env, effect: ExactCommentEffect) {
  const current = await getEffect(env.DB, effect.effectId);
  if (!current || current.operationHash !== effect.operationHash) {
    throw new Error("Exact effect hash changed before execution");
  }
  return current;
}

function isTerminalEffect(status: string): boolean {
  return ["executed", "failed", "stale", "cancelled"].includes(status);
}

async function authorityAbandonmentReason(
  env: Env,
  runId: string,
): Promise<"cancelled" | "authority_denied"> {
  const run = await getRun(env.DB, runId);
  return run?.cancelRequestedAt ? "cancelled" : "authority_denied";
}

async function preProviderFailureReason(
  env: Env,
  runId: string,
): Promise<"cancelled" | "execution_blocked"> {
  const run = await getRun(env.DB, runId);
  return run?.cancelRequestedAt ? "cancelled" : "execution_blocked";
}

async function abandonBeforeProvider(
  env: Env,
  input: {
    runId: string;
    eventId: string;
    deadlineAt: string;
    attempts: number;
    effect: ExactCommentEffect;
  },
  step: ToolStep,
  status: string,
  reason: "cancelled" | "authority_denied" | "deadline_expired" | "execution_blocked",
  knownNotExecuted = false,
): Promise<string> {
  if (status === "executing" && !knownNotExecuted) return projectUnknownOutcome(env, input, step);
  if (status !== "approved" && status !== "executing") {
    throw new Error("Exact effect cannot be abandoned from its current state");
  }
  const effect = await step.do(`finalize-exact-comment-effect-v1-${reason}`, async () => {
    return markEffectNotExecuted(env.DB, {
      effectId: input.effect.effectId,
      operationHash: input.effect.operationHash,
      runId: input.runId,
      expectedStatus: status,
      reason,
    });
  });
  return effect.status;
}

async function projectUnknownOutcome(
  env: Env,
  input: {
    runId: string;
    effect: ExactCommentEffect;
  },
  step: ToolStep,
): Promise<string> {
  const effect = await step.do("finalize-exact-comment-effect-v1-outcome-unknown", async () => {
    return markEffectOutcomeUnknown(env.DB, {
      effectId: input.effect.effectId,
      operationHash: input.effect.operationHash,
      runId: input.runId,
    });
  });
  return effect.status;
}

export async function validateNativeBinding(env: Env, request: HarnessRequest) {
  const run = await getRun(env.DB, request.runId);
  if (
    !run
    || run.runtimeDriver !== FLUE_NATIVE_DRIVER
    || !run.repositoryEventId
    || !run.nativeModelId
    || run.nativeProfile !== FLUE_NATIVE_PROFILE
    || run.nativeRequestProtocol !== FLUE_NATIVE_REQUEST_PROTOCOL
    || request.model.id !== run.nativeModelId
  ) {
    throw new Error("Native run binding is invalid");
  }
  if (
    request.tools.length !== 0
    || request.budget.maxTurns !== 1
    || request.budget.maxToolCalls !== 1
  ) {
    throw new Error("Native qualified profile binding is invalid");
  }
  const snapshot = agentRunSnapshotV1Schema.parse(run.runSnapshot);
  const workspace = instancePolicyV1Schema.parse(run.policySnapshot);
  const stored = await env.DB.prepare(
    "SELECT request_json,request_hash FROM harness_requests WHERE run_id=? AND request_id=?",
  ).bind(run.id, request.requestId).first<{ request_json: string; request_hash: string }>();
  if (
    !stored
    || await canonicalSha256(request) !== stored.request_hash
    || JSON.stringify(request) !== stored.request_json
  ) {
    throw new Error("Immutable request integrity validation failed");
  }
  const eventRow = await getRepositoryEvent(env.DB, run.repositoryEventId);
  const event = repositoryEventV2Schema.parse(eventRow?.envelope);
  if (
    !eventRow
    || await canonicalSha256(event) !== eventRow.envelopeHash
    || snapshot.runId !== run.id
    || snapshot.snapshotHash !== run.runSnapshotHash
    || await canonicalSha256(agentRunSnapshotHashContent(snapshot)) !== run.runSnapshotHash
    || await calculateWorkspacePolicyHash(workspace) !== run.policySnapshotHash
    || snapshot.harness.id !== "flue"
    || snapshot.harness.version !== HARNESS_ADAPTER_VERSIONS.flue
    || request.snapshot.harness.adapterVersion !== HARNESS_ADAPTER_VERSIONS.flue
    || snapshot.assignment.id !== run.assignmentId
    || snapshot.assignment.version !== run.assignmentVersion
    || snapshot.assignment.configHash !== run.assignmentConfigHash
    || snapshot.repository.policyHash !== run.repositoryPolicyHash
    || snapshot.repository.policyVersion !== run.repositoryPolicyVersion
    || event.repository.id !== run.repositoryId
  ) {
    throw new Error("Native run snapshot, event, or authority binding is invalid");
  }
  return { run, snapshot, event };
}

async function boundedBackoff(attempt: number, deadlineAt: string) {
  const remaining = Date.parse(deadlineAt) - Date.now();
  if (remaining <= 0) throw new Error("Frozen terminal effect deadline expired");
  const delay = Math.min(4_000, 250 * 2 ** (attempt - 1), remaining);
  await new Promise<void>((resolve) => setTimeout(resolve, delay));
}
