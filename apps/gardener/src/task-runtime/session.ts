import { RpcTarget, newWorkersRpcResponse, type RpcStub } from "capnweb";
import { DurableObject } from "cloudflare:workers";
import {
  resumeCursorV1Schema,
  runnerActionResultV1Schema,
  runnerActionV1Schema,
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
import { taskEffectPlanV1Schema, taskOutcomeV1Schema, type TaskRunRequestV1 } from "@gardener/contracts";
import { canonicalJson, canonicalSha256 } from "@gardener/core";
import type { HarnessSubmission, HarnessToolInvocation } from "../harness";
import type { Env } from "../env";
import { createTaskHarnessRequest, translateHarnessOutcome } from "./harness-adapter";
import { FlueTaskHarness } from "./flue-harness";
import { verifyActionsOidc, type VerifiedActionsIdentity } from "./github-oidc";
import { loadEnabledTaskBundle } from "./task-bundles";

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
    await this.settleUnresolvedBeforeNewAction(invocation.runId);
    const sequence = await this.nextSequence();
    return this.invoke(toolAction(sequence, operationId, invocation));
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
    await this.ctx.storage.put<StoredAction>(key, { canonicalAction, state: "running", action });
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

  async recordEffect(input: RunnerEffectReceiptV1): Promise<RunnerEffectReceiptV1> {
    const identity = this.#identity;
    if (!identity || identity.hello.phase !== "effects") throw new Error("Effects receipt requires an authenticated effects session");
    const receipt = runnerEffectReceiptV1Schema.parse(input);
    const expectedPlanRunId = runnerSessionId({ ...identity.hello, phase: "plan" });
    if (receipt.planRunId !== expectedPlanRunId) throw new Error("Effect receipt is not bound to this workflow run");
    const row = await this.env.DB.prepare(
      "SELECT request_json,outcome_json,effect_receipt_json FROM actions_task_runs WHERE id=?",
    ).bind(receipt.planRunId).first<{ request_json: string; outcome_json: string | null; effect_receipt_json: string | null }>();
    if (!row?.outcome_json) throw new Error("Effect receipt has no completed planning outcome");
    const terminal = await terminalFromOutcome(JSON.parse(row.outcome_json), await this.completedSequence(), JSON.parse(row.request_json) as TaskRunRequestV1);
    if (terminal.effectArtifact?.sha256 !== receipt.artifactSha256) throw new Error("Effect receipt artifact binding mismatch");
    const outcome = taskOutcomeV1Schema.parse(JSON.parse(row.outcome_json));
    if (outcome.bundleHash !== receipt.bundleHash || outcome.status !== "completed" || outcome.proposedEffects[0]?.operationId !== receipt.operationId) {
      throw new Error("Effect receipt does not match the planned operation");
    }
    if (row.effect_receipt_json) {
      const existing = runnerEffectReceiptV1Schema.parse(JSON.parse(row.effect_receipt_json));
      if (canonicalJson(existing) !== canonicalJson(receipt)) throw new Error("Effect receipt conflict");
      return existing;
    }
    await this.env.DB.batch([
      this.env.DB.prepare("UPDATE actions_task_runs SET effect_receipt_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND effect_receipt_json IS NULL")
        .bind(JSON.stringify(receipt), receipt.planRunId),
      this.env.DB.prepare("INSERT INTO actions_task_audit (run_id,event,detail_json) VALUES (?,'effect.executed',?)")
        .bind(receipt.planRunId, JSON.stringify(receipt)),
    ]);
    return receipt;
  }

  async runTask(eventInput?: RunnerEventV1): Promise<RunnerTerminalV1> {
    const identity = this.#identity;
    if (!identity) throw new Error("Runner session is not authenticated");
    if (identity.hello.phase !== "plan" || identity.hello.eventName !== "issues") {
      throw new Error("The v1 task runtime supports only planning issues runs");
    }
    const runnerEvent = runnerEventV1Schema.parse(eventInput);
    const { bundle, bundleHash } = await loadEnabledTaskBundle(
      this.env.DB,
      identity.enrollment.repository_id,
      identity.hello.agentHash,
    );
    const admittedAt = new Date().toISOString();
    const request = {
      schemaVersion: "gardener.task-run-request/v1" as const,
      runId: identity.sessionId,
      bundle,
      bundleHash,
      policySnapshotHash: await canonicalSha256({ enrollment: identity.enrollment.repository_id, workflow: identity.enrollment.plan_job_workflow_ref }),
      event: {
        schemaVersion: "gardener.normalized-event/v1" as const,
        eventId: `github:${identity.hello.runId}:${identity.hello.runAttempt}`,
        kind: "github.issue.opened" as const,
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
        issue: runnerEvent.issue,
      },
      model: { id: this.env.AI_MODEL },
      admittedAt,
      deadlineAt: new Date(Date.parse(admittedAt) + bundle.limits.runtimeSeconds * 1_000).toISOString(),
    };
    const draftHarnessRequest = await createTaskHarnessRequest(request);
    const inspection = await this.invokeHarnessTool({
      runId: request.runId,
      requestId: draftHarnessRequest.requestId,
      toolCallId: "trusted-preflight-list-files",
      toolName: "repository_list_files",
      input: { maxEntries: 200 },
    });
    if (inspection.status !== "completed") throw new Error("Trusted repository preflight inspection failed");
    const harnessRequest = await createTaskHarnessRequest(request, JSON.parse(JSON.stringify({
      schemaVersion: "gardener.task-tool-result/v1",
      operationId: inspection.operationId,
      tool: "repository.list_files",
      status: inspection.status,
      exitCode: inspection.exitCode,
      stdout: inspection.stdout,
      stderr: inspection.stderr,
      outputTruncated: inspection.outputTruncated,
    })) as JsonValue);
    const existing = await this.env.DB.prepare(
      "SELECT status,request_json,harness_submission_json,outcome_json FROM actions_task_runs WHERE id=?",
    ).bind(identity.sessionId).first<{ status: string; request_json: string; harness_submission_json: string | null; outcome_json: string | null }>();
    if (existing?.outcome_json) {
      return terminalFromOutcome(JSON.parse(existing.outcome_json), await this.completedSequence(), JSON.parse(existing.request_json) as TaskRunRequestV1);
    }
    await this.env.DB.prepare(
      "INSERT OR IGNORE INTO actions_task_runs (id,repository_id,github_run_id,github_run_attempt,phase,bundle_hash,request_json,status) VALUES (?,?,?,?,?,?,?,'admitted')",
    ).bind(identity.sessionId, identity.enrollment.repository_id, identity.hello.runId, identity.hello.runAttempt, identity.hello.phase, bundleHash, JSON.stringify(request)).run();
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
    const harnessOutcome = await harness.read(submission);
    const terminalRow = await this.env.DB.prepare("SELECT outcome_json FROM actions_task_runs WHERE id=?")
      .bind(identity.sessionId).first<{ outcome_json: string | null }>();
    const outcome = terminalRow?.outcome_json
      ? taskOutcomeV1Schema.parse(JSON.parse(terminalRow.outcome_json))
      : translateHarnessOutcome(request, harnessOutcome);
    await this.env.DB.batch([
      this.env.DB.prepare(
        "UPDATE actions_task_runs SET status=?,outcome_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND outcome_json IS NULL",
      ).bind(outcome.status, JSON.stringify(outcome), identity.sessionId),
      this.env.DB.prepare(
        "INSERT INTO actions_task_audit (run_id,event,detail_json) " +
        "SELECT ?,'task.settled',? WHERE NOT EXISTS (SELECT 1 FROM actions_task_audit WHERE run_id=? AND event='task.settled')",
      ).bind(identity.sessionId, JSON.stringify({ status: outcome.status, bundleHash }), identity.sessionId),
    ]);
    return terminalFromOutcome(outcome, await this.completedSequence(), request);
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
  invoke(action: RunnerActionV1): Promise<RunnerActionResultV1> { return this.session.invoke(action); }
  reconcile(result: RunnerActionResultV1): Promise<RunnerActionResultV1> { return this.session.reconcile(result); }
  resume(cursor: ResumeCursorV1, runner: RpcStub<RunnerCapability>): Promise<ResumeStateV1> { return this.session.resume(cursor, runner); }
  recordEffect(receipt: RunnerEffectReceiptV1): Promise<RunnerEffectReceiptV1> { return this.session.recordEffect(receipt); }
}

function toolAction(sequence: number, operationId: string, invocation: HarnessToolInvocation): RunnerActionV1 {
  const input = invocation.input;
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new Error("Repository tool input must be an object");
  const value = input as Record<string, JsonValue>;
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
    const path = value.path === undefined ? "." : repositoryPath(value.path);
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

async function terminalFromOutcome(value: unknown, sequence: number, request: TaskRunRequestV1): Promise<RunnerTerminalV1> {
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
  if (outcome.proposedEffects.length !== 1 || outcome.proposedEffects[0]?.kind !== "issue.comment.create") {
    throw new Error("Issue triage must produce exactly one comment effect");
  }
  if (request.event.kind !== "github.issue.opened") throw new Error("Comment effect is not bound to an issue event");
  const proposed = outcome.proposedEffects[0];
  const plan = taskEffectPlanV1Schema.parse({
    schemaVersion: "gardener.task-effect-plan/v1",
    runId: outcome.runId,
    taskId: outcome.taskId,
    bundleHash: outcome.bundleHash,
    repository: { id: request.event.repository.id, fullName: request.event.repository.fullName },
    issueNumber: request.event.issue.number,
    operationId: proposed.operationId,
    kind: proposed.kind,
    body: proposed.body,
  });
  const bytes = new TextEncoder().encode(canonicalJson(plan));
  const sha256 = await canonicalSha256Bytes(bytes);
  return {
    schemaVersion: "gardener.runner.terminal/v1",
    status: "completed",
    summary: boundedSummary(outcome.summary),
    lastServerSequence: sequence,
    lastCompletedSequence: sequence,
    effectArtifact: {
      schemaVersion: "gardener.runner.effect-artifact/v1",
      sha256,
      bytesBase64: bytesToBase64(bytes),
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

function canonicalValue(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalValue(record[key])}`).join(",")}}`;
}
