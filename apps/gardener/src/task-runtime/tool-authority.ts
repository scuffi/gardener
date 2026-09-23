import type { TaskToolV1 } from "@gardener/contracts";
import type { RunnerActionV1 } from "@gardener/protocol";

/**
 * The single mapping from harness tool name to portable task tool. Both the
 * Flue tool facade and the session's authority checks read it, so a tool can
 * never be reachable through one path but unknown to the other.
 */
export const TASK_TOOL_BY_HARNESS_NAME = {
  repository_read_file: "repository.read_file",
  repository_list_files: "repository.list_files",
  repository_exec: "repository.exec",
  provider_api_read: "provider.api.read",
} as const satisfies Record<string, TaskToolV1>;

export type HarnessToolName = keyof typeof TASK_TOOL_BY_HARNESS_NAME;

/**
 * Harness tool names that authorize one runner action kind. An action is
 * authorized when the task declared at least one of them.
 *
 * `shell.exec` maps to every repository tool because all three of them execute
 * as shell commands on the runner. The transport cannot say which tool asked
 * for it, so the only sound check is that the task declared some repository
 * capability at all; a task declaring only `provider.api.read` must never
 * reach a shell.
 *
 * `repository.capture` maps to *nothing*, deliberately. No declared tool
 * authorizes it, because it is not a capability a task holds: the runtime
 * issues it after the model's last turn, on the strength of a durable
 * proposal. An empty list therefore fails every authority check, which is
 * exactly right for the one action that must never arrive by request.
 */
export function actionToolAuthority(kind: RunnerActionV1["kind"]): readonly HarnessToolName[] {
  switch (kind) {
    case "github.read":
      return ["provider_api_read"];
    case "shell.exec":
      return ["repository_exec", "repository_read_file", "repository_list_files"];
    case "repository.capture":
      return [];
  }
}

/**
 * Pure form of the admitted-bundle authority check. The session re-derives
 * `tools` from the immutable admitted bundle rather than trusting the runner.
 */
export function taskDeclaresActionAuthority(
  tools: readonly TaskToolV1[],
  kind: RunnerActionV1["kind"],
): boolean {
  return actionToolAuthority(kind).some((name) => tools.includes(TASK_TOOL_BY_HARNESS_NAME[name]));
}
