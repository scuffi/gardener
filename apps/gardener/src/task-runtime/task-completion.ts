import { canonicalJson, canonicalSha256 } from "@gardener/core";
import { taskOutcomeV1Schema, type TaskOutcomeV1 } from "@gardener/contracts";
import type { HarnessModelUsage, HarnessOutcome, HarnessSubmission, JsonValue } from "../harness";
import { harnessError } from "../harness/validation";
import { classifyTaskFailure } from "./task-limits";

/**
 * How a run's result reaches its session without the session calling the
 * agent.
 *
 * A Durable Object charges every outgoing subrequest to its newest incoming
 * request (workerd's `IoContext::getCurrentIncomingRequest()`). A session that
 * polls the agent while the agent calls it for tools therefore ratchets the
 * request depth on every round trip, until Cloudflare refuses the next call.
 * So while a run is in progress, calls go one way: the agent pushes its
 * result and its settlement, and the session only waits. This module is the
 * session's side: first-wins records in its storage, and the outcome they
 * translate to.
 */

const CANDIDATE_PREFIX = "task-candidate:";
const RESULT_KEY = "task-result";
const SETTLEMENT_KEY = "task-settlement";
const REFUSAL_KEY = "task-completion-refusal";
const GENERIC_FAILURE = "Flue task execution failed";
const REFUSAL_MAX_LENGTH = 300;
const MISSING_FINISH = "The model stopped without calling finish_task";
/** The submission this session dispatched, so pushes for any other are refused. */
export const SUBMISSION_KEY = "task-submission";

export interface CompletionStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  list<T>(options: { prefix: string; limit?: number }): Promise<Map<string, T>>;
}

export interface TaskSubmissionRecord {
  runId: string;
  requestId: string;
  /** Absent between writing the request and Flue accepting the dispatch. */
  submissionId?: string;
}

/** `finish_task`'s validated outcome, recorded as its last step. */
export interface TaskCandidateInvocationV1 {
  runId: string;
  requestId: string;
  toolCallId: string;
  outcome: unknown;
}

/** Sent by the agent's finish hook once its checks pass: the run completed with its one candidate. */
export interface TaskResultConfirmationV1 {
  runId: string;
  requestId: string;
  usage: unknown;
}

/** Flue's `submission_settled`, pushed by the agent for every outcome. */
export interface TaskSettlementNoticeV1 {
  runId: string;
  submissionId: string;
  outcome: "completed" | "failed" | "aborted";
  error?: string;
}

interface StoredCandidate {
  toolCallId: string;
  outcome: TaskOutcomeV1;
  canonical: string;
}

interface StoredResult {
  toolCallId: string;
  outcome: TaskOutcomeV1;
  usage: HarnessModelUsage;
}

interface StoredSettlement {
  submissionId: string;
  outcome: TaskSettlementNoticeV1["outcome"];
  error: string | null;
}

export type TaskCompletion =
  | { kind: "result"; outcome: TaskOutcomeV1; usage: HarnessModelUsage }
  | { kind: "settlement"; outcome: TaskSettlementNoticeV1["outcome"]; error: string | null };

/** Every id is then compared with the session's own record, which is the real check. */
function requireId(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 256) {
    throw new Error(`Task completion ${label} is malformed`);
  }
  return value;
}

/**
 * The session's own record of what it dispatched. It is read from storage, not
 * from the runner's connection, because the agent may push while no runner is
 * connected and the session has been evicted.
 */
async function requireSubmission(storage: CompletionStorage, runId: unknown): Promise<TaskSubmissionRecord> {
  const submission = await storage.get<TaskSubmissionRecord>(SUBMISSION_KEY);
  if (!submission) throw new Error("Task completion arrived before this run's submission");
  if (requireId(runId, "run id") !== submission.runId) {
    throw new Error("Task completion is not bound to this runner session");
  }
  return submission;
}

/**
 * Records `finish_task`'s outcome, keyed by its content. A replay of the same
 * outcome, even under a new tool call id after a durability retry, is a
 * duplicate. A different outcome is kept separately, and confirmation then
 * refuses to choose between them, so nothing replaces the outcome the plan
 * will be built from.
 */
export async function recordTaskCandidate(
  storage: CompletionStorage,
  input: TaskCandidateInvocationV1,
): Promise<{ duplicate: boolean }> {
  const submission = await requireSubmission(storage, input.runId);
  if (requireId(input.requestId, "request id") !== submission.requestId) {
    throw new Error("Task candidate does not belong to this run's submission");
  }
  // Diagnostic only: model providers format tool call ids differently, so it
  // is bounded but not otherwise constrained, and nothing is keyed by it.
  if (typeof input.toolCallId !== "string" || input.toolCallId.length < 1 || input.toolCallId.length > 1_024) {
    throw new Error("Task completion tool call id is malformed");
  }
  const toolCallId = input.toolCallId.slice(0, 256);
  const outcome = taskOutcomeV1Schema.parse(input.outcome);
  if (outcome.runId !== input.runId || outcome.status !== "completed") {
    throw new Error("Task candidate must be this run's completed outcome");
  }
  const canonical = canonicalJson(outcome);
  const key = `${CANDIDATE_PREFIX}${await canonicalSha256(outcome)}`;
  const existing = await storage.get<StoredCandidate>(key);
  if (existing) {
    // Defends against a hash collision, however unlikely.
    if (existing.canonical !== canonical) throw new Error("Task candidate conflicts with the one already recorded");
    return { duplicate: true };
  }
  await storage.put<StoredCandidate>(key, { toolCallId, outcome, canonical });
  return { duplicate: false };
}

