import {
  captureDeferredPointers,
  operationOutputNames,
  operationOutputType,
  taskCaptureChangesDigestInput,
  taskCaptureManifestV1Schema,
  taskEffectPlanV1Schema,
  taskEffectProposalV1Schema,
  taskEventBindingFromNormalizedEvent,
  taskOutcomeV1Schema,
  type TaskCaptureManifestV1,
  type TaskEffectPlanV1,
  type TaskEffectProposalV1,
  type TaskOutcomeV1,
  type TaskRunRequestV1,
} from "@gardener/contracts";
import { canonicalJson, canonicalSha256 } from "@gardener/core";
import {
  runnerActionV1Schema,
  runnerCaptureResultV1Schema,
  EFFECT_TRANSPORT_MAX_BYTES,
  type RunnerActionResultV1,
  type RunnerActionV1,
  type RunnerEffectReceiptV1,
} from "@gardener/protocol";
import { assertRunnerToolBudget } from "./task-limits";

export type CompletedTaskOutcomeV1 = Extract<TaskOutcomeV1, { status: "completed" }>;

/**
 * Repository changes a plan materializes at apply time.
 *
 * Supplied only by trusted runner-side capture admission. Planning never
 * synthesizes one: a step that needs a capture and has none fails the run
 * rather than shipping a commit whose contents nobody captured.
 */
export interface TaskEffectPlanCaptureV1 {
  manifest: TaskCaptureManifestV1;
  changesSha256: string;
}

/**
 * The capture as a run durably holds it: what the plan binds, plus the small
 * acknowledgement the terminal reports.
 */
export interface AdmittedTaskCaptureV1 extends TaskEffectPlanCaptureV1 {
  ack: Omit<TaskCaptureAdmissionAckV1, "duplicate">;
}

export interface BuildTaskEffectPlanInput {
  request: TaskRunRequestV1;
  outcome: CompletedTaskOutcomeV1;
  capture?: TaskEffectPlanCaptureV1 | undefined;
}

/** One `propose_effect` call, bound to the harness request that made it. */
export interface TaskEffectProposalInvocationV1 {
  runId: string;
  requestId: string;
  toolCallId: string;
  /** Unvalidated model input; the session parses it against the contract. */
  proposal: unknown;
}

/**
 * One internal capture admission, bound to the harness request that triggered
 * it.
 *
 * There is no model-facing tool behind this. `finish_task` invokes it on the
 * task's behalf when the durable ledger already holds a step that materializes
 * repository changes, so the model can neither request a capture nor decline
 * one it has made necessary.
 */
export interface TaskCaptureAdmissionInvocationV1 {
  runId: string;
  requestId: string;
  toolCallId: string;
}

/**
 * What the terminal learns about an admitted capture.
 *
 * Counts and an identity only. No path, no digest the model could quote back
 * into a payload, and certainly no content: the model's job ended when it
 * changed the working tree.
 */
export interface TaskCaptureAdmissionAckV1 {
  captureId: string;
  fileCount: number;
  sizeBytes: number;
  /** True when this run had already admitted exactly this capture. */
  duplicate: boolean;
}

/** What the model learns about a recorded proposal. Never an operation id. */
export interface TaskEffectProposalAckV1 {
  stepName: string;
  /** Zero-based position in the ordered plan. */
  index: number;
  /** True when this exact proposal was already recorded, as on replay. */
  duplicate: boolean;
  totalProposed: number;
}

/**
 * Durable proposal channel.
 *
 * Proposals accumulate in the session Durable Object rather than in the agent
 * closure. Flue replays the agent body and serves durable tool results from
 * its journal without re-running the handler, so an in-memory array would come
 * back empty on replay and silently drop every step but the last.
 */
export interface TaskPlanFacade {
  proposeEffect(invocation: TaskEffectProposalInvocationV1): Promise<TaskEffectProposalAckV1>;
  listProposals(runId: string): Promise<readonly TaskEffectProposalV1[]>;
  /**
   * Admits the trusted working-tree capture for this run. Trusted host code
   * calls it; it is never mounted as a tool.
   */
  captureRepository(invocation: TaskCaptureAdmissionInvocationV1): Promise<TaskCaptureAdmissionAckV1>;
}

