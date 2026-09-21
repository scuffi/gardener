import type { TaskBundleV1 } from "@gardener/contracts";

export const GITHUB_ACTIONS_TARGET = "github-actions/v1" as const;

export interface GitHubActionsTaskPlanV1 {
  schemaVersion: "gardener.github-actions-task-plan/v1";
  target: typeof GITHUB_ACTIONS_TARGET;
  taskId: string;
  planningPermissions: {
    contents: "read";
    idToken: "write";
  };
  effectsPermissions: {
    issues: "write";
    idToken: "write";
  };
}

export function compileGitHubActionsTask(bundle: TaskBundleV1): GitHubActionsTaskPlanV1 {
  if (bundle.triggers.some((trigger) => trigger.kind !== "github.issue.opened")) {
    throw new Error(`Task ${bundle.taskId} uses a trigger unsupported by github-actions/v1`);
  }
  const supportedTools = new Set(["repository.list_files", "repository.read_file"]);
  const unsupportedTool = bundle.tools.find((tool) => !supportedTools.has(tool));
  if (unsupportedTool) {
    throw new Error(`Task ${bundle.taskId} tool ${unsupportedTool} is unsupported by github-actions/v1`);
  }
  if (bundle.effects.length !== 1 || bundle.effects[0] !== "issue.comment.create") {
    throw new Error(`Task ${bundle.taskId} must declare exactly issue.comment.create for github-actions/v1`);
  }
  if (bundle.network.default !== "deny" || bundle.network.allow.length > 0 || bundle.network.deny.length > 0) {
    throw new Error(
      `Task ${bundle.taskId} requests network rules that github-actions/v1 cannot yet enforce`,
    );
  }
  if (bundle.limits.runtimeSeconds < 30 || bundle.limits.runtimeSeconds > 480) {
    throw new Error(`Task ${bundle.taskId} runtime-seconds must be between 30 and 480 for github-actions/v1`);
  }
  if (bundle.limits.maxTurns < 3 || bundle.limits.maxTurns > 16) {
    throw new Error(`Task ${bundle.taskId} max-turns must be between 3 and 16 for github-actions/v1`);
  }
  if (bundle.limits.maxToolCalls < 3 || bundle.limits.maxToolCalls > 64) {
    throw new Error(`Task ${bundle.taskId} max-tool-calls must be between 3 and 64 for github-actions/v1`);
  }
  if (bundle.limits.inputTokens > 128_000 || bundle.limits.outputTokens > 32_000) {
    throw new Error(`Task ${bundle.taskId} token limits exceed github-actions/v1 model bounds`);
  }
  return {
    schemaVersion: "gardener.github-actions-task-plan/v1",
    target: GITHUB_ACTIONS_TARGET,
    taskId: bundle.taskId,
    planningPermissions: { contents: "read", idToken: "write" },
    effectsPermissions: { issues: "write", idToken: "write" },
  };
}