/**
 * Completes the run with its one candidate. The finish hook has already
 * refused any response without exactly one successful `finish_task`, so more
 * than one candidate means something replayed differently, and neither is
 * trusted.
 */
export async function confirmTaskResult(
  storage: CompletionStorage,
  input: TaskResultConfirmationV1,
): Promise<{ duplicate: boolean }> {
  const submission = await requireSubmission(storage, input.runId);
  if (requireId(input.requestId, "request id") !== submission.requestId) {
    throw new Error("Task result does not belong to this run's submission");
  }
  if (await storage.get<StoredResult>(RESULT_KEY)) return { duplicate: true };
  const candidates = [...(await storage.list<StoredCandidate>({ prefix: CANDIDATE_PREFIX, limit: 2 })).values()];
  if (candidates.length !== 1) {
    throw new Error(candidates.length === 0
      ? "Task result needs a finish_task outcome, found none"
      : "Task result found more than one distinct finish_task outcome");
  }
  const [candidate] = candidates as [StoredCandidate];
  await storage.put<StoredResult>(RESULT_KEY, {
    toolCallId: candidate.toolCallId,
    outcome: candidate.outcome,
    usage: normalizedUsage(input.usage),
  });
  return { duplicate: false };
}

/** Records the agent's settlement. First wins, and only for the submission this session dispatched. */
export async function recordTaskSettlement(
  storage: CompletionStorage,
  input: TaskSettlementNoticeV1,
): Promise<{ duplicate: boolean }> {
  const submission = await requireSubmission(storage, input.runId);
  if (!submission.submissionId || requireId(input.submissionId, "submission id") !== submission.submissionId) {
    throw new Error("Task settlement does not belong to this run's submission");
  }
  if (input.outcome !== "completed" && input.outcome !== "failed" && input.outcome !== "aborted") {
    throw new Error("Task settlement outcome is malformed");
  }
  if (await storage.get<StoredSettlement>(SETTLEMENT_KEY)) return { duplicate: true };
  await storage.put<StoredSettlement>(SETTLEMENT_KEY, {
    submissionId: input.submissionId,
    outcome: input.outcome,
    error: input.outcome === "failed"
      ? (typeof input.error === "string" && input.error ? input.error.slice(0, 2_000) : GENERIC_FAILURE)
      : null,
  });
  return { duplicate: false };
}

/** A confirmed result wins over a settlement: it is the only completed path. */
export async function readTaskCompletion(storage: CompletionStorage): Promise<TaskCompletion | null> {
  const result = await storage.get<StoredResult>(RESULT_KEY);
  if (result) return { kind: "result", outcome: result.outcome, usage: result.usage };
  const settlement = await storage.get<StoredSettlement>(SETTLEMENT_KEY);
  if (settlement) return { kind: "settlement", outcome: settlement.outcome, error: settlement.error };
  return null;
}

/**
 * Remembers why the session refused the model's reported result. The finish
 * hook then refuses the run, and Flue reports that only as an internal error,
 * so without this the cause never leaves the Worker logs. First wins.
 */
export async function recordCompletionRefusal(storage: CompletionStorage, error: unknown): Promise<void> {
  if (await storage.get<string>(REFUSAL_KEY)) return;
  await storage.put<string>(REFUSAL_KEY, refusalText(error));
}

/**
 * A failed outcome that only says the task failed, rewritten to the recorded
 * refusal when there is one. Specific failures (limits, provider errors,
 * cancellation) are left as they are.
 */
export async function explainRefusedCompletion(storage: CompletionStorage, outcome: HarnessOutcome): Promise<HarnessOutcome> {
  // A recorded refusal means the model did report a result, so it also beats
  // the finish hook's "stopped without calling finish_task".
  if (outcome.status !== "failed") return outcome;
  const message = outcome.error.message;
  if (message !== GENERIC_FAILURE && !message.startsWith(MISSING_FINISH)) return outcome;
  const refusal = await storage.get<string>(REFUSAL_KEY);
  if (!refusal) return outcome;
  const recorded = `The model reported a result, but Gardener could not record it: ${refusal}`;
  // The two can both be true: an early refused result does not mean the model
  // didn't later run out of output, so keep the missing-finish advice too.
  const explained = message === GENERIC_FAILURE ? recorded : `${recorded}. ${message}`;
  return { ...outcome, error: harnessError("invalid-outcome", explained.slice(0, 2_000), false) };
}

/**
 * The operator-visible text for a refusal. Only the completion paths' own
 * fixed messages leave the Worker (they name no model output, repository
 * content or ids); anything else stays in the Worker logs.
 */
