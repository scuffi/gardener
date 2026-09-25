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
