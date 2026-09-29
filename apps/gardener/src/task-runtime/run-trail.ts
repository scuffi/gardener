/**
 * A run's trail: what the model did, so a run that stalls or runs out of
 * turns can be explained. Each tool call is recorded with a short target for
 * operators (`runs view`); only counts reach the public Actions log.
 */

const MAX_TARGET = 120;

/** Per-tool call counts, keyed by the task tool name (`repository.read_file`). */
export type ToolCallCounts = Record<string, number>;

/**
 * A short description of what a tool call reached: the file or directory
 * path, or the provider route. A command's text is never recorded.
 */
export function toolTarget(harnessToolName: string, input: unknown): string {
  const value = input !== null && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const text = (candidate: unknown, fallback: string) => typeof candidate === "string" && candidate.length > 0 ? candidate : fallback;
  let target: string;
  if (harnessToolName === "repository_read_file") target = text(value.path, "?");
  else if (harnessToolName === "repository_list_files") target = text(value.path, ".");
  else if (harnessToolName === "repository_exec") target = "command";
  else if (harnessToolName === "provider_api_read") {
    target = value.transport === "graphql"
      ? `graphql ${text(value.operationName, "query")}`
      : `${text(value.method, "GET")} ${text(value.path, "?")}`;
  } else target = "?";
  return target.length <= MAX_TARGET ? target : `${target.slice(0, MAX_TARGET - 1)}…`;
}

/** Counts one more call to `tool`. */
export function countToolCall(counts: ToolCallCounts | undefined, tool: string): ToolCallCounts {
  return { ...counts, [tool]: (counts?.[tool] ?? 0) + 1 };
}

/**
 * One line for a failed run's Actions error, for example
 * "16 tool calls: 9 repository.read_file, 7 provider.api.read; no effects proposed".
 */
export function trailDigest(counts: ToolCallCounts | undefined, proposals: number): string {
  const entries = Object.entries(counts ?? {}).filter(([, count]) => count > 0)
    .sort(([leftTool, left], [rightTool, right]) => right - left || leftTool.localeCompare(rightTool));
  const total = entries.reduce((sum, [, count]) => sum + count, 0);
  const tools = total === 0
    ? "no tool calls"
    : `${total} tool call${total === 1 ? "" : "s"}: ${entries.map(([tool, count]) => `${count} ${tool}`).join(", ")}`;
  const effects = proposals === 0 ? "no effects proposed" : `${proposals} effect${proposals === 1 ? "" : "s"} proposed`;
  return `${tools}; ${effects}`;
}
