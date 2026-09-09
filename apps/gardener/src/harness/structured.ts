import type {
  HarnessActivityEvent,
  HarnessInterruptionRequest,
  HarnessModelUsage,
  HarnessOutcome,
  HarnessResult,
  HarnessSubmission,
  JsonValue,
} from "./types";
import { assertJsonValue, harnessError } from "./validation";

export type HarnessDecision =
  | { status: "completed"; result: HarnessResult }
  | { status: "interrupted"; interruption: HarnessInterruptionRequest };

export function parseHarnessDecision(value: unknown): HarnessDecision {
  const decision = asRecord(value, "decision");
  if (decision.status === "completed") {
    const result = asRecord(decision.result, "decision.result");
    if (result.kind !== "result" && result.kind !== "abstain") throw new Error("Invalid result kind");
    if (typeof result.summary !== "string" || result.summary.length === 0 || result.summary.length > 32_000) {
      throw new Error("Invalid result summary");
    }
    if (result.data !== undefined) assertJsonValue(result.data, "decision.result.data");
    return {
      status: "completed",
      result: {
        kind: result.kind,
        summary: result.summary,
        ...(result.data === undefined ? {} : { data: result.data as JsonValue }),
      },
    };
  }
  if (decision.status === "interrupted") {
    const interruption = asRecord(decision.interruption, "decision.interruption");
    if (interruption.kind !== "capability" && interruption.kind !== "human-input") {
      throw new Error("Invalid interruption kind");
    }
    if (typeof interruption.reason !== "string" || interruption.reason.length === 0 || interruption.reason.length > 8_000) {
      throw new Error("Invalid interruption reason");
    }
    if (interruption.scope !== undefined) assertJsonValue(interruption.scope, "decision.interruption.scope");
    return {
      status: "interrupted",
      interruption: {
        kind: interruption.kind,
        reason: interruption.reason,
        ...(typeof interruption.capability === "string" ? { capability: interruption.capability } : {}),
        ...(interruption.scope === undefined ? {} : { scope: interruption.scope as JsonValue }),
        ...(typeof interruption.question === "string" ? { question: interruption.question } : {}),
      },
    };
  }
  throw new Error("Harness decision must be completed or interrupted");
}

export function outcomeFromDecision(
  decision: HarnessDecision,
  submission: HarnessSubmission,
  usage: HarnessModelUsage,
  events: readonly HarnessActivityEvent[],
): HarnessOutcome {
  const base = {
    schemaVersion: "gardener.harness.outcome/v1" as const,
    harness: submission.harness,
    runId: submission.runId,
    requestId: submission.requestId,
    submissionId: submission.submissionId,
    usage,
    events,
  };
  return decision.status === "completed"
    ? { ...base, status: "completed", result: decision.result }
    : { ...base, status: "interrupted", interruption: decision.interruption };
}

export function unsupportedResponseOutcome(
  submission: HarnessSubmission,
  usage: HarnessModelUsage,
  events: readonly HarnessActivityEvent[],
  message: string,
): HarnessOutcome {
  return {
    schemaVersion: "gardener.harness.outcome/v1",
    harness: submission.harness,
    runId: submission.runId,
    requestId: submission.requestId,
    submissionId: submission.submissionId,
    status: "failed",
    usage,
    events,
    error: harnessError("unsupported-model-response", message),
  };
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