function refusalText(error: unknown): string {
  // A schema failure names the first field only; the full issue list can be
  // long and quote the model's input. Detected by shape, so a wrapped or
  // re-thrown issue list is caught too.
  const issues = error !== null && typeof error === "object" ? (error as { issues?: unknown }).issues : undefined;
  if (Array.isArray(issues)) {
    const issue = issues[0] as { path?: unknown[]; message?: unknown } | undefined;
    const field = Array.isArray(issue?.path) ? issue.path.join(".") : "";
    const detail = typeof issue?.message === "string" ? ` (${field || "outcome"}: ${issue.message})` : "";
    return `the result is not a valid task outcome${detail}`.slice(0, REFUSAL_MAX_LENGTH);
  }
  const message = error instanceof Error ? error.message.replace(/\s+/g, " ").trim() : "";
  if (/^Task (completion|candidate|result) /.test(message)) return message.slice(0, REFUSAL_MAX_LENGTH);
  return "an unexpected error (details are in the Worker logs)";
}

/** The outcome the session's existing settle path takes, as a read of the agent used to produce it. */
export function completionHarnessOutcome(submission: HarnessSubmission, completion: TaskCompletion): HarnessOutcome {
  const base = {
    schemaVersion: "gardener.harness.outcome/v1" as const,
    harness: submission.harness,
    runId: submission.runId,
    requestId: submission.requestId,
    submissionId: submission.submissionId,
    events: [],
  };
  if (completion.kind === "result") {
    return {
      ...base,
      status: "completed",
      result: {
        kind: "result",
        summary: (completion.outcome.status === "completed" && completion.outcome.summary) || "Task completed",
        data: JSON.parse(JSON.stringify(completion.outcome)) as JsonValue,
      },
      usage: completion.usage,
    };
  }
  if (completion.outcome === "aborted") {
    return { ...base, status: "cancelled", error: harnessError("cancelled", "Task execution was cancelled", false), usage: emptyUsage() };
  }
  if (completion.outcome === "completed") {
    // The finish hook confirms a result before Flue can settle as completed,
    // so a completed settlement without one cannot be trusted.
    return {
      ...base,
      status: "failed",
      error: harnessError("invalid-outcome", "The task agent completed without a confirmed finish_task result", false),
      usage: emptyUsage(),
    };
  }
  const known = classifyTaskFailure(completion.error ?? "");
  return {
    ...base,
    status: "failed",
    error: harnessError(known?.code ?? "provider-error", known?.message ?? GENERIC_FAILURE, false),
    usage: emptyUsage(),
  };
}

export function emptyUsage(): HarnessModelUsage {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0, model: "unknown", turns: 0, toolCalls: 0 };
}

function normalizedUsage(value: unknown): HarnessModelUsage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return emptyUsage();
  const usage = value as Record<string, unknown>;
  const integer = (name: string): number => {
    const candidate = usage[name];
    return typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 0 ? candidate : 0;
  };
  return {
    inputTokens: integer("inputTokens"),
    outputTokens: integer("outputTokens"),
    totalTokens: integer("totalTokens"),
    turns: integer("turns"),
    toolCalls: integer("toolCalls"),
    model: typeof usage.model === "string" ? usage.model.slice(0, 256) : "unknown",
  };
}

/**
 * Wakes a waiting `runTask` when a completion is recorded. A wait must be
 * armed before storage is read, and a writer must persist before notifying,
 * so a completion recorded between the two is never missed.
 */
export class CompletionSignal {
  readonly #waiters = new Set<() => void>();

  /** Arms a wait. Call before reading storage; `cancel` it if the read finds a completion. */
  arm(): { promise: Promise<void>; cancel(): void } {
    let wake!: () => void;
    const promise = new Promise<void>((resolve) => {
      wake = resolve;
    });
    this.#waiters.add(wake);
    return { promise, cancel: () => this.#waiters.delete(wake) };
  }

  notify(): void {
    const waiters = [...this.#waiters];
    this.#waiters.clear();
    for (const wake of waiters) wake();
  }

  get size(): number {
    return this.#waiters.size;
  }
}

/** The agent's one-way completion channel to its session. */
export interface TaskCompletionFacade {
  recordTaskCandidate(invocation: TaskCandidateInvocationV1): Promise<{ duplicate: boolean }>;
  confirmTaskResult(confirmation: TaskResultConfirmationV1): Promise<{ duplicate: boolean }>;
  recordTaskSettlement(notice: TaskSettlementNoticeV1): Promise<{ duplicate: boolean }>;
}

/** Resolves when woken or after `ms`, and rejects with the signal's reason if it aborts first. */
export function untilWokenOrTimeout(woken: Promise<void>, ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const finish = (settle: () => void) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      settle();
    };
    const onAbort = () => finish(() => reject(signal.reason));
    const timer = setTimeout(() => finish(resolve), ms);
    signal.addEventListener("abort", onAbort, { once: true });
    void woken.then(() => finish(resolve));
  });
}
