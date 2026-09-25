export function assertRunnerToolBudget(maxToolCalls: number, completedOrPendingActions: number): void {
  if (!Number.isSafeInteger(maxToolCalls) || maxToolCalls < 1) {
    throw new Error("Task tool-call limit is invalid");
  }
  if (!Number.isSafeInteger(completedOrPendingActions) || completedOrPendingActions < 0) {
    throw new Error("Task runner action count is invalid");
  }
  // One declared tool call is reserved for the terminal `finish_task` tool,
  // which executes inside Flue and never reaches the runner action journal.
  const runnerToolLimit = Math.max(0, maxToolCalls - 1);
  if (completedOrPendingActions >= runnerToolLimit) {
    throw new Error("Task runner tool-call budget is exhausted");
  }
}

export function remainingTaskRuntime(deadlineAt: string, now = Date.now()): number {
  const deadline = Date.parse(deadlineAt);
  if (!Number.isFinite(deadline)) throw new Error("Task runtime deadline is invalid");
  return deadline - now;
}

export function boundedTaskLimitFailure(cause: unknown): { code: "budget-exceeded"; message: string } | null {
  const detail = errorChain(cause);
  if (detail.includes("Gardener native profile permits at most")) {
    return { code: "budget-exceeded", message: "Task model-turn limit was exceeded" };
  }
  if (detail.includes("Flue model input exceeds its immutable")) {
    return { code: "budget-exceeded", message: "Task model-input limit was exceeded" };
  }
  if (detail.includes("Gardener model output-token budget is exhausted")) {
    return { code: "budget-exceeded", message: "Task model-output limit was exceeded" };
  }
  if (detail.includes("Gardener model runtime budget expired")) {
    return { code: "budget-exceeded", message: "Task model-runtime limit was exceeded" };
  }
  return null;
}

/**
 * Explains a failed agent run in one fixed sentence for the Actions log and
 * the audit row. Only these fixed strings are ever returned, plus an HTTP
 * status number, so provider response bodies, prompts and repository content
 * never leave the Worker. Unrecognised failures return null and keep the
 * generic message.
 */
export function classifyTaskFailure(cause: unknown): { code: "budget-exceeded" | "invalid-outcome" | "provider-error"; message: string } | null {
  const limit = boundedTaskLimitFailure(cause);
  if (limit) return limit;
  const detail = errorChain(cause);
  if (detail.includes("task_completed_without_terminal_outcome")) {
    return {
      code: "invalid-outcome",
      message: "The model stopped without calling finish_task. It may have run out of output tokens; consider raising output-tokens",
    };
  }
  if (detail.includes("task_has_multiple_terminal_outcomes")) {
    return { code: "invalid-outcome", message: "The model called finish_task more than once" };
  }
  if (detail.includes("task_tool_budget_exceeded")) {
    return { code: "budget-exceeded", message: "Task tool-call limit was exceeded" };
  }
  if (detail.includes("task_model_token_budget_exceeded")) {
    return { code: "budget-exceeded", message: "Task model-output limit was exceeded" };
  }
  const status = providerHttpStatus(detail);
  if (status !== null) return { code: "provider-error", message: providerFailureMessage(status) };
  return null;
}

/** The HTTP status of a failed model-provider request, if the failure reports one. */
function providerHttpStatus(detail: string): number | null {
  const match = /AI binding request failed with (\d{3})\b/.exec(detail) ?? /"httpCode":\s*(\d{3})\b/.exec(detail);
  if (!match) return null;
  const status = Number(match[1]);
  return status >= 400 && status <= 599 ? status : null;
}

function providerFailureMessage(status: number): string {
  if (status === 401 || status === 403) {
    return `The model provider rejected the request (HTTP ${status}). Check the provider keys on the account's default AI Gateway`;
  }
  if (status === 402) {
    return "AI Gateway refused the request for insufficient balance (HTTP 402). Add a provider key or credit to the account's default AI Gateway";
  }
  if (status === 404) return "The model provider did not find the model (HTTP 404). Check the task's model setting";
  if (status === 408 || status === 504) return `The model provider timed out (HTTP ${status})`;
  if (status === 429) return "The model provider rate-limited the request (HTTP 429)";
  if (status >= 500) return `The model provider failed (HTTP ${status})`;
  return `The model provider rejected the request (HTTP ${status})`;
}

function errorChain(value: unknown, depth = 0): string {
  if (depth > 3) return "";
  if (value instanceof Error) return `${value.message}\n${errorChain(value.cause, depth + 1)}`;
  if (typeof value === "string") return value;
  // Flue delivers a failed submission's cause as a serialized error object
  // ({ name, message, type, meta }), not an Error, once it crosses the agent's
  // Durable Object boundary.
  if (value !== null && typeof value === "object") {
    const { message, meta } = value as { message?: unknown; meta?: { reason?: unknown } };
    return [message, meta?.reason].filter((part): part is string => typeof part === "string").join("\n");
  }
  return "";
}
