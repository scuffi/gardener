import { AgentRunError, init, type AgentReply } from "@flue/runtime";
import { GardenerTaskFlueAgent } from "./flue-agent";
import { classifyTaskFailure } from "./task-limits";
import {
  HARNESS_ADAPTER_VERSIONS,
  assertHarnessRequest,
  assertHarnessSubmission,
  type AgentHarness,
  type HarnessCancelRequest,
  type HarnessCancelResult,
  type HarnessModelUsage,
  type HarnessOutcome,
  type HarnessReadOptions,
  type HarnessRequest,
  type HarnessSubmission,
  type JsonValue,
} from "../harness";
import { harnessError } from "../harness/validation";

/** Real Flue implementation of the canonical inspect-only task harness seam. */
export class FlueTaskHarness implements AgentHarness {
  readonly descriptor = {
    id: "flue" as const,
    adapterVersion: HARNESS_ADAPTER_VERSIONS.flue,
    capabilities: ["reasoning", "structured-outcome", "workspace-tools", "tool-events", "model-usage", "cancellation"] as const,
    preview: false,
  };

  async start(request: HarnessRequest): Promise<HarnessSubmission> {
    assertHarnessRequest(request, { id: "flue", adapterVersion: HARNESS_ADAPTER_VERSIONS.flue });
    const receipt = await init(GardenerTaskFlueAgent, { id: request.runId }).dispatch({
      message: {
        kind: "signal",
        type: "gardener.task.admitted",
        body: "Execute the immutable canonical task request supplied as trusted initial data.",
        attributes: { runId: request.runId, requestId: request.requestId },
      },
      initialData: { request },
      idempotencyKey: request.requestId,
    });
    return {
      schemaVersion: "gardener.harness.submission/v1",
      harness: request.snapshot.harness,
      runId: request.runId,
      requestId: request.requestId,
      submissionId: receipt.submissionId,
      acceptedAt: receipt.acceptedAt,
    };
  }

  async submit(): Promise<HarnessSubmission> {
    throw new Error("Canonical task v1 permits one Flue submission per run");
  }

  async read(submission: HarnessSubmission, options?: HarnessReadOptions): Promise<HarnessOutcome> {
    assertHarnessSubmission(submission, { id: "flue", adapterVersion: HARNESS_ADAPTER_VERSIONS.flue });
    const handle = init(GardenerTaskFlueAgent, { id: submission.runId });
    let reply: AgentReply;
    try {
      reply = await handle.read(
        submission.submissionId,
        options?.signal ? { signal: options.signal } : undefined,
      );
    } catch (error) {
      // A reconnect superseded this wait; the submission is still running and a
      // newer runTask is waiting on it, so only this observation stops.
      if (options?.signal?.aborted && options.signal.reason instanceof SupersededReadError) throw options.signal.reason;
      if (isSignalAbort(error, options?.signal)) {
        await handle.abort().catch(() => undefined);
        return {
          schemaVersion: "gardener.harness.outcome/v1",
          harness: submission.harness,
          runId: submission.runId,
          requestId: submission.requestId,
          submissionId: submission.submissionId,
          status: "failed",
          error: harnessError("budget-exceeded", "Task execution exceeded its runtime deadline", false),
          usage: emptyUsage(),
          events: [],
        };
      }
      if (!(error instanceof AgentRunError)) {
        // The agent did not settle: waiting on it failed, for example a failed
        // long-poll. That says nothing about the task, so it must not become a
        // failed run. Propagate so the runner reconnects and resumes the wait
        // from a fresh request, which is how the D1 "subrequest depth" failures
        // seen mid-run recover.
        console.error("Gardener task Flue read interrupted", describeReadFailure(error));
        throw new Error("Waiting for the task agent was interrupted; reconnect to resume", { cause: error });
      }
      console.error("Gardener task Flue read failed", describeReadFailure(error));
      const cancelled = error instanceof AgentRunError && error.outcome === "aborted";
      const knownFailure = cancelled ? null : classifyTaskFailure(error.cause);
      return {
        schemaVersion: "gardener.harness.outcome/v1",
        harness: submission.harness,
        runId: submission.runId,
        requestId: submission.requestId,
        submissionId: submission.submissionId,
        status: cancelled ? "cancelled" : "failed",
        error: harnessError(
          cancelled ? "cancelled" : knownFailure?.code ?? "provider-error",
          cancelled ? "Task execution was cancelled" : knownFailure?.message ?? "Flue task execution failed",
          false,
        ),
        usage: emptyUsage(),
        events: [],
      };
    }
    // Parsed outside the try, so a settled reply can never be mistaken for an
    // interrupted wait.
    const result = oneTaskOutcome(reply);
    return {
      schemaVersion: "gardener.harness.outcome/v1",
      harness: submission.harness,
      runId: submission.runId,
      requestId: submission.requestId,
      submissionId: submission.submissionId,
      status: "completed",
      result: {
        kind: "result",
        summary: taskResultSummary(result),
        data: result,
      },
      usage: replyUsage(reply),
      events: [],
    };
  }