/**
 * Steps whose contents come from the capture rather than from the model.
 *
 * One helper, used by the terminal to decide whether a capture is needed, by
 * the session to decide whether one has a consumer, and by plan building to
 * decide whether one is required. Three copies of this predicate would
 * eventually disagree about whether a commit needs contents.
 */
export function captureMaterializingSteps(
  proposals: readonly TaskEffectProposalV1[],
): readonly TaskEffectProposalV1[] {
  return proposals.filter((proposal) => captureDeferredPointers(proposal.kind).length > 0);
}

/* -------------------------------------------------------------------------- */
/* Durable proposal ledger                                                    */
/* -------------------------------------------------------------------------- */

/** Ordered proposals. The key sorts lexicographically in plan order. */
export const PROPOSAL_PREFIX = "proposal:";
/** Content digest to recorded index, which is what makes a replay idempotent. */
export const PROPOSAL_DIGEST_PREFIX = "proposal-digest:";
/** Step name to the digest that claimed it, which is what rejects a conflict. */
export const PROPOSAL_STEP_PREFIX = "proposal-step:";
export const PROPOSAL_COUNT_KEY = "proposal-count";
/** Shared tool-call counter, spent by repository actions and proposals alike. */
export const RUNNER_TOOL_COUNT_KEY = "runner-tool-count";
/** Per-call reservation marker, so one logical call is charged exactly once. */
export const RUNNER_TOOL_RESERVATION_PREFIX = "runner-tool-reservation:";

export interface StoredProposalV1 {
  index: number;
  digest: string;
  proposal: TaskEffectProposalV1;
}

/**
 * The slice of Durable Object storage the ledger uses.
 *
 * Narrow on purpose: the ledger rules are the part worth testing on their own,
 * and the session supplies either its storage or an open transaction.
 */
export interface ProposalLedgerStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  list<T>(options: { prefix: string }): Promise<Map<string, T>>;
}

/** Zero-padded so a durable `list()` returns proposals in proposal order. */
export function proposalKey(index: number): string {
  return `${PROPOSAL_PREFIX}${String(index).padStart(6, "0")}`;
}

/**
 * The fields that decide whether two proposals are the same effect.
 *
 * `rationale` is excluded here, and for the same reason it is excluded from
 * the operation id: it is prose for a human reader and changes nothing about
 * the provider call. A model that re-proposes an identical step with reworded
 * justification is replaying, not contradicting itself, so it must be
 * acknowledged as a duplicate rather than refused as a step-name conflict.
 *
 * Identity, the digest, and the operation id are derived from this one helper
 * so the three can never drift into disagreeing about what "the same effect"
 * means.
 */
function effectIdentity(proposal: TaskEffectProposalV1): Record<string, unknown> {
  return {
    stepName: proposal.stepName,
    kind: proposal.kind,
    payload: proposal.payload,
    references: proposal.references,
  };
}

/** Content digest that identifies one effect within one run. */
export async function proposalDigest(runId: string, proposal: TaskEffectProposalV1): Promise<string> {
  return canonicalSha256({ runId, ...effectIdentity(proposal) });
}

/** Index this exact proposal already holds, if it was recorded before. */
export async function recordedProposalIndex(
  storage: ProposalLedgerStorage,
  digest: string,
): Promise<number | undefined> {
  return storage.get<number>(`${PROPOSAL_DIGEST_PREFIX}${digest}`);
}

/** Ordered proposals recorded so far. Empty is valid and normal. */
export async function readProposalLedger(
  storage: ProposalLedgerStorage,
): Promise<readonly TaskEffectProposalV1[]> {
  const stored = await storage.list<StoredProposalV1>({ prefix: PROPOSAL_PREFIX });
  return [...stored.values()].sort((left, right) => left.index - right.index).map((record) => record.proposal);
}

export interface ProposalAdmissionInput {
  proposal: TaskEffectProposalV1;
  digest: string;
  maxToolCalls: number;
  /**
   * Tool calls already recorded outside the shared counter. Read only to
   * bootstrap the counter the first time it is needed, and supplied as a
   * thunk so the caller can read it inside the same transaction.
   */
  recordedToolCalls(): Promise<number>;
}

