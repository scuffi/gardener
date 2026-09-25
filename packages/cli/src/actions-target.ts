import {
  dispatchTargetKinds,
  pullRequestFamilyTriggerKindValues,
  triggerKindOrder,
  type TaskBundleV1,
  type TaskTriggerKindV1,
} from "@gardener/contracts";
import {
  GITHUB_PERMISSION_KEYS,
  mergePermissions,
  operationApplyPermissions,
  orderPermissions,
  type GitHubPermissionKey,
  type GitHubPermissions,
} from "@gardener/provider-github";

export const GITHUB_ACTIONS_TARGET = "github-actions/v1" as const;

// Permission vocabulary and the exhaustive operation mapping live in the
// provider adapter, shared with the runner's apply executor, so the compiler
// cannot grant a scope the executor does not need or omit one it does.
export { GITHUB_PERMISSION_KEYS };
export type { GitHubPermissionKey, GitHubPermissions };

export interface GitHubActionsTriggerBindingV1 {
  kind: TaskTriggerKindV1;
  /** GitHub Actions event name. */
  event: string;
  /** `github.event.action` value, when the event is action-qualified. */
  action?: string;
  /** Expression selecting the labels that gate this event, when gating applies. */
  labelsExpression?: string;
  /** Pull-request family events whose head revision can belong to a fork. */
  forkSensitive: boolean;
}

export interface GitHubActionsTaskPlanV1 {
  schemaVersion: "gardener.github-actions-task-plan/v1";
  target: typeof GITHUB_ACTIONS_TARGET;
  taskId: string;
  planningPermissions: GitHubPermissions;
  effectsPermissions: GitHubPermissions;
  /** Union the generated caller job must grant so both called jobs can run. */
  callerPermissions: GitHubPermissions;
  triggers: GitHubActionsTriggerBindingV1[];
  /**
   * True when any declared trigger can carry a fork-owned head revision, so the
   * generated workflow must gate the job on same-repository equality. Gardener
   * V1 offers no opt-in; fork pull requests are always skipped.
   */
  requiresSameRepositoryGuard: boolean;
  /**
   * Compiled network posture. `allow` means the task runs commands with the
   * GitHub-hosted runner's unrestricted egress; `deny` means no task-controlled
   * command runs at all. Host lists are always empty because this target cannot
   * enforce them.
   */
  network: { default: "deny" | "allow"; allow: []; deny: [] };
  effectLimits: { maxOperations?: number; maxBytes?: number };
}

const ISSUE_LABELS = "github.event.issue.labels.*.name";
const PULL_REQUEST_LABELS = "github.event.pull_request.labels.*.name";
const DISCUSSION_LABELS = "github.event.discussion.labels.*.name";

const TRIGGER_BINDINGS: Record<TaskTriggerKindV1, Omit<GitHubActionsTriggerBindingV1, "kind">> = {
  "github.issue.opened": { event: "issues", action: "opened", labelsExpression: ISSUE_LABELS, forkSensitive: false },
  "github.issue.edited": { event: "issues", action: "edited", labelsExpression: ISSUE_LABELS, forkSensitive: false },
  "github.issue.labeled": { event: "issues", action: "labeled", labelsExpression: ISSUE_LABELS, forkSensitive: false },
  "github.issue.unlabeled": { event: "issues", action: "unlabeled", labelsExpression: ISSUE_LABELS, forkSensitive: false },
  "github.issue.reopened": { event: "issues", action: "reopened", labelsExpression: ISSUE_LABELS, forkSensitive: false },
  "github.issue_comment.created": { event: "issue_comment", action: "created", labelsExpression: ISSUE_LABELS, forkSensitive: false },
  "github.issue_comment.edited": { event: "issue_comment", action: "edited", labelsExpression: ISSUE_LABELS, forkSensitive: false },
  "github.pull_request.opened": { event: "pull_request", action: "opened", labelsExpression: PULL_REQUEST_LABELS, forkSensitive: true },
  "github.pull_request.reopened": { event: "pull_request", action: "reopened", labelsExpression: PULL_REQUEST_LABELS, forkSensitive: true },
  "github.pull_request.synchronize": { event: "pull_request", action: "synchronize", labelsExpression: PULL_REQUEST_LABELS, forkSensitive: true },
  "github.pull_request.ready_for_review": { event: "pull_request", action: "ready_for_review", labelsExpression: PULL_REQUEST_LABELS, forkSensitive: true },
  "github.pull_request.converted_to_draft": { event: "pull_request", action: "converted_to_draft", labelsExpression: PULL_REQUEST_LABELS, forkSensitive: true },
  "github.pull_request.edited": { event: "pull_request", action: "edited", labelsExpression: PULL_REQUEST_LABELS, forkSensitive: true },
  "github.pull_request.labeled": { event: "pull_request", action: "labeled", labelsExpression: PULL_REQUEST_LABELS, forkSensitive: true },
  "github.pull_request.unlabeled": { event: "pull_request", action: "unlabeled", labelsExpression: PULL_REQUEST_LABELS, forkSensitive: true },
  "github.pull_request_review.submitted": { event: "pull_request_review", action: "submitted", labelsExpression: PULL_REQUEST_LABELS, forkSensitive: true },
  "github.pull_request_review_comment.created": { event: "pull_request_review_comment", action: "created", labelsExpression: PULL_REQUEST_LABELS, forkSensitive: true },
  "github.pull_request_review_comment.edited": { event: "pull_request_review_comment", action: "edited", labelsExpression: PULL_REQUEST_LABELS, forkSensitive: true },
  "github.push": { event: "push", forkSensitive: false },
  "github.workflow_dispatch": { event: "workflow_dispatch", forkSensitive: false },
  "github.schedule": { event: "schedule", forkSensitive: false },
  "github.discussion.created": { event: "discussion", action: "created", labelsExpression: DISCUSSION_LABELS, forkSensitive: false },
  "github.discussion.edited": { event: "discussion", action: "edited", labelsExpression: DISCUSSION_LABELS, forkSensitive: false },
  "github.discussion.answered": { event: "discussion", action: "answered", labelsExpression: DISCUSSION_LABELS, forkSensitive: false },
  "github.discussion.unanswered": { event: "discussion", action: "unanswered", labelsExpression: DISCUSSION_LABELS, forkSensitive: false },
  "github.discussion.labeled": { event: "discussion", action: "labeled", labelsExpression: DISCUSSION_LABELS, forkSensitive: false },
  "github.discussion.unlabeled": { event: "discussion", action: "unlabeled", labelsExpression: DISCUSSION_LABELS, forkSensitive: false },
  "github.discussion_comment.created": { event: "discussion_comment", action: "created", labelsExpression: DISCUSSION_LABELS, forkSensitive: false },
  "github.discussion_comment.edited": { event: "discussion_comment", action: "edited", labelsExpression: DISCUSSION_LABELS, forkSensitive: false },
};

