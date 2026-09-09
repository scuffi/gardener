import type {
  ExecutionBackend,
  SyncSummary,
  WorkspaceExecutionResult,
  WorkspaceRuntimeValue,
} from "./types";

export interface ComputerRuntimeResultLike {
  status: "completed" | "failed" | "cancelled";
  exitCode: number;
  stdout: string | Uint8Array;
  stderr: string | Uint8Array;
  value?: WorkspaceRuntimeValue;
  sync?:
    | { status: "complete"; applied: number; skipped: readonly unknown[] }
    | { status: "pending"; applied: number; skipped: readonly unknown[]; error: string };
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function asText(value: string | Uint8Array): string {
  return typeof value === "string" ? value : decoder.decode(value);
}

export function truncateUtf8(value: string, maxBytes: number): { value: string; bytes: number; truncated: boolean } {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new Error("Invalid byte limit");
  }
  const bytes = encoder.encode(value);
  if (bytes.byteLength <= maxBytes) {
    return { value, bytes: bytes.byteLength, truncated: false };
  }
  let end = maxBytes;
  let truncated = "";
  const fatalDecoder = new TextDecoder("utf-8", { fatal: true });
  while (end > 0) {
    try {
      truncated = fatalDecoder.decode(bytes.slice(0, end));
      break;
    } catch {
      end -= 1;
    }
  }
  return { value: truncated, bytes: end, truncated: true };
}

function summarizeSync(sync: ComputerRuntimeResultLike["sync"]): SyncSummary {
  if (!sync) return { status: "not-applicable" };
  if (sync.status === "pending") {
    return {
      status: "pending",
      applied: sync.applied,
      skipped: sync.skipped.length,
      error: sync.error,
    };
  }
  return { status: "complete", applied: sync.applied, skipped: sync.skipped.length };
}

export function classifyExecutionResult(options: {
  executionId: string;
  backend: ExecutionBackend;
  result: ComputerRuntimeResultLike;
  maxOutputBytes: number;
}): WorkspaceExecutionResult {
  const stdout = truncateUtf8(asText(options.result.stdout), options.maxOutputBytes);
  const stderrBudget = Math.max(0, options.maxOutputBytes - stdout.bytes);
  const stderr = truncateUtf8(asText(options.result.stderr), stderrBudget);
  const sync = summarizeSync(options.result.sync);
  const outcome =
    sync.status === "pending"
      ? "sync-pending"
      : sync.status === "complete" && sync.skipped > 0
        ? "failed"
        : options.result.status === "completed"
          ? options.result.exitCode === 0
            ? "completed"
            : "failed"
          : options.result.status;

  let value = options.result.value;
  let valueBytes = 0;
  let valueTruncated = false;
  if (value !== undefined) {
    valueBytes = encoder.encode(JSON.stringify(value)).byteLength;
    if (valueBytes > options.maxOutputBytes - stdout.bytes - stderr.bytes) {
      value = undefined;
      valueBytes = 0;
      valueTruncated = true;
    }
  }

  const result: WorkspaceExecutionResult = {
    executionId: options.executionId,
    backend: options.backend,
    outcome,
    exitCode: options.result.exitCode,
    stdout: stdout.value,
    stderr: stderr.value,
    outputBytes: stdout.bytes + stderr.bytes + valueBytes,
    outputTruncated: stdout.truncated || stderr.truncated || valueTruncated,
    sync,
    replayDisposition: "return-recorded",
  };
  if (value !== undefined) result.value = value;
  return result;
}

export function ambiguousExecutionResult(options: {
  executionId: string;
  backend: ExecutionBackend;
  error: unknown;
}): WorkspaceExecutionResult {
  const rawMessage = options.error instanceof Error ? options.error.message : "Execution result was not durably observed";
  const message = truncateUtf8(rawMessage, 1024).value;
  return {
    executionId: options.executionId,
    backend: options.backend,
    outcome: "ambiguous",
    exitCode: null,
    stdout: "",
    stderr: "",
    outputBytes: 0,
    outputTruncated: false,
    sync: { status: "not-applicable" },
    replayDisposition: "deny-automatic-replay",
    error: message,
  };
}

export function boundTextResult(
  stdoutValue: string,
  stderrValue: string,
  maxOutputBytes: number,
): Pick<WorkspaceExecutionResult, "stdout" | "stderr" | "outputBytes" | "outputTruncated"> {
  const stdout = truncateUtf8(stdoutValue, maxOutputBytes);
  const stderr = truncateUtf8(stderrValue, Math.max(0, maxOutputBytes - stdout.bytes));
  return {
    stdout: stdout.value,
    stderr: stderr.value,
    outputBytes: stdout.bytes + stderr.bytes,
    outputTruncated: stdout.truncated || stderr.truncated,
  };
}