/**
 * Charges the shared tool budget and appends one proposal, atomically.
 *
 * Runs entirely inside the caller's storage transaction. That is what makes
 * the three outcomes honest:
 *
 * - Replay. The same effect was already recorded, so it returns the position
 *   it holds and charges nothing.
 * - Conflict. The step name is taken by a different effect, so it throws
 *   before the budget is touched and the transaction rolls back. A refused
 *   proposal must cost the task nothing, or a model that keeps getting the
 *   payload wrong would burn the run's whole tool budget on rejections.
 * - Admission. The budget is charged once, keyed by the effect digest, and
 *   the index, digest mapping, name claim, and counter all move together.
 *
 * Splitting the reservation and the append across two transactions would let
 * an interleaved call observe a charged budget with no proposal behind it.
 */
export async function admitProposal(
  storage: ProposalLedgerStorage,
  input: ProposalAdmissionInput,
): Promise<TaskEffectProposalAckV1> {
  const { proposal, digest, maxToolCalls } = input;
  const settled = await recordedProposalIndex(storage, digest);
  const count = await storage.get<number>(PROPOSAL_COUNT_KEY) ?? 0;
  if (settled !== undefined) {
    return { stepName: proposal.stepName, index: settled, duplicate: true, totalProposed: count };
  }
  if (await storage.get<string>(`${PROPOSAL_STEP_PREFIX}${proposal.stepName}`) !== undefined) {
    throw new Error(`Step name ${proposal.stepName} was already proposed with different content`);
  }

  const reservationKey = `${RUNNER_TOOL_RESERVATION_PREFIX}${digest}`;
  if (await storage.get(reservationKey) === undefined) {
    const reserved = await storage.get<number>(RUNNER_TOOL_COUNT_KEY) ?? await input.recordedToolCalls();
    assertRunnerToolBudget(maxToolCalls, reserved);
    await storage.put(reservationKey, true);
    await storage.put(RUNNER_TOOL_COUNT_KEY, reserved + 1);
  }

  await storage.put<StoredProposalV1>(proposalKey(count), { index: count, digest, proposal });
  await storage.put(`${PROPOSAL_DIGEST_PREFIX}${digest}`, count);
  await storage.put(`${PROPOSAL_STEP_PREFIX}${proposal.stepName}`, digest);
  await storage.put(PROPOSAL_COUNT_KEY, count + 1);
  return { stepName: proposal.stepName, index: count, duplicate: false, totalProposed: count + 1 };
}

/**
 * Derives the immutable id for one ordered step.
 *
 * The model names steps but never identifies them. An id the model chose could
 * be made to collide with a previous attempt's receipt and so suppress a real
 * effect, which is why every input here is either run-bound or content-bound:
 * the run id, the step's position, its name, and exactly what it will do.
 *
 * `rationale` is deliberately excluded. It is prose for a human reader and has
 * no bearing on the provider call, so rewording it must not mint a new
 * identity for the same effect and break receipt reconciliation on retry.
 */
export async function deriveOperationId(
  runId: string,
  index: number,
  proposal: TaskEffectProposalV1,
): Promise<string> {
  return `op_${await canonicalSha256({ runId, index, ...effectIdentity(proposal) })}`;
}

/**
 * Builds the exact ordered plan the checkout-free apply job executes.
 *
 * This is a pure function of the immutable run request, the completed outcome,
 * and any admitted capture, so planning, terminal replay, and receipt
 * admission all derive byte-identical plans without re-running the model.
 *
 * Every authority decision is re-derived here rather than read from the
 * outcome: the allowlist comes from the admitted bundle, the ids from the run,
 * and the limits from the bundle. A model that fabricated any of them changes
 * nothing.
 */