/** Write scopes the checkout-free apply job needs for one exact operation kind. */
const effectPermissions = operationApplyPermissions;

/**
 * A reusable called job may only request permissions its caller granted. The
 * planner exposes a bounded read-only GitHub API whose resource family is
 * selected at runtime, so every generated caller grants this fixed read union.
 * Writes remain task-exact and are added below from the declared effect kinds.
 */
const planningPermissions = orderPermissions({
  checks: "read",
  contents: "read",
  discussions: "read",
  "id-token": "write",
  issues: "read",
  "pull-requests": "read",
  statuses: "read",
});

export function compileGitHubActionsTask(bundle: TaskBundleV1): GitHubActionsTaskPlanV1 {
  // A draft keeps its declared triggers in the bundle, so a manual run can
  // target what they describe, but its workflow listens only for manual runs.
  const triggers = bundle.triggers
    .filter((trigger) => bundle.draft !== true || trigger.kind === "github.workflow_dispatch")
    .map((trigger) => ({
      kind: trigger.kind,
      ...TRIGGER_BINDINGS[trigger.kind],
    }));
  if (triggers.length === 0) {
    throw new Error(`Task ${bundle.taskId} must declare at least one trigger`);
  }

  const canonical = [...bundle.triggers].sort(
    (left, right) => triggerKindOrder.get(left.kind)! - triggerKindOrder.get(right.kind)!,
  );
  if (canonical.some((trigger, index) => trigger.kind !== bundle.triggers[index]!.kind)) {
    throw new Error(`Task ${bundle.taskId} lists triggers outside canonical order`);
  }

  // Network model for github-actions/v1.
  //
  // Gardener does not sandbox the GitHub-hosted runner's network. A task that
  // declares `repository.exec` therefore has the runner's ordinary unrestricted
  // egress, and must say so: `default: allow` with empty lists. Host rules are
  // rejected outright rather than compiled into an allowlist Gardener cannot
  // enforce, because a filter that silently does nothing is worse than none.
  //
  // Tasks without `repository.exec` never run task-controlled commands, so they
  // must declare `default: deny` with empty lists.
  const declaresExec = bundle.tools.includes("repository.exec");
  const expectedDefault = declaresExec ? "allow" : "deny";
  if (bundle.network.default !== expectedDefault) {
    throw new Error(
      declaresExec
        ? `Task ${bundle.taskId} declares repository.exec, so it must declare network default allow: Gardener does not restrict runner egress and the task can reach any host`
        : `Task ${bundle.taskId} must use network default deny because it does not declare repository.exec`,
    );
  }
  for (const key of ["allow", "deny"] as const) {
    if (bundle.network[key].length > 0) {
      throw new Error(
        `Task ${bundle.taskId} declares network ${key} hosts, but github-actions/v1 cannot enforce host rules; remove them`,
      );
    }
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
  if (bundle.limits.maxEffectOperations !== undefined && bundle.effects.length === 0) {
    throw new Error(`Task ${bundle.taskId} sets max-effect-operations without declaring any effect`);
  }

  // Apply reads a manual run's target again to check the plan's binding, so it
  // needs read access to every kind of target the workflow form offers.
  const targetReadPermissions: GitHubPermissions[] = dispatchTargetKinds(bundle.triggers)
    .map((target) => (target === "issue" ? { issues: "read" } : { "pull-requests": "read" }));
  const effectsPermissions = bundle.effects.length === 0
    ? orderPermissions({ "id-token": "write" })
    : mergePermissions({ "id-token": "write" }, ...targetReadPermissions, ...bundle.effects.map(effectPermissions));

  return {
    schemaVersion: "gardener.github-actions-task-plan/v1",
    target: GITHUB_ACTIONS_TARGET,
    taskId: bundle.taskId,
    planningPermissions,
    effectsPermissions,
    callerPermissions: mergePermissions(planningPermissions, effectsPermissions),
    triggers,
    // Describes the bundle, not the rendered triggers: a draft still acts on
    // pull requests when run by hand.
    requiresSameRepositoryGuard: bundle.triggers.some(
      (trigger) => pullRequestFamilyTriggerKindValues.includes(trigger.kind),
    ),
    network: { default: expectedDefault, allow: [], deny: [] },
    effectLimits: {
      ...(bundle.limits.maxEffectOperations === undefined ? {} : { maxOperations: bundle.limits.maxEffectOperations }),
      ...(bundle.limits.maxEffectBytes === undefined ? {} : { maxBytes: bundle.limits.maxEffectBytes }),
    },
  };
}
