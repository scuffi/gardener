import { normalizedPullRequest, type NormalizedEventV1, type TaskToolV1 } from "@gardener/contracts";
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
  repository_merge_base: "repository.merge_base",
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
 *
 * `repository.merge_base` maps only to its own tool. It changes the working
 * tree, but it is not a shell, so it must never authorize `shell.exec`, and
 * no repository tool authorizes it.
 */
export function actionToolAuthority(kind: RunnerActionV1["kind"]): readonly HarnessToolName[] {
  switch (kind) {
    case "github.read":
      return ["provider_api_read"];
    case "shell.exec":
      return ["repository_exec", "repository_read_file", "repository_list_files"];
    case "repository.capture":
      return [];
    case "repository.merge_base":
      return ["repository_merge_base"];
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

/**
 * Why this run may not write a merge into its working tree, or `undefined`
 * when it may.
 *
 * Checked by the Worker on every `repository.merge_base` request, however it
 * arrives, independently of the bridge that prepared the merge: a merge
 * belongs on a same-repository pull request whose head the planning job
 * checked out and the bridge confirmed (`checkoutSha`). The bridge prepares
 * nothing otherwise, but a bridge is runner code and this must not rest on it.
 */
export function mergeBaseToolRefusal(event: NormalizedEventV1): string | undefined {
  const pullRequest = normalizedPullRequest(event);
  if (pullRequest === undefined) {
    return "repository.merge_base needs a run on a pull request's head, and this run is not on one: it was not triggered from a pull request, "
      + "or the planning job kept the default checkout because the pull request is closed or comes from a fork";
  }
  if (event.checkoutSha === undefined) {
    return `repository.merge_base needs the head of #${pullRequest.number} checked out, and the planning job did not confirm checking it out`;
  }
  // The base repository is the event's repository: the run is bound to it.
  if (pullRequest.head.repo === null || pullRequest.head.repo.id !== event.repository.id) {
    return `repository.merge_base cannot merge into #${pullRequest.number}: its head belongs to ${pullRequest.head.repo?.fullName ?? "a deleted repository"}, `
      + "not this repository, and Gardener never pushes to a fork";
  }
  return undefined;
}