export async function buildTaskEffectPlan(input: BuildTaskEffectPlanInput): Promise<TaskEffectPlanV1> {
  const { request, outcome, capture } = input;
  const declared = new Set<string>(request.bundle.effects);
  const operations: Record<string, unknown>[] = [];
  const materializing: string[] = [];

  for (const [index, candidate] of outcome.proposedEffects.entries()) {
    const proposal = taskEffectProposalV1Schema.parse(candidate);
    if (!declared.has(proposal.kind)) {
      throw new Error(`Task proposed the undeclared effect ${proposal.kind}`);
    }
    // Capture-owned pointers are unconditional: a `commit.create` always
    // needs a capture, and the proposal contract has already refused any
    // attempt to inline the bytes instead.
    if (captureDeferredPointers(proposal.kind).length > 0) materializing.push(proposal.stepName);
    operations.push({
      stepName: proposal.stepName,
      operationId: await deriveOperationId(request.runId, index, proposal),
      kind: proposal.kind,
      payload: proposal.payload,
      references: proposal.references,
      rationale: proposal.rationale,
    });
  }

  // One capture, one consumer. A run captures the working tree exactly once,
  // so two commits would both claim the same whole-tree change set and the
  // second would re-apply what the first already wrote. Partitioning the
  // bytes honestly across several commits is a real feature and a later one;
  // until it exists this fails closed rather than silently duplicating a
  // change set.
  if (materializing.length > 1) {
    throw new Error(
      `Steps ${materializing.join(", ")} each materialize repository changes, but a plan may materialize one capture`,
    );
  }
  if (materializing.length > 0 && capture === undefined) {
    throw new Error(
      "A proposed step materializes repository changes but the run admitted no capture; Gardener will not invent commit contents",
    );
  }
  if (materializing.length === 0 && capture !== undefined) {
    throw new Error("The run admitted a repository capture that no proposed step materializes");
  }
  // The capture's base commit is not re-checked here: the plan schema binds it
  // to the planning commit, so a drifted capture is rejected once, in the
  // contract, rather than by two rules that could disagree.

  return taskEffectPlanV1Schema.parse({
    schemaVersion: "gardener.task-effect-plan/v1",
    runId: outcome.runId,
    taskId: outcome.taskId,
    taskName: request.bundle.name,
    bundleHash: outcome.bundleHash,
    repository: {
      id: request.event.repository.id,
      fullName: request.event.repository.fullName,
      defaultBranch: request.event.repository.defaultBranch,
    },
    provenance: {
      sourcePath: request.sourcePath,
      commitSha: request.event.repository.commitSha,
      workflowRunId: request.event.workflow.runId,
      workflowRunAttempt: request.event.workflow.runAttempt,
    },
    event: taskEventBindingFromNormalizedEvent(request.event),
    limits: {
      ...(request.bundle.limits.maxEffectOperations === undefined
        ? {}
        : { maxEffectOperations: request.bundle.limits.maxEffectOperations }),
      ...(request.bundle.limits.maxEffectBytes === undefined
        ? {}
        : { maxEffectBytes: request.bundle.limits.maxEffectBytes }),
    },
    ...(capture === undefined ? {} : { capture: capture.manifest, changesSha256: capture.changesSha256 }),
    operations,
  });
}

/**
 * Builds the trusted capture action.
 *
 * Every field is fixed by the runtime. There is no path list, no filter, and
 * no budget the task can influence, because the capture's job is to record
 * what the runner observed rather than what the task would prefer to commit.
 */
export function captureAction(
  sequence: number,
  operationId: string,
  baseSha: string,
  timeoutMs = 5 * 60_000,
  maxOutputBytes = EFFECT_TRANSPORT_MAX_BYTES,
): RunnerActionV1 {
  return runnerActionV1Schema.parse({
    schemaVersion: "gardener.runner.action/v1",
    sequence,
    operationId,
    kind: "repository.capture",
    baseSha,
    timeoutMs,
    maxOutputBytes,
  });
}

/**
 * Turns a capture action result into the record the run durably holds.
 *
 * The runner is trusted to *run* the capture and untrusted to *describe* it,
 * so everything the envelope asserts is re-derived here from the one artifact
 * the digest actually covers — the canonical manifest text:
 *
 * - the manifest digest must cover exactly those bytes;
 * - those bytes must parse against the authoritative contract and re-serialize
 *   to themselves, so there is one canonical form and no room to hide fields;
 * - identity, base commit, file count, and total size must agree between the
 *   reference and the manifest;
 * - the base commit must be the one this run is bound to.
 *
 * The changes digest is independently derived here from manifest metadata.
 * Every upsert record binds the content digest and size, so the Worker can
 * authenticate the complete change stream without receiving file bytes. Apply
 * derives it again from the downloaded artifact before writing anything.
 */
