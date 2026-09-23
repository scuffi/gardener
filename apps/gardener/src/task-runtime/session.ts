import { RpcTarget, newWorkersRpcResponse, type RpcStub } from "capnweb";
import { DurableObject } from "cloudflare:workers";
import {
  EFFECT_TRANSPORT_MAX_BYTES,
  resumeCursorV1Schema,
  runnerActionResultV1Schema,
  runnerActionV1Schema,
  runnerCaptureResultV1Schema,
  runnerEffectReceiptV1Schema,
  runnerEventV1Schema,
  runnerHelloV1Schema,
  runnerSessionId,
  type AuthenticatedSessionCapability,
  type PublicSessionCapability,
  type ResumeCursorV1,
  type ResumeStateV1,
  type RunnerActionResultV1,
  type RunnerActionV1,
  type RunnerCapability,
  type RunnerEffectReceiptV1,
  type RunnerEventV1,
  type RunnerHelloV1,
  type RunnerTerminalV1,
} from "@gardener/protocol";
import {
  eventNameByTriggerKind,
  taskEffectProposalV1Schema,
  taskOutcomeV1Schema,
  taskRunRequestV1Schema,
  type TaskEffectProposalV1,
  type TaskOutcomeV1,
  type TaskRunRequestV1,
} from "@gardener/contracts";
import { canonicalJson, canonicalSha256 } from "@gardener/core";
import type { HarnessSubmission, HarnessToolInvocation } from "../harness";
import type { Env } from "../env";
import {
  admitProposal,
  assertMonotonicReceipt,
  assertReceiptMatchesPlan,
  buildTaskEffectPlan,
  captureAction,
  captureMaterializingSteps,
  captureRecordFromResult,
  proposalDigest,
  PROPOSAL_COUNT_KEY,
  readProposalLedger,
  recordedProposalIndex,
  RUNNER_TOOL_COUNT_KEY,
  RUNNER_TOOL_RESERVATION_PREFIX,
  settledTaskOutcome,
  type AdmittedTaskCaptureV1,
  type TaskCaptureAdmissionAckV1,
  type TaskCaptureAdmissionInvocationV1,
  type TaskEffectPlanCaptureV1,
  type TaskEffectProposalAckV1,
  type TaskEffectProposalInvocationV1,
} from "./effect-plan";
import { createTaskHarnessRequest, translateHarnessOutcome } from "./harness-adapter";
import { FlueTaskHarness } from "./flue-harness";
import { verifyActionsOidc, type VerifiedActionsIdentity } from "./github-oidc";
import { loadEnabledTaskBundle } from "./task-bundles";
import { assertRunnerToolBudget, remainingTaskRuntime } from "./task-limits";
import { actionToolAuthority, TASK_TOOL_BY_HARNESS_NAME } from "./tool-authority";

interface Enrollment {
  repository_id: string;
  owner_id: string;
  owner_login: string;
  repository_name: string;
  visibility: "public" | "private" | "internal";
  plan_job_workflow_ref: string;
  effects_job_workflow_ref: string | null;
  oidc_audience: string;
}

interface StoredAction {
  canonicalAction: string;
  state: "running" | "ambiguous" | "completed";
  action: RunnerActionV1;
  result?: RunnerActionResultV1;
  canonicalResult?: string;
}

interface AuthenticatedIdentity {
  hello: RunnerHelloV1;
  enrollment: Enrollment;
  actor: VerifiedActionsIdentity;
  sessionId: string;
}



const ACTION_PREFIX = "action:";
const OIDC_PREFIX = "oidc:";
/**
 * Trusted repository capture admitted for this run.
 *
 * No planning path writes it, so a step that defers its contents to a capture
 * fails closed. Capture admission supplies it; planning never invents one.
 */
const CAPTURE_KEY = "effect-capture";
const CAPTURE_PENDING_KEY = "effect-capture-pending";
/** Incremented only after a terminal, non-captured attempt is released. */
const CAPTURE_GENERATION_KEY = "effect-capture-generation";

interface CapturePending {
  operationId: string;
  runId: string;
  generation: number;
}

export class TaskRunnerSession extends DurableObject<Env> {
  #runner: RpcStub<RunnerCapability> | undefined;
  #identity: AuthenticatedIdentity | undefined;
  #resultWaiters = new Map<string, Set<(result: RunnerActionResultV1) => void>>();

