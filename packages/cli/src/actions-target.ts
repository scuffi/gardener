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
  return {
    schemaVersion: "gardener.github-actions-task-plan/v1",
    target: GITHUB_ACTIONS_TARGET,
    taskId: bundle.taskId,
    planningPermissions: { contents: "read", idToken: "write" },
    effectsPermissions: { issues: "write", idToken: "write" },
  };
}