export async function captureRecordFromResult(result: RunnerActionResultV1, baseSha: string): Promise<AdmittedTaskCaptureV1> {
  if (result.status !== "completed") {
    throw new Error(`Repository capture ${result.status}: ${sanitizeCaptureDiagnostic(result.stderr || "no diagnostic")}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error("Repository capture returned a malformed result");
  }
  const envelope = runnerCaptureResultV1Schema.parse(parsed);
  if (envelope.status === "unchanged") {
    throw new Error(
      "A proposed step commits repository changes but the working tree is unchanged; "
      + "make the change with repository.exec before proposing a commit",
    );
  }
  const { ref, manifestJson } = envelope;
  if (await sha256Hex(new TextEncoder().encode(manifestJson)) !== ref.manifestSha256) {
    throw new Error("Capture manifest digest does not cover the manifest the runner sent");
  }
  const manifest = taskCaptureManifestV1Schema.parse(JSON.parse(manifestJson));
  if (canonicalJson(manifest) !== manifestJson) throw new Error("Capture manifest is not canonical");
  const totalBytes = manifest.files.reduce((total, file) => total + (file.status === "deleted" ? 0 : file.sizeBytes), 0);
  const agreements: readonly [string, string, string][] = [
    ["identity", manifest.captureId, ref.captureId],
    ["base commit", manifest.baseSha, ref.baseSha],
    ["run base commit", manifest.baseSha, baseSha],
    ["file count", String(manifest.files.length), String(ref.fileCount)],
    ["size", String(totalBytes), String(ref.sizeBytes)],
  ];
  for (const [label, actual, expected] of agreements) {
    if (actual !== expected) throw new Error(`Capture ${label} mismatch: ${actual} is not ${expected}`);
  }
  const changesSha256 = await captureChangesSha256(manifest);
  if (changesSha256 !== ref.changesSha256) {
    throw new Error("Capture changes digest does not match the canonical manifest");
  }
  return {
    manifest,
    changesSha256,
    ack: { captureId: ref.captureId, fileCount: ref.fileCount, sizeBytes: ref.sizeBytes },
  };
}

/** Digest over exact bytes, as opposed to `canonicalSha256`'s digest over a value. */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Digest of the contract-owned canonical capture metadata stream. */
export async function captureChangesSha256(manifest: TaskCaptureManifestV1): Promise<string> {
  return sha256Hex(taskCaptureChangesDigestInput(manifest));
}

function sanitizeCaptureDiagnostic(value: string): string {
  return value
    .replace(/(?:\/home\/runner|\/Users\/runner|[A-Za-z]:\\)[^\s'\"`]*/g, "<runner-path>")
    .slice(0, 2_000);
}

/**
 * Settles a finished run into the outcome that should be durable.
 *
 * Building the plan is the last authority check a run gets — the declared
 * effect allowlist, step references, the operation and byte ceilings, and the
 * capture binding can only be checked once the model has stopped proposing.
 * A rejection there means the run produced nothing appliable, which is a
 * *failed* run.
 *
 * Returning a failed outcome rather than throwing is what keeps the durable
 * record and the terminal consistent. A run stored as `completed` whose plan
 * cannot be built would report a success that has no artifact, and every
 * reconnect would rebuild the same invalid plan and fail again, leaving the
 * run wedged with no terminal at all. Because this is a pure function of the
 * immutable request, the stored outcome, and the admitted capture, a
 * reconnecting runner derives exactly the same settlement.
 */
export async function settledTaskOutcome(input: BuildTaskEffectPlanInput): Promise<TaskOutcomeV1> {
  try {
    await buildTaskEffectPlan(input);
    return input.outcome;
  } catch (error) {
    return taskOutcomeV1Schema.parse({
      schemaVersion: "gardener.task-outcome/v1",
      runId: input.request.runId,
      taskId: input.request.bundle.taskId,
      bundleHash: input.request.bundleHash,
      status: "failed",
      error: {
        code: "effect.plan_rejected",
        message: (error instanceof Error ? error.message : "The proposed effect plan was rejected").slice(0, 8_000),
        retryable: false,
      },
    });
  }
}