  override fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname !== "/rpc") return Promise.resolve(new Response("Not found", { status: 404 }));
    return newWorkersRpcResponse(request, new PublicApi(
      this,
      request.headers.get("x-gardener-session-id") ?? "",
    ), {
      limits: { maxDepth: 64, maxMessageSize: 1_024 * 1_024, maxBigIntDigits: 128 },
      onSendError: (error) => new Error(error.message),
    });
  }

  async authenticate(helloInput: RunnerHelloV1, oidcToken: string, runner: RpcStub<RunnerCapability>, routedSessionId: string): Promise<void> {
    const hello = runnerHelloV1Schema.parse(helloInput);
    if (runnerSessionId(hello) !== routedSessionId) throw new Error("Runner identity does not match the routed durable session");
    const enrollment = await this.env.DB.prepare(
      "SELECT repository_id,owner_id,owner_login,repository_name,visibility,plan_job_workflow_ref,effects_job_workflow_ref,oidc_audience " +
      "FROM actions_repository_enrollments WHERE repository_id=? AND owner_id=? AND enabled=1",
    ).bind(hello.repositoryId, hello.ownerId).first<Enrollment>();
    if (!enrollment) throw new Error("Repository is not enrolled for Actions task execution");
    const jobWorkflowRef = hello.phase === "plan" ? enrollment.plan_job_workflow_ref : enrollment.effects_job_workflow_ref;
    if (!jobWorkflowRef) throw new Error(`Repository has no enrolled ${hello.phase} workflow`);
    const actor = await verifyActionsOidc(oidcToken, hello, {
      audience: enrollment.oidc_audience,
      repositoryId: enrollment.repository_id,
      ownerId: enrollment.owner_id,
      ownerLogin: enrollment.owner_login,
      repositoryName: enrollment.repository_name,
      visibility: enrollment.visibility,
      jobWorkflowRef,
    });
    await this.consumeOidcToken(actor.jti, actor.expiresAt);
    const existingSessionId = await this.ctx.storage.get<string>("session-id");
    if (existingSessionId && existingSessionId !== routedSessionId) throw new Error("Durable session identity conflict");
    await this.ctx.storage.put("session-id", routedSessionId);
    this.#runner?.[Symbol.dispose]();
    this.#runner = runner.dup();
    this.#identity = { hello, enrollment, actor, sessionId: routedSessionId };
  }

  async invokeHarnessTool(invocation: HarnessToolInvocation): Promise<RunnerActionResultV1> {
    const sessionId = await this.ctx.storage.get<string>("session-id");
    if (!sessionId || invocation.runId !== sessionId) throw new Error("Harness tool invocation is not bound to this runner session");
    const operationId = `op_${await canonicalSha256({
      runId: invocation.runId,
      requestId: invocation.requestId,
      toolCallId: invocation.toolCallId,
      toolName: invocation.toolName,
      input: invocation.input,
    })}`;
    const key = `${ACTION_PREFIX}${operationId}`;
    const existing = await this.ctx.storage.get<StoredAction>(key);
    if (existing) return this.invoke(existing.action);
    await this.assertRunActive(invocation.runId);
    await this.assertCaptureNotSettled();
    await this.assertToolDeclared(invocation.runId, invocation.toolName);
    await this.reserveRunnerToolBudget(invocation.runId, operationId);
    await this.settleUnresolvedBeforeNewAction(invocation.runId);
    const sequence = await this.nextSequence();
    return this.invoke(toolAction(sequence, operationId, invocation));
  }

  /**
   * Re-derives tool authority from the admitted immutable bundle rather than
   * from anything the runner supplied, so a compromised harness cannot widen
   * what the task may reach.
   *
   * Several names mean "at least one of these is declared". That is how
   * `shell.exec` is checked: every repository tool executes as a shell command,
   * so the transport alone cannot say which tool asked for it, and the only
   * sound check is that the task declared some repository capability at all.
   */
  private async assertToolDeclared(runId: string, ...toolNames: string[]): Promise<void> {
    const request = await this.loadRunRequest(runId, "tool authority enforcement");
    const declared = toolNames.some((toolName) => {
      const tool = TASK_TOOL_BY_HARNESS_NAME[toolName as keyof typeof TASK_TOOL_BY_HARNESS_NAME];
      return tool !== undefined && request.bundle.tools.includes(tool);
    });
    if (!declared) {
      throw new Error(`Task did not declare the ${toolNames.join(" or ")} tool`);
    }
  }

  /**
   * Records one ordered effect proposal durably.
   *
   * Durability lives here rather than in the Flue agent because the agent body
   * is replayed: a durable tool result is served from the journal without
   * re-running its handler, so proposals kept in the agent closure would be
   * lost on every replay and the plan would silently shrink. The session is
   * the one place that survives replay, reconnect, and a fresh runner.
   *
   * Idempotency is by effect digest, so a replayed identical call returns the
   * position it already holds instead of appending a second copy. Reusing a
   * step name for a *different* effect is a conflict, because a later step may
   * reference that name and must resolve to exactly one operation. Rewording
   * the rationale alone changes neither: the digest covers what will be done,
   * not why.
   *
   * Nothing before the transaction charges the budget, and the transaction
   * charges it only on the path that actually appends, so a malformed,
   * undeclared, or conflicting proposal costs the task no tool calls.
   */
  async recordProposal(input: TaskEffectProposalInvocationV1): Promise<TaskEffectProposalAckV1> {
    const sessionId = await this.ctx.storage.get<string>("session-id");
    if (!sessionId || input.runId !== sessionId) throw new Error("Effect proposal is not bound to this runner session");
    const proposal = taskEffectProposalV1Schema.parse(input.proposal);
    const digest = await proposalDigest(input.runId, proposal);
    const recorded = await recordedProposalIndex(this.ctx.storage, digest);
    if (recorded !== undefined) {
      const totalProposed = await this.ctx.storage.get<number>(PROPOSAL_COUNT_KEY) ?? 0;
      return { stepName: proposal.stepName, index: recorded, duplicate: true, totalProposed };
    }
    await this.assertRunActive(input.runId);
    const request = await this.loadRunRequest(input.runId, "effect authority enforcement");
    if (!(request.bundle.effects as readonly string[]).includes(proposal.kind)) {
      throw new Error(`Task did not declare the ${proposal.kind} effect`);
    }
    // Proposals are model tool calls and share the one declared tool budget
    // with repository reads, so a task cannot buy extra turns by proposing.
    // Charging and appending are one transaction: a budget spent without a
    // proposal behind it, or a proposal recorded without being charged, would
    // both be observable to a concurrent call.
    return this.ctx.storage.transaction(async (transaction) => {
      if (await transaction.get(CAPTURE_PENDING_KEY) || await transaction.get(CAPTURE_KEY)) {
        throw new Error("The working tree capture has started; no further effect proposal may be admitted");
      }
      return admitProposal(transaction, {
        proposal,
        digest,
        maxToolCalls: request.bundle.limits.maxToolCalls,
        recordedToolCalls: async () => (await transaction.list<StoredAction>({ prefix: ACTION_PREFIX })).size,
      });
    });
  }

  /** Ordered proposals recorded so far. Empty is valid and normal. */
  async listProposals(runId: string): Promise<readonly TaskEffectProposalV1[]> {
    const sessionId = await this.ctx.storage.get<string>("session-id");
    if (!sessionId || runId !== sessionId) throw new Error("Effect proposals are not bound to this runner session");
    return readProposalLedger(this.ctx.storage);
  }

  /**
   * Admits the trusted working-tree capture for this run.
   *
   * Called by `finish_task` on the task's behalf, never by the model. Every
   * question it answers is one the model must not be allowed to answer:
   *
   * - is a capture wanted at all? Only if the durable ledger already holds a
   *   step whose contents the capture owns. A capture with no consumer is
   *   refused, so a task cannot photograph a repository it never intended to
   *   commit;
   * - how many? Exactly one. Two commits would each claim the same whole-tree
   *   change set;
   * - against which commit? The one the verified OIDC hello bound the run to,
   *   never one the runner offered;
   * - is the answer honest? The reference and the manifest are cross-checked
   *   against each other and against the canonical bytes their digest covers,
   *   with no file content anywhere in the exchange.
   *
   * The result is written once. An exact replay is idempotent, and a second,
   * different capture is a conflict rather than an overwrite: the plan is
   * derived from whatever sits under this key, so a mutable capture would let
   * a settled run change what it commits.
   */
  async admitCapture(input: TaskCaptureAdmissionInvocationV1): Promise<TaskCaptureAdmissionAckV1> {
    const sessionId = await this.ctx.storage.get<string>("session-id");
    if (!sessionId || input.runId !== sessionId) {
      throw new Error("Repository capture is not bound to this runner session");
    }
    const existing = await this.ctx.storage.get<AdmittedTaskCaptureV1>(CAPTURE_KEY);
    if (existing) return { ...existing.ack, duplicate: true };
    await this.assertRunActive(input.runId);
    const request = await this.loadRunRequest(input.runId, "repository capture admission");
    const baseSha = request.event.repository.commitSha;
    // The generation changes only after a terminal attempt produced no capture.
    // It keeps replay within an attempt idempotent while allowing the model to
    // repair an unchanged/failed tree and request a genuinely fresh photograph.
    const generation = await this.ctx.storage.get<number>(CAPTURE_GENERATION_KEY) ?? 0;
    const operationId = `op_${await canonicalSha256({ runId: input.runId, capture: baseSha, generation })}`;
    await this.ctx.storage.transaction(async (transaction) => {
      const current = await transaction.get<AdmittedTaskCaptureV1>(CAPTURE_KEY);
      if (current) return;
      const currentGeneration = await transaction.get<number>(CAPTURE_GENERATION_KEY) ?? 0;
      if (currentGeneration !== generation) throw new Error("Repository capture generation changed; retry capture admission");
      const pending = await transaction.get<CapturePending>(CAPTURE_PENDING_KEY);
      if (pending && pending.operationId !== operationId) throw new Error("Repository capture admission conflict");
      await transaction.put<CapturePending>(CAPTURE_PENDING_KEY, { operationId, runId: input.runId, generation });
    });

    let runnerProducedCapture = false;
    try {
      const proposals = await readProposalLedger(this.ctx.storage);
      const consumers = captureMaterializingSteps(proposals);
      if (consumers.length === 0) {
        throw new Error("No proposed step materializes repository changes, so there is nothing to capture");
      }
      if (consumers.length > 1) {
        throw new Error(
          `Steps ${consumers.map((step) => step.stepName).join(", ")} each materialize repository changes, `
          + "but a run captures the working tree once",
        );
      }
      // Commit the barrier before draining. Calls that were already running may
      // settle; every later action/proposal loses its transactional admission.
      await this.settleUnresolvedBeforeNewAction(input.runId);
      const stored = await this.ctx.storage.get<StoredAction>(`${ACTION_PREFIX}${operationId}`);
      let result: RunnerActionResultV1;
      if (stored) {
        result = await this.invoke(stored.action);
      } else {
        await this.countCaptureToolCall(operationId);
        const sequence = await this.nextSequence();
        result = await this.invoke(captureAction(
          sequence,
          operationId,
          baseSha,
          Math.max(1, Math.min(5 * 60_000, remainingTaskRuntime(request.deadlineAt))),
          captureOutputBudget(request, proposals),
        ));
      }
      if (result.status === "completed" && result.exitCode === 0) {
        try {
          runnerProducedCapture = runnerCaptureResultV1Schema.parse(JSON.parse(result.stdout)).status === "captured";
        } catch {
          // `captureRecordFromResult` below owns the detailed validation error.
          // This flag only distinguishes a runner that already sealed an
          // artifact from an unchanged/failed attempt that remains repairable.
        }
      }
      const record = await captureRecordFromResult(result, baseSha);
      return await this.ctx.storage.transaction(async (transaction) => {
        const current = await transaction.get<AdmittedTaskCaptureV1>(CAPTURE_KEY);
        if (current) {
          if (canonicalJson(current) !== canonicalJson(record)) throw new Error("Repository capture conflict");
          await transaction.delete(CAPTURE_PENDING_KEY);
          return { ...current.ack, duplicate: true };
        }
        const pending = await transaction.get<CapturePending>(CAPTURE_PENDING_KEY);
        if (!pending || pending.operationId !== operationId) throw new Error("Repository capture pending marker was lost");
        await transaction.put<AdmittedTaskCaptureV1>(CAPTURE_KEY, record);
        await transaction.delete(CAPTURE_PENDING_KEY);
        return { ...record.ack, duplicate: false };
      });
    } catch (error) {
      // Clear only a terminal attempt that established no runner artifact, so
      // the model may repair an unchanged/failed tree and retry. If the runner
      // already sealed an artifact but admission rejected it, keep the barrier:
      // runner-side shell is also permanently closed, and reopening only the
      // Worker side would create two contradictory authorities.
      await this.ctx.storage.transaction(async (transaction) => {
        const pending = await transaction.get<CapturePending>(CAPTURE_PENDING_KEY);
        const action = await transaction.get<StoredAction>(`${ACTION_PREFIX}${operationId}`);
        const actionIsTerminal = action === undefined || action.state === "completed";
        if (pending?.operationId === operationId && actionIsTerminal && !runnerProducedCapture
          && !(await transaction.get(CAPTURE_KEY))) {
          await transaction.delete(CAPTURE_PENDING_KEY);
          const currentGeneration = await transaction.get<number>(CAPTURE_GENERATION_KEY) ?? 0;
          if (currentGeneration <= pending.generation) {
            await transaction.put(CAPTURE_GENERATION_KEY, pending.generation + 1);
          }
        }
      });
      throw error;
    }
  }

  /**
   * Counts the trusted capture against the shared tool counter without
   * applying the declared ceiling to it.
   *
   * Counting keeps the accounting honest: the capture is a real runner action
   * and appears in the journal like any other, and a model call after it sees
   * a counter that includes it. Exempting it from the ceiling is deliberate
   * — `max-tool-calls` is a budget an author sets for the *model*, and the
   * capture is issued by trusted code after the model's last turn. Charging it
   * would mean a task that spent its budget exactly could never commit the
   * work it had already done, failing a correct run on an accounting detail.
   */
  private async countCaptureToolCall(operationId: string): Promise<void> {
    await this.ctx.storage.transaction(async (transaction) => {
      const reservationKey = `${RUNNER_TOOL_RESERVATION_PREFIX}${operationId}`;
      if (await transaction.get(reservationKey)) return;
      const recorded = await transaction.list<StoredAction>({ prefix: ACTION_PREFIX });
      const reserved = await transaction.get<number>(RUNNER_TOOL_COUNT_KEY) ?? recorded.size;
      await transaction.put(reservationKey, true);
      await transaction.put(RUNNER_TOOL_COUNT_KEY, reserved + 1);
    });
  }

  /** The admitted immutable request, which is the only source of authority. */
  private async loadRunRequest(runId: string, purpose: string): Promise<TaskRunRequestV1> {
    const row = await this.env.DB.prepare("SELECT request_json FROM actions_task_runs WHERE id=?")
      .bind(runId).first<{ request_json: string }>();
    if (!row) throw new Error(`Task run request is unavailable for ${purpose}`);
    return taskRunRequestV1Schema.parse(JSON.parse(row.request_json));
  }

  /** Capture admitted for this run, if any. Absent means capture-deferred steps fail. */
  private async admittedCapture(): Promise<TaskEffectPlanCaptureV1 | undefined> {
    const stored = await this.ctx.storage.get<AdmittedTaskCaptureV1>(CAPTURE_KEY);
    return stored === undefined ? undefined : { manifest: stored.manifest, changesSha256: stored.changesSha256 };
  }

  /** Internal DO-to-DO lookup; this method is not exposed by the Cap'n Web public API. */
  async effectPlanCaptureForRuntime(planRunId: string): Promise<TaskEffectPlanCaptureV1 | undefined> {
    const sessionId = await this.ctx.storage.get<string>("session-id");
    if (sessionId !== planRunId) throw new Error("Capture lookup is not bound to the planning session");
    return this.admittedCapture();
  }

  async priorEffectReceipt(planRunId: string, artifactSha256: string): Promise<RunnerEffectReceiptV1 | null> {
    const { row } = await this.effectPlanBinding(planRunId, artifactSha256);
    return row.effect_receipt_json
      ? runnerEffectReceiptV1Schema.parse(JSON.parse(row.effect_receipt_json))
      : null;
  }

  async invokeAuthenticated(input: RunnerActionV1): Promise<RunnerActionResultV1> {
    const identity = this.#identity;
    if (!identity || identity.hello.phase !== "plan") throw new Error("Runner action requires an authenticated planning session");
    const action = runnerActionV1Schema.parse(input);
    // The capture is issued by the runtime, never requested. Accepting one
    // here would let a runner decide when the working tree is photographed,
    // which is the single decision this whole boundary exists to keep away
    // from anything the task can influence.
    if (action.kind === "repository.capture") {
      throw new Error("Repository capture cannot be requested by the runner");
    }
    const existing = await this.ctx.storage.get<StoredAction>(`${ACTION_PREFIX}${action.operationId}`);
    if (!existing) {
      await this.assertRunActive(identity.sessionId);
      await this.assertCaptureNotSettled();
      // Actions arriving directly over the authenticated capability are held to
      // the same declared-tool authority and tool budget as the ones the harness
      // requests, so this path cannot be used to bypass either.
      await this.assertToolDeclared(identity.sessionId, ...actionToolAuthority(action.kind));
      await this.reserveRunnerToolBudget(identity.sessionId, action.operationId);
    }
    return this.invoke(action);
  }

  async invoke(input: RunnerActionV1): Promise<RunnerActionResultV1> {
    const action = runnerActionV1Schema.parse(input);
    const key = `${ACTION_PREFIX}${action.operationId}`;
    const canonicalAction = canonicalValue(action);
    const existing = await this.ctx.storage.get<StoredAction>(key);
    if (existing) {
      if (existing.canonicalAction !== canonicalAction) throw new Error("Operation ID conflict");
      if (existing.state === "completed" && existing.result) return existing.result;
      if (this.#runner) {
        try {
          const recovered = await this.#runner.result(action.operationId);
          if (recovered) return this.reconcile(recovered);
        } catch { /* a replacement runner will reconcile; never replay here */ }
      }
      return this.waitForResult(action.operationId, await this.runDeadline());
    }
    if (!this.#runner) throw new Error("No authenticated runner is connected");
    const admitted = await this.ctx.storage.transaction(async (transaction) => {
      const raced = await transaction.get<StoredAction>(key);
      if (raced) return false;
      if (action.kind !== "repository.capture" && (
        await transaction.get(CAPTURE_PENDING_KEY) || await transaction.get(CAPTURE_KEY)
      )) {
        throw new Error("The working tree capture has started; no further repository action may run");
      }
      await transaction.put<StoredAction>(key, { canonicalAction, state: "running", action });
      return true;
    });
    if (!admitted) return this.invoke(action);
    try {
      return await this.reconcile(runnerActionResultV1Schema.parse(await this.#runner.execute(action)));
    } catch {
      await this.ctx.storage.put<StoredAction>(key, { canonicalAction, state: "ambiguous", action });
      // Do not surface ambiguity to the model: it could issue a fresh shell
      // call and accidentally replay work. Reconnect/resume must reconcile the
      // runner-local result, or the immutable run deadline ends the task.
      return this.waitForResult(action.operationId, await this.runDeadline());
    }
  }

  async reconcile(input: RunnerActionResultV1): Promise<RunnerActionResultV1> {
    const result = runnerActionResultV1Schema.parse(input);
    const key = `${ACTION_PREFIX}${result.operationId}`;
    const existing = await this.ctx.storage.get<StoredAction>(key);
    if (!existing) throw new Error("Unknown operation result");
    if (existing.action.sequence !== result.sequence) throw new Error("Operation sequence mismatch");
    const bytes = new TextEncoder().encode(result.stdout).byteLength + new TextEncoder().encode(result.stderr).byteLength;
    if (bytes > existing.action.maxOutputBytes) throw new Error("Operation output exceeds its byte limit");
    const canonicalResult = canonicalValue(result);
    if (existing.state === "completed") {
      if (existing.canonicalResult !== canonicalResult) throw new Error("Operation result conflict");
      return existing.result!;
    }
    await this.ctx.storage.put<StoredAction>(key, { ...existing, state: "completed", result, canonicalResult });
    for (const resolve of this.#resultWaiters.get(result.operationId) ?? []) resolve(result);
    this.#resultWaiters.delete(result.operationId);
    return result;
  }

  async resume(input: ResumeCursorV1, runner: RpcStub<RunnerCapability>): Promise<ResumeStateV1> {
    const cursor = resumeCursorV1Schema.parse(input);
    this.#runner?.[Symbol.dispose]();
    this.#runner = runner.dup();
    let actions = await this.ctx.storage.list<StoredAction>({ prefix: ACTION_PREFIX });
    for (const record of actions.values()) {
      if (record.state === "completed") continue;
      const result = await runner.result(record.action.operationId);
      if (result) await this.reconcile(result);
    }
    actions = await this.ctx.storage.list<StoredAction>({ prefix: ACTION_PREFIX });
    const nextServerSequence = Math.max(0, ...[...actions.values()].map((record) => record.action.sequence)) + 1;
    if (cursor.lastServerSequence >= nextServerSequence) throw new Error("Resume cursor is ahead of the server");
    return {
      schemaVersion: "gardener.runner.resume-state/v1",
      nextServerSequence,
      unresolvedOperationIds: [...actions.values()]
        .filter((record) => record.state !== "completed")
        .sort((left, right) => left.action.sequence - right.action.sequence)
        .map((record) => record.action.operationId),
    };
  }

  /**
   * Persists an exact-plan receipt. The authenticated effects attempt remains
   * exact, but it may continue a plan from an earlier attempt of the same
   * workflow run when GitHub re-runs failed jobs and skips the successful plan
   * job. The lookup is by immutable artifact identity, never by fabricating a
   * planning row for the new attempt.
   */
  async recordEffect(input: RunnerEffectReceiptV1): Promise<RunnerEffectReceiptV1> {
    const receipt = runnerEffectReceiptV1Schema.parse(input);
    const { plan, row } = await this.effectPlanBinding(receipt.planRunId, receipt.artifactSha256);
    assertReceiptMatchesPlan(plan, receipt);
    const existing = row.effect_receipt_json
      ? runnerEffectReceiptV1Schema.parse(JSON.parse(row.effect_receipt_json))
      : null;
    if (existing && canonicalJson(existing) === canonicalJson(receipt)) return existing;
    if (existing) assertMonotonicReceipt(existing, receipt);

    const previous = row.effect_receipt_json;
    const update = await this.env.DB.prepare(
      previous === null
        ? "UPDATE actions_task_runs SET effect_receipt_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND effect_receipt_json IS NULL"
        : "UPDATE actions_task_runs SET effect_receipt_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND effect_receipt_json=?",
    ).bind(...(previous === null
      ? [JSON.stringify(receipt), receipt.planRunId]
      : [JSON.stringify(receipt), receipt.planRunId, previous])).run();
    if ((update.meta.changes ?? 0) !== 1) {
      const raced = await this.env.DB.prepare("SELECT effect_receipt_json FROM actions_task_runs WHERE id=?")
        .bind(receipt.planRunId).first<{ effect_receipt_json: string | null }>();
      if (!raced?.effect_receipt_json) throw new Error("Effect receipt persistence conflict");
      const settled = runnerEffectReceiptV1Schema.parse(JSON.parse(raced.effect_receipt_json));
      if (canonicalJson(settled) !== canonicalJson(receipt)) throw new Error("Effect receipt persistence conflict");
      return settled;
    }
    await this.env.DB.prepare("INSERT INTO actions_task_audit (run_id,event,detail_json) VALUES (?,'effect.progress',?)")
      .bind(receipt.planRunId, JSON.stringify(receipt)).run();
    return receipt;
  }

  private async effectPlanBinding(planRunId: string, artifactSha256: string): Promise<{
    plan: Awaited<ReturnType<typeof buildTaskEffectPlan>>;
    row: { request_json: string; outcome_json: string | null; effect_receipt_json: string | null };
  }> {
    const identity = this.#identity;
    if (!identity || identity.hello.phase !== "effects") throw new Error("Effects receipt requires an authenticated effects session");
    if (!/^[a-f0-9]{64}$/.test(artifactSha256)) throw new Error("Effect artifact digest is invalid");
    const row = await this.env.DB.prepare(
      "SELECT request_json,outcome_json,effect_receipt_json FROM actions_task_runs WHERE id=?",
    ).bind(planRunId).first<{ request_json: string; outcome_json: string | null; effect_receipt_json: string | null }>();
    if (!row?.outcome_json) throw new Error("Effect plan has no completed planning outcome");
    const request = taskRunRequestV1Schema.parse(JSON.parse(row.request_json));
    const outcome = taskOutcomeV1Schema.parse(JSON.parse(row.outcome_json));
    if (outcome.status !== "completed") throw new Error("Effect plan answers a planning run that produced no plan");
    const original = request.event;
    if (original.workflow.runId !== identity.hello.runId
      || original.workflow.runAttempt > identity.hello.runAttempt
      || original.repository.id !== identity.hello.repositoryId
      || original.repository.commitSha !== identity.hello.commitSha
      || original.workflow.workflowRef !== identity.hello.workflowRef
      || original.workflow.eventName !== identity.hello.eventName
      || request.bundleHash !== identity.hello.agentHash) {
      throw new Error("Effect plan is not bound to this repository workflow run and attempt");
    }
    const planStub = this.env.RUNNER_SESSIONS.get(this.env.RUNNER_SESSIONS.idFromName(planRunId));
    const capture = await planStub.effectPlanCaptureForRuntime(planRunId);
    const plan = await buildTaskEffectPlan({ request, outcome, ...(capture ? { capture } : {}) });
    const derived = await canonicalSha256Bytes(new TextEncoder().encode(canonicalJson(plan)));
    if (derived !== artifactSha256) throw new Error("Effect artifact binding mismatch");
    return { plan, row };
  }

  async runTask(eventInput?: RunnerEventV1): Promise<RunnerTerminalV1> {
    const identity = this.#identity;
    if (!identity) throw new Error("Runner session is not authenticated");
    if (identity.hello.phase !== "plan") {
      throw new Error("The task runtime admits only planning runs");
    }
    const runnerEvent = runnerEventV1Schema.parse(eventInput);
    // The payload is untrusted. Its kind must agree with the event name GitHub
    // signed into the OIDC claims, so a caller cannot present a discussion
    // payload for an issues run and reach a trigger it was not granted.
    if (eventNameByTriggerKind[runnerEvent.kind] !== identity.hello.eventName) {
      throw new Error(
        `Reported event ${runnerEvent.kind} does not match the ${identity.hello.eventName} event in the verified OIDC claims`,
      );
    }
    const { bundle, bundleHash, sourcePath } = await loadEnabledTaskBundle(
      this.env.DB,
      identity.enrollment.repository_id,
      identity.hello.agentHash,
    );
    const admittedAt = new Date().toISOString();
    const freshRequest = {
      schemaVersion: "gardener.task-run-request/v1" as const,
      runId: identity.sessionId,
      bundle,
      bundleHash,
      sourcePath,
      policySnapshotHash: await canonicalSha256({ enrollment: identity.enrollment.repository_id, workflow: identity.enrollment.plan_job_workflow_ref }),
      event: {
        ...eventPayload(runnerEvent),
        schemaVersion: "gardener.normalized-event/v1" as const,
        eventId: `github:${identity.hello.runId}:${identity.hello.runAttempt}`,
        occurredAt: admittedAt,
        repository: {
          id: identity.enrollment.repository_id,
          ownerId: identity.enrollment.owner_id,
          owner: identity.enrollment.owner_login,
          name: identity.enrollment.repository_name,
          fullName: `${identity.enrollment.owner_login}/${identity.enrollment.repository_name}`,
          visibility: identity.enrollment.visibility,
          commitSha: identity.hello.commitSha,
          ref: identity.hello.ref,
          defaultBranch: runnerEvent.repository.defaultBranch,
        },
        workflow: {
          runId: identity.hello.runId,
          runAttempt: identity.hello.runAttempt,
          eventName: identity.hello.eventName,
          workflowRef: identity.hello.workflowRef,
          jobWorkflowRef: identity.hello.jobWorkflowRef,
          runnerEnvironment: identity.hello.runnerEnvironment,
        },
        actor: { id: identity.actor.actorId, login: identity.actor.actorLogin },
      },
      model: { id: this.env.AI_MODEL },
      admittedAt,
      deadlineAt: new Date(Date.parse(admittedAt) + bundle.limits.runtimeSeconds * 1_000).toISOString(),
    };
    const existing = await this.env.DB.prepare(
      "SELECT status,request_json,harness_submission_json,outcome_json FROM actions_task_runs WHERE id=?",
    ).bind(identity.sessionId).first<{ status: string; request_json: string; harness_submission_json: string | null; outcome_json: string | null }>();
    const request = existing
      ? taskRunRequestV1Schema.parse(JSON.parse(existing.request_json))
      : taskRunRequestV1Schema.parse(freshRequest);
    if (request.runId !== identity.sessionId || request.bundleHash !== bundleHash) {
      throw new Error("Persisted task request does not match the authenticated run");
    }
    await this.env.DB.prepare(
      "INSERT OR IGNORE INTO actions_task_runs (id,repository_id,github_run_id,github_run_attempt,phase,bundle_hash,request_json,status) VALUES (?,?,?,?,?,?,?,'admitted')",
    ).bind(identity.sessionId, identity.enrollment.repository_id, identity.hello.runId, identity.hello.runAttempt, identity.hello.phase, bundleHash, JSON.stringify(request)).run();
    if (existing?.outcome_json) {
      return (await this.settleTerminal(request, taskOutcomeV1Schema.parse(JSON.parse(existing.outcome_json)))).terminal;
    }
    const cancelReason = await this.ctx.storage.get<string>("cancel-intent");
    if (cancelReason) return this.settleCancellation(request, cancelReason);
    const harnessRequest = await createTaskHarnessRequest(request);
    const harness = new FlueTaskHarness();
    let submission: HarnessSubmission;
    if (existing?.harness_submission_json) {
      submission = JSON.parse(existing.harness_submission_json) as HarnessSubmission;
    } else {
      submission = await harness.start(harnessRequest);
      await this.env.DB.prepare(
        "UPDATE actions_task_runs SET harness_submission_json=?,status='running',updated_at=CURRENT_TIMESTAMP WHERE id=? AND harness_submission_json IS NULL",
      ).bind(JSON.stringify(submission), identity.sessionId).run();
    }
    const remainingRuntimeMs = remainingTaskRuntime(request.deadlineAt);
    if (remainingRuntimeMs <= 0) {
      await harness.cancel({ runId: request.runId, reason: "Task runtime deadline expired before inference" }).catch(() => undefined);
      const failed = taskOutcomeV1Schema.parse({
        schemaVersion: "gardener.task-outcome/v1",
        runId: request.runId,
        taskId: request.bundle.taskId,
        bundleHash: request.bundleHash,
        status: "failed",
        error: { code: "runtime.deadline_exceeded", message: "Task runtime deadline expired", retryable: false },
      });
      await this.env.DB.batch([
        this.env.DB.prepare(
          "UPDATE actions_task_runs SET status='failed',outcome_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND outcome_json IS NULL",
        ).bind(JSON.stringify(failed), identity.sessionId),
        this.env.DB.prepare(
          "INSERT INTO actions_task_audit (run_id,event,detail_json) " +
          "SELECT ?,'task.settled',? WHERE NOT EXISTS (SELECT 1 FROM actions_task_audit WHERE run_id=? AND event='task.settled')",
        ).bind(identity.sessionId, JSON.stringify({ status: "failed", code: "runtime.deadline_exceeded", bundleHash }), identity.sessionId),
      ]);
      return terminalFromOutcome(failed, await this.completedSequence(), request);
    }
    const harnessOutcome = await harness.read(submission, {
      signal: AbortSignal.timeout(Math.max(1, remainingRuntimeMs)),
    });
    const terminalRow = await this.env.DB.prepare("SELECT outcome_json FROM actions_task_runs WHERE id=?")
      .bind(identity.sessionId).first<{ outcome_json: string | null }>();
    const outcome = terminalRow?.outcome_json
      ? taskOutcomeV1Schema.parse(JSON.parse(terminalRow.outcome_json))
      : translateHarnessOutcome(request, harnessOutcome);
    if (outcome.status === "cancelled") {
      await this.env.DB.batch([
        this.env.DB.prepare(
          "UPDATE actions_task_runs SET status='cancelled',outcome_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND outcome_json IS NULL",
        ).bind(JSON.stringify(outcome), identity.sessionId),
        this.env.DB.prepare(
          "INSERT INTO actions_task_audit (run_id,event,detail_json) " +
          "SELECT ?,'task.cancelled',? WHERE NOT EXISTS (SELECT 1 FROM actions_task_audit WHERE run_id=? AND event='task.cancelled')",
        ).bind(identity.sessionId, JSON.stringify({ reason: outcome.reason }), identity.sessionId),
      ]);
      return terminalFromOutcome(outcome, await this.completedSequence(), request);
    }
    // Settled *before* anything is persisted. Building the plan is the last
    // validation a run gets, and a plan that cannot be built is a failed run,
    // not a completed one whose terminal happens to throw.
    const settled = await this.settleTerminal(request, outcome);
    await this.env.DB.batch([
      this.env.DB.prepare(
        "UPDATE actions_task_runs SET status=?,outcome_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND outcome_json IS NULL",
      ).bind(settled.outcome.status, JSON.stringify(settled.outcome), identity.sessionId),
      this.env.DB.prepare(
        "INSERT INTO actions_task_audit (run_id,event,detail_json) " +
        "SELECT ?,'task.settled',? WHERE NOT EXISTS (SELECT 1 FROM actions_task_audit WHERE run_id=? AND event='task.settled')",
      ).bind(identity.sessionId, JSON.stringify({ status: settled.outcome.status, bundleHash }), identity.sessionId),
    ]);
    return settled.terminal;
  }

  /**
   * Derives the terminal for an outcome, and the outcome that should be
   * durable alongside it.
   *
   * Building the effect plan is where the last authority checks happen: the
   * declared-effect allowlist, step references, the operation ceiling, the
   * byte ceiling, and the capture binding. Those can only be checked once the
   * model has stopped proposing, so they necessarily run after a model run
   * that believes it succeeded.
   *
   * A rejection there is a *failed run*. Persisting `completed` and then
   * throwing would be the worst of both: D1 would report a success that has
   * no plan, and every reconnect would re-read that row, rebuild the same
   * invalid plan, and throw again — a run wedged forever with no terminal.
   * Translating the rejection into a durable failed outcome keeps the two
   * consistent, and because the translation is a pure function of the stored
   * outcome it replays byte-identically: the persisted row is already failed,
   * so a reconnecting runner takes the non-completed path and derives the same
   * terminal it was given the first time.
   */
  private async settleTerminal(
    request: TaskRunRequestV1,
    outcome: TaskOutcomeV1,
  ): Promise<{ outcome: TaskOutcomeV1; terminal: RunnerTerminalV1 }> {
    const sequence = await this.completedSequence();
    if (outcome.status !== "completed") {
      return { outcome, terminal: await terminalFromOutcome(outcome, sequence, request) };
    }
    const capture = await this.admittedCapture();
    const settled = await settledTaskOutcome({ request, outcome, capture });
    return {
      outcome: settled,
      terminal: await terminalFromOutcome(
        settled,
        sequence,
        request,
        settled.status === "completed" ? capture : undefined,
      ),
    };
  }

  async cancelRun(reasonInput: string): Promise<void> {
    const identity = this.#identity;
    if (!identity || identity.hello.phase !== "plan") throw new Error("Only an authenticated planning session can be cancelled");
    const reason = reasonInput.trim().slice(0, 500) || "Planning runner cancelled";
    await this.ctx.storage.put("cancel-intent", reason);
    const row = await this.env.DB.prepare(
      "SELECT request_json,harness_submission_json,outcome_json FROM actions_task_runs WHERE id=?",
    ).bind(identity.sessionId).first<{
      request_json: string;
      harness_submission_json: string | null;
      outcome_json: string | null;
    }>();
    if (!row || row.outcome_json) return;

    const request = taskRunRequestV1Schema.parse(JSON.parse(row.request_json));
    await new FlueTaskHarness().cancel({ runId: request.runId, reason }).catch(() => undefined);
    const actions = await this.ctx.storage.list<StoredAction>({ prefix: ACTION_PREFIX });
    await Promise.all([...actions.values()]
      .filter((record) => record.state !== "completed")
      .map((record) => this.#runner?.cancel(record.action.operationId).catch(() => undefined)));

    await this.settleCancellation(request, reason);
  }

  /**
   * Closes the run's working tree once its capture has been admitted.
   *
   * The capture is the photograph a commit is filled from, and it is taken
   * inside the terminal, after the model's last turn. A command that ran
   * afterwards would change the tree the plan claims to commit, so the plan
   * and the repository would disagree about what the run did. The terminal
   * already returns immediately; this makes the ordering an enforced property
   * of the session rather than a consequence of how the agent is written.
   */
  private async assertCaptureNotSettled(): Promise<void> {
    const [pending, settled] = await Promise.all([
      this.ctx.storage.get(CAPTURE_PENDING_KEY),
      this.ctx.storage.get(CAPTURE_KEY),
    ]);
    if (pending || settled) {
      throw new Error("The working tree capture has started for this run; no further repository action may run");
    }
  }

  private async assertRunActive(runId: string): Promise<void> {
    if (await this.ctx.storage.get("cancel-intent")) throw new Error("Task run is cancelled");
    const row = await this.env.DB.prepare(
      "SELECT status,outcome_json FROM actions_task_runs WHERE id=?",
    ).bind(runId).first<{ status: string; outcome_json: string | null }>();
    if (!row || row.outcome_json || (row.status !== "admitted" && row.status !== "running")) {
      throw new Error("Task run is terminal or unavailable");
    }
  }

  private async settleCancellation(request: TaskRunRequestV1, reason: string): Promise<RunnerTerminalV1> {
    const outcome = taskOutcomeV1Schema.parse({
      schemaVersion: "gardener.task-outcome/v1",
      runId: request.runId,
      taskId: request.bundle.taskId,
      bundleHash: request.bundleHash,
      status: "cancelled",
      reason,
    });
    await this.env.DB.batch([
      this.env.DB.prepare(
        "UPDATE actions_task_runs SET status='cancelled',outcome_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND outcome_json IS NULL",
      ).bind(JSON.stringify(outcome), request.runId),
      this.env.DB.prepare(
        "INSERT INTO actions_task_audit (run_id,event,detail_json) " +
        "SELECT ?,'task.cancelled',? WHERE NOT EXISTS (SELECT 1 FROM actions_task_audit WHERE run_id=? AND event='task.cancelled')",
      ).bind(request.runId, JSON.stringify({ reason }), request.runId),
    ]);
    return terminalFromOutcome(outcome, await this.completedSequence(), request);
  }

  private async reserveRunnerToolBudget(runId: string, operationId: string): Promise<void> {
    const request = await this.loadRunRequest(runId, "tool budget enforcement");
    await this.ctx.storage.transaction(async (transaction) => {
      if (await transaction.get(CAPTURE_PENDING_KEY) || await transaction.get(CAPTURE_KEY)) {
        throw new Error("The working tree capture has started; no further repository action may run");
      }
      const reservationKey = `${RUNNER_TOOL_RESERVATION_PREFIX}${operationId}`;
      if (await transaction.get(reservationKey)) return;
      const recorded = await transaction.list<StoredAction>({ prefix: ACTION_PREFIX });
      const reserved = await transaction.get<number>(RUNNER_TOOL_COUNT_KEY) ?? recorded.size;
      assertRunnerToolBudget(request.bundle.limits.maxToolCalls, reserved);
      await transaction.put(reservationKey, true);
      await transaction.put(RUNNER_TOOL_COUNT_KEY, reserved + 1);
    });
  }

  private async settleUnresolvedBeforeNewAction(runId: string): Promise<void> {
    const actions = await this.ctx.storage.list<StoredAction>({ prefix: ACTION_PREFIX });
    const unresolved = [...actions.values()].filter((record) => record.state !== "completed");
    for (const record of unresolved) {
      if (this.#runner) {
        try {
          const result = await this.#runner.result(record.action.operationId);
          if (result) { await this.reconcile(result); continue; }
        } catch { /* wait below */ }
      }
      await this.waitForResult(record.action.operationId, await this.runDeadline(runId));
    }
  }

  private async waitForResult(operationId: string, deadlineAt: number): Promise<RunnerActionResultV1> {
    const existing = await this.ctx.storage.get<StoredAction>(`${ACTION_PREFIX}${operationId}`);
    if (existing?.state === "completed" && existing.result) return existing.result;
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) throw new Error("Ambiguous runner action was not reconciled before the run deadline");
    return new Promise<RunnerActionResultV1>((resolve, reject) => {
      const waiters = this.#resultWaiters.get(operationId) ?? new Set();
      let timeout: ReturnType<typeof setTimeout>;
      const wrapped = (result: RunnerActionResultV1) => { clearTimeout(timeout); resolve(result); };
      waiters.add(wrapped);
      this.#resultWaiters.set(operationId, waiters);
      timeout = setTimeout(() => {
        waiters.delete(wrapped);
        if (waiters.size === 0) this.#resultWaiters.delete(operationId);
        reject(new Error("Ambiguous runner action was not reconciled before the run deadline"));
      }, remaining);
      timeout.unref?.();
    });
  }

  private async runDeadline(runId?: string): Promise<number> {
    const id = runId ?? await this.ctx.storage.get<string>("session-id");
    if (!id) return Date.now() + 10 * 60_000;
    const row = await this.env.DB.prepare("SELECT request_json FROM actions_task_runs WHERE id=?")
      .bind(id).first<{ request_json: string }>();
    if (!row) return Date.now() + 10 * 60_000;
    try {
      const deadline = Date.parse((JSON.parse(row.request_json) as { deadlineAt?: string }).deadlineAt ?? "");
      return Number.isFinite(deadline) ? deadline : Date.now() + 10 * 60_000;
    } catch {
      return Date.now() + 10 * 60_000;
    }
  }

  private async consumeOidcToken(jti: string, expiresAt: number): Promise<void> {
    const key = `${OIDC_PREFIX}${jti}`;
    await this.ctx.storage.transaction(async (transaction) => {
      if (await transaction.get(key)) throw new Error("OIDC token was already used");
      await transaction.put(key, expiresAt);
    });
  }

  private async nextSequence(): Promise<number> {
    return this.ctx.storage.transaction(async (transaction) => {
      const current = await transaction.get<number>("next-sequence") ?? 1;
      await transaction.put("next-sequence", current + 1);
      return current;
    });
  }

  private async completedSequence(): Promise<number> {
    const actions = await this.ctx.storage.list<StoredAction>({ prefix: ACTION_PREFIX });
    return Math.max(0, ...[...actions.values()].filter((record) => record.state === "completed").map((record) => record.action.sequence));
  }
}

class PublicApi extends RpcTarget implements PublicSessionCapability {
  constructor(readonly session: TaskRunnerSession, readonly routedSessionId: string) { super(); }
  async authenticate(hello: RunnerHelloV1, token: string, runner: RpcStub<RunnerCapability>): Promise<AuthenticatedApi> {
    await this.session.authenticate(hello, token, runner, this.routedSessionId);
    return new AuthenticatedApi(this.session);
  }
}

class AuthenticatedApi extends RpcTarget implements AuthenticatedSessionCapability {
  constructor(readonly session: TaskRunnerSession) { super(); }
  run(event?: RunnerEventV1): Promise<RunnerTerminalV1> { return this.session.runTask(event); }
  cancelRun(reason: string): Promise<void> { return this.session.cancelRun(reason); }
  invoke(action: RunnerActionV1): Promise<RunnerActionResultV1> { return this.session.invokeAuthenticated(action); }
  reconcile(result: RunnerActionResultV1): Promise<RunnerActionResultV1> { return this.session.reconcile(result); }
  resume(cursor: ResumeCursorV1, runner: RpcStub<RunnerCapability>): Promise<ResumeStateV1> { return this.session.resume(cursor, runner); }
  recordEffect(receipt: RunnerEffectReceiptV1): Promise<RunnerEffectReceiptV1> { return this.session.recordEffect(receipt); }
  priorEffectReceipt(planRunId: string, artifactSha256: string): Promise<RunnerEffectReceiptV1 | null> {
    return this.session.priorEffectReceipt(planRunId, artifactSha256);
  }
}

/**
 * Strips the wire envelope from the untrusted payload, keeping only the event
 * kind and its bounded body. Repository, workflow, and actor identity are
 * supplied separately from the verified OIDC hello and enrollment, so they can
 * never be overridden by the runner.
 */
function eventPayload(event: RunnerEventV1): Omit<RunnerEventV1, "schemaVersion"> {
  const { schemaVersion: _schemaVersion, ...payload } = event;
  return payload;
}

function toolAction(sequence: number, operationId: string, invocation: HarnessToolInvocation): RunnerActionV1 {
  const input = invocation.input;
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new Error("Repository tool input must be an object");
  const value = input as Record<string, JsonValue>;
  if (invocation.toolName === "provider_api_read") return providerReadAction(sequence, operationId, value);
  let command: string;
  let cwd = "/workspace";
  let timeoutMs = 30_000;
  let maxOutputBytes = 256 * 1_024;
  if (invocation.toolName === "repository_read_file") {
    exactKeys(value, ["path"]);
    const path = repositoryPath(value.path);
    command = `python3 -c 'import pathlib,sys; root=pathlib.Path.cwd().resolve(); target=pathlib.Path(sys.argv[1]).resolve(); target.relative_to(root); print(target.read_text(encoding="utf-8"), end="")' ${shellQuote(path)}`;
  } else if (invocation.toolName === "repository_list_files") {
    exactKeys(value, ["path", "maxEntries"], true);
    const path = value.path === undefined || value.path === "." ? "." : repositoryPath(value.path);
    const maxEntries = integer(value.maxEntries ?? 1_000, 1, 10_000, "maxEntries");
    command = `git ls-files --cached --others --exclude-standard -- ${shellQuote(path)} | sed -n '1,${maxEntries}p'`;
  } else if (invocation.toolName === "repository_exec") {
    exactKeys(value, ["command", "cwd", "timeoutMs", "maxOutputBytes"], true);
    if (typeof value.command !== "string" || value.command.length < 1 || value.command.length > 64 * 1_024) throw new Error("Invalid repository command");
    command = value.command;
    if (value.cwd !== undefined) cwd = `/workspace/${repositoryPath(value.cwd)}`.replace(/\/$/, "");
    if (value.timeoutMs !== undefined) timeoutMs = integer(value.timeoutMs, 1, 10 * 60_000, "timeoutMs");
    if (value.maxOutputBytes !== undefined) maxOutputBytes = integer(value.maxOutputBytes, 1, 4 * 1_024 * 1_024, "maxOutputBytes");
  } else {
    throw new Error("Unknown repository tool");
  }
  return runnerActionV1Schema.parse({ schemaVersion: "gardener.runner.action/v1", sequence, operationId, kind: "shell.exec", command, cwd, timeoutMs, maxOutputBytes });
}

/** Matches the bridge-side `maxVariablesBytes` limit in `github-read.ts`. */
const MAX_GRAPHQL_VARIABLES_BYTES = 32 * 1_024;
const MAX_GRAPHQL_VARIABLES = 64;

/**
 * Builds the read-only provider action. Only GET/HEAD REST reads and GraphQL
 * query documents are representable; the bridge enforces the same rules again
 * before any request leaves the runner.
 */
function providerReadAction(sequence: number, operationId: string, value: Record<string, JsonValue>): RunnerActionV1 {
  exactKeys(value, ["transport", "method", "path", "query", "variables", "operationName", "timeoutMs", "maxOutputBytes"], true);
  const timeoutMs = value.timeoutMs === undefined ? 30_000 : integer(value.timeoutMs, 1, 10 * 60_000, "timeoutMs");
  const maxOutputBytes = value.maxOutputBytes === undefined
    ? 256 * 1_024
    : integer(value.maxOutputBytes, 1, 1_024 * 1_024, "maxOutputBytes");
  const transport = value.transport ?? "rest";
  let request: JsonValue;
  if (transport === "rest") {
    if (value.query !== undefined || value.variables !== undefined || value.operationName !== undefined) {
      throw new Error("REST provider reads cannot carry GraphQL fields");
    }
    const method = value.method === undefined ? "GET" : value.method;
    if (method !== "GET" && method !== "HEAD") throw new Error("The provider read tool permits only GET and HEAD");
    if (typeof value.path !== "string" || value.path.length < 1 || value.path.length > 2_048) {
      throw new Error("Invalid provider read path");
    }
    request = { transport: "rest", method, path: value.path };
  } else if (transport === "graphql") {
    if (value.method !== undefined || value.path !== undefined) {
      throw new Error("GraphQL provider reads cannot carry REST fields");
    }
    if (typeof value.query !== "string" || value.query.length < 1 || value.query.length > 32 * 1_024) {
      throw new Error("Invalid provider read query");
    }
    const graphql: Record<string, JsonValue> = { transport: "graphql", query: value.query };
    if (value.variables !== undefined) {
      if (value.variables === null || typeof value.variables !== "object" || Array.isArray(value.variables)) {
        throw new Error("Provider read variables must be an object");
      }
      // Bound before the action is canonicalized into durable storage, so a
      // model cannot grow the Durable Object record with arbitrary payloads.
      const serialized = JSON.stringify(value.variables);
      if (serialized === undefined || new TextEncoder().encode(serialized).byteLength > MAX_GRAPHQL_VARIABLES_BYTES) {
        throw new Error("Provider read variables exceed the size limit");
      }
      if (Object.keys(value.variables).length > MAX_GRAPHQL_VARIABLES) {
        throw new Error("Provider read variables exceed the count limit");
      }
      graphql.variables = value.variables;
    }
    if (value.operationName !== undefined) {
      if (typeof value.operationName !== "string") throw new Error("Invalid provider read operationName");
      graphql.operationName = value.operationName;
    }
    request = graphql;
  } else {
    throw new Error("Provider read transport must be rest or graphql");
  }
  return runnerActionV1Schema.parse({
    schemaVersion: "gardener.runner.action/v1",
    sequence,
    operationId,
    kind: "github.read",
    request,
    timeoutMs,
    maxOutputBytes,
  });
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

function exactKeys(value: Record<string, JsonValue>, allowed: readonly string[], optional = false): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`Unknown repository tool input ${key}`);
  if (!optional) for (const key of allowed) if (!(key in value)) throw new Error(`Missing repository tool input ${key}`);
}

function repositoryPath(value: JsonValue | undefined): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 4_096 || value.includes("\\") || value.startsWith("/")) throw new Error("Invalid repository path");
  const parts = value.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) throw new Error("Repository path escapes the workspace");
  return value;
}