  async cancel(request: HarnessCancelRequest): Promise<HarnessCancelResult> {
    await init(GardenerTaskFlueAgent, { id: request.runId }).abort();
    return { runId: request.runId, cancelled: true };
  }
}

function oneTaskOutcome(reply: AgentReply): JsonValue {
  const values = reply.data.taskOutcome;
  if (!Array.isArray(values) || values.length !== 1) return {};
  return JSON.parse(JSON.stringify(values[0])) as JsonValue;
}

function taskResultSummary(result: JsonValue): string {
  if (result !== null && typeof result === "object" && !Array.isArray(result) && typeof result.summary === "string") {
    return result.summary;
  }
  return "Task completed";
}

function replyUsage(reply: AgentReply): HarnessModelUsage {
  const value = reply.metadata?.gardenerTaskUsage;
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
    model: typeof usage.model === "string" ? usage.model : "unknown",
  };
}

/**
 * The abort reason the session gives an older wait when a reconnect starts a
 * new one. Flue's read signal cancels only the observation, never the
 * submission, so a superseded wait ends without touching the run.
 */
export class SupersededReadError extends Error {
  constructor() {
    super("A reconnect superseded this wait for the task agent");
    this.name = "SupersededReadError";
  }
}

function isSignalAbort(error: unknown, signal: AbortSignal | undefined): boolean {
  if (!signal?.aborted) return false;
  if (error === signal.reason) return true;
  return error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError");
}

function emptyUsage(): HarnessModelUsage {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0, model: "unknown", turns: 0, toolCalls: 0 };
}

/**
 * A bounded, structured description of a failed read: each error's name and
 * truncated message along the cause chain. Used to see why a failure was not
 * mapped to a specific limit message.
 */
function describeReadFailure(error: unknown): { outcome?: string; chain: { name: string; message: string }[] } {
  const chain: { name: string; message: string }[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth += 1) {
    if (current instanceof Error) {
      chain.push({ name: current.name, message: current.message.slice(0, 300) });
      current = current.cause;
    } else if (typeof current === "object") {
      // Flue's serialized settlement error: { name, message, type, meta }.
      const serialized = current as { name?: unknown; message?: unknown; type?: unknown; meta?: { reason?: unknown } };
      chain.push({
        name: [serialized.name, serialized.type].filter((part) => typeof part === "string").join("/") || "object",
        message: [
          serialized.message,
          // OperationFailedError already embeds its reason in the message.
          typeof serialized.message === "string" && typeof serialized.meta?.reason === "string"
            && serialized.message.includes(serialized.meta.reason) ? undefined : serialized.meta?.reason,
        ]
          .filter((part): part is string => typeof part === "string")
          .join(" | ")
          .slice(0, 300),
      });
      break;
    } else {
      chain.push({ name: typeof current, message: String(current).slice(0, 300) });
      break;
    }
  }
  return {
    ...(error instanceof AgentRunError ? { outcome: String(error.outcome) } : {}),
    chain,
  };
}