/**
 * Admits a receipt only if it answers exactly the plan Gardener derived.
 *
 * The schema already proves the receipt is internally coherent. This proves it
 * is *this* plan's receipt: same planned count, same capture, and the same
 * steps in the same order. Stop-and-resume means a receipt may be a prefix of
 * the plan, so shorter is allowed — reordered, renamed, or re-identified is
 * not.
 */
export function assertMonotonicReceipt(existing: RunnerEffectReceiptV1, next: RunnerEffectReceiptV1): void {
  const immutable = (receipt: RunnerEffectReceiptV1) => canonicalJson({
    planRunId: receipt.planRunId,
    bundleHash: receipt.bundleHash,
    artifactSha256: receipt.artifactSha256,
    changesSha256: receipt.changesSha256 ?? null,
    plannedOperations: receipt.plannedOperations,
  });
  if (immutable(existing) !== immutable(next)) throw new Error("Effect receipt plan identity changed");
  if (existing.status === "applied") throw new Error("An applied effect receipt is terminal");
  const immutablePrefixLength = existing.status === "stopped"
    ? Math.max(0, existing.operations.length - 1)
    : existing.operations.length;
  if (next.operations.length < immutablePrefixLength) throw new Error("Effect receipt successful prefix regressed");
  for (let index = 0; index < immutablePrefixLength; index += 1) {
    if (canonicalJson(existing.operations[index]) !== canonicalJson(next.operations[index])) {
      throw new Error("Effect receipt changed an already completed operation");
    }
  }
  if (existing.status === "running" && next.operations.length === existing.operations.length) {
    throw new Error("Effect receipt made no progress");
  }
  if (existing.status === "stopped" && next.operations.length <= immutablePrefixLength) {
    throw new Error("Effect receipt dropped the previously halted step without retrying it");
  }
}

export function assertReceiptMatchesPlan(plan: TaskEffectPlanV1, receipt: RunnerEffectReceiptV1): void {
  if (receipt.bundleHash !== plan.bundleHash) {
    throw new Error("Effect receipt bundle hash does not match the planned bundle");
  }
  if (receipt.plannedOperations !== plan.operations.length) {
    throw new Error(
      `Effect receipt reports ${receipt.plannedOperations} planned operations but the plan ordered ${plan.operations.length}`,
    );
  }
  if ((receipt.changesSha256 ?? null) !== (plan.changesSha256 ?? null)) {
    throw new Error("Effect receipt changes digest does not match the plan");
  }
  receipt.operations.forEach((entry, index) => {
    const planned = plan.operations[index];
    if (planned === undefined) throw new Error(`Effect receipt records unplanned step ${entry.stepName}`);
    if (entry.stepName !== planned.stepName) {
      throw new Error(`Effect receipt step ${index + 1} is ${entry.stepName} but the plan ordered ${planned.stepName}`);
    }
    if (entry.receipt.operationId !== planned.operationId) {
      throw new Error(`Effect receipt step ${entry.stepName} carries an operation ID the plan did not derive`);
    }
    if (entry.receipt.kind !== planned.kind) {
      throw new Error(`Effect receipt step ${entry.stepName} is ${entry.receipt.kind} but the plan ordered ${planned.kind}`);
    }
    const names = operationOutputNames(planned.kind);
    const actual = Object.keys(entry.outputs);
    if (entry.receipt.status === "succeeded" || entry.receipt.status === "skipped") {
      if (actual.length !== names.length || actual.some((name) => !names.includes(name))) {
        throw new Error(`Effect receipt step ${entry.stepName} does not carry its exact published outputs`);
      }
      for (const name of names) {
        const value = entry.outputs[name];
        const type = operationOutputType(planned.kind, name);
        const valid = type === "resourceNumber"
          ? typeof value === "number" && Number.isSafeInteger(value) && value > 0
          : type === "boolean"
            ? typeof value === "boolean"
            : type === "nullableGithubId"
              ? value === null || (typeof value === "string" && /^[1-9][0-9]{0,19}$/.test(value))
              : typeof value === "string";
        if (!valid) throw new Error(`Effect receipt step ${entry.stepName} carries an invalid ${name} output`);
      }
    } else if (actual.length > 0) {
      throw new Error(`Failed effect receipt step ${entry.stepName} may not publish outputs`);
    }
  });
}