function integer(value: JsonValue, min: number, max: number, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
  return value;
}

function shellQuote(value: string): string { return `'${value.replaceAll("'", `'"'"'`)}'`; }

/**
 * Renders the terminal the planning runner returns.
 *
 * Pure over the outcome, the immutable request, and any admitted capture, so
 * a reconnecting or retrying runner that reaches a settled run gets a
 * byte-identical plan, digest, and summary instead of a second plan.
 *
 * A completed run with no proposals produces no effect artifact. That is the
 * normal result of an inspect-only task, and fabricating an empty artifact
 * would start an apply job with nothing to apply.
 */
async function terminalFromOutcome(
  value: unknown,
  sequence: number,
  request: TaskRunRequestV1,
  capture?: TaskEffectPlanCaptureV1,
): Promise<RunnerTerminalV1> {
  const outcome = taskOutcomeV1Schema.parse(value);
  if (outcome.status !== "completed") {
    return {
      schemaVersion: "gardener.runner.terminal/v1",
      status: outcome.status === "cancelled" ? "cancelled" : "failed",
      summary: boundedSummary(outcome.status === "cancelled" ? outcome.reason : outcome.error.message),
      lastServerSequence: sequence,
      lastCompletedSequence: sequence,
    };
  }
  const settled = {
    schemaVersion: "gardener.runner.terminal/v1",
    status: "completed",
    summary: boundedSummary(outcome.summary),
    lastServerSequence: sequence,
    lastCompletedSequence: sequence,
  } as const;
  if (outcome.proposedEffects.length === 0) return settled;
  const plan = await buildTaskEffectPlan({ request, outcome, capture });
  const bytes = new TextEncoder().encode(canonicalJson(plan));
  return {
    ...settled,
    effectArtifact: {
      schemaVersion: "gardener.runner.effect-artifact/v1",
      sha256: await canonicalSha256Bytes(bytes),
      bytesBase64: bytesToBase64(bytes),
      ...(plan.changesSha256 === undefined ? {} : { changesSha256: plan.changesSha256 }),
    },
  };
}

async function canonicalSha256Bytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8_192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8_192));
  }
  return btoa(binary);
}

function boundedSummary(value: string): string {
  const bytes = new TextEncoder().encode(value);
  return bytes.byteLength <= 16 * 1_024 ? value : new TextDecoder().decode(bytes.slice(0, 16 * 1_024));
}

function captureOutputBudget(
  request: TaskRunRequestV1,
  proposals: readonly TaskEffectProposalV1[],
): number {
  // Reserve the exact UTF-8 size of already-known plan inputs plus a bounded
  // structural allowance for provenance/event fields. The action envelope is
  // larger than its embedded manifest, so bounding the entire envelope by the
  // remaining plan bytes is conservative and guarantees an accepted capture
  // cannot consume the whole transport before plan assembly.
  const knownBytes = new TextEncoder().encode(canonicalJson({
    runId: request.runId,
    taskId: request.bundle.taskId,
    bundleHash: request.bundleHash,
    repository: request.event.repository,
    proposals,
  })).byteLength;
  const remainingPlanBytes = EFFECT_TRANSPORT_MAX_BYTES - knownBytes - 64 * 1024;
  if (remainingPlanBytes < 1_024) {
    throw new Error("The proposed plan leaves no transport budget for a repository capture manifest");
  }
  return Math.min(EFFECT_TRANSPORT_MAX_BYTES, remainingPlanBytes);
}

function canonicalValue(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalValue(record[key])}`).join(",")}}`;
}
