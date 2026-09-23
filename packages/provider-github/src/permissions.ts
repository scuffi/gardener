import { operationKindValues, type OperationKind } from "@gardener/contracts";

/**
 * GitHub Actions `permissions:` keys Gardener can derive, rendered in this
 * fixed order wherever a permission block is emitted.
 *
 * This module is the single source of truth for the operation-to-permission
 * mapping. The CLI compiler derives generated-workflow permissions from it and
 * the runner's apply executor is checked against it, so the two can never
 * drift: a scope the executor needs but the compiler never grants produces a
 * run that fails at apply time, after the model has already done its work.
 *
 * Portable `TaskBundleV1` never carries these names. Tasks declare operation
 * kinds; provider permission vocabulary lives here, in the provider adapter.
 */
export const GITHUB_PERMISSION_KEYS = [
  "actions",
  "checks",
  "contents",
  "discussions",
  "id-token",
  "issues",
  "pull-requests",
  "statuses",
] as const;

export type GitHubPermissionKey = (typeof GITHUB_PERMISSION_KEYS)[number];
export type GitHubPermissionLevel = "read" | "write";
export type GitHubPermissions = Partial<Record<GitHubPermissionKey, GitHubPermissionLevel>>;

/** A `key:level` scope string, for example `issues:write`. */
export type GitHubPermissionScope = `${GitHubPermissionKey}:${GitHubPermissionLevel}`;

/**
 * Exact GitHub token permissions each operation kind requires on the
 * privileged apply job, derived from the REST and GraphQL calls the executor
 * actually makes.
 *
 * Notes on the non-obvious entries:
 *
 * - `pull_request.merge` reads check runs and commit statuses to verify branch
 *   protection preconditions before merging, so it needs `checks:read` and
 *   `statuses:read` in addition to the write scopes.
 * - `pull_request.open_draft` needs `contents:read` to resolve the head and
 *   base revisions it opens the pull request between.
 * - `check.rerun` uses the Checks API only (`/check-runs/{id}` and
 *   `/commits/{sha}/check-runs`). It never calls the Actions API, so it must
 *   not derive any `actions` scope.
 */
export const OPERATION_TOKEN_PERMISSIONS: Readonly<Record<OperationKind, readonly GitHubPermissionScope[]>> =
  Object.freeze({
    "issue.label.add": ["issues:write"],
    "issue.label.remove": ["issues:write"],
    "issue.comment.create": ["issues:write"],
    "issue.comment.update": ["issues:write"],
    "issue.close": ["issues:write"],
    "issue.reopen": ["issues:write"],
    "issue.assignee.add": ["issues:write"],
    "issue.assignee.remove": ["issues:write"],
    "pull_request.comment.create": ["pull-requests:write"],
    "pull_request.comment.update": ["pull-requests:write"],
    "pull_request.review.submit": ["pull-requests:write"],
    "pull_request.reviewer.request": ["pull-requests:write"],
    "pull_request.reviewer.remove": ["pull-requests:write"],
    "pull_request.update": ["pull-requests:write"],
    "branch.create": ["contents:write"],
    "commit.create": ["contents:write"],
    "pull_request.open_draft": ["contents:read", "pull-requests:write"],
    "pull_request.merge": ["contents:write", "pull-requests:write", "checks:read", "statuses:read"],
    "discussion.comment.create": ["discussions:write"],
    "discussion.comment.update": ["discussions:write"],
    "discussion.answer.mark": ["discussions:write"],
    "discussion.answer.unmark": ["discussions:write"],
    "discussion.close": ["discussions:write"],
    "discussion.reopen": ["discussions:write"],
    "check.rerun": ["checks:write"],
    "release.create": ["contents:write"],
    "release.update": ["contents:write"],
    "release.publish": ["contents:write"],
    "release.delete": ["contents:write"],
  } satisfies Record<OperationKind, readonly GitHubPermissionScope[]>);

/**
 * Read scopes planning needs to build exact preconditions for one operation
 * kind. Planning never writes, so every level here is `read`.
 */
export const OPERATION_PLANNING_READ_PERMISSIONS: Readonly<Record<OperationKind, readonly GitHubPermissionScope[]>> =
  Object.freeze(Object.fromEntries(
    operationKindValues.map((kind) => [kind, planningReadScopes(kind)]),
  ) as Record<OperationKind, readonly GitHubPermissionScope[]>);

/**
 * Planning reads the resource an operation targets, plus anything the apply
 * step will assert a precondition against, so the model can propose an
 * operation that will still be valid when it is applied.
 */
function planningReadScopes(kind: OperationKind): readonly GitHubPermissionScope[] {
  const downgraded = OPERATION_TOKEN_PERMISSIONS[kind].map(
    (scope) => `${scopeKey(scope)}:read` as GitHubPermissionScope,
  );
  // `id-token` is never a resource read, and `contents:read` is already granted
  // to every planning job, so neither needs to come from the operation.
  return [...new Set(downgraded)].filter((scope) => scopeKey(scope) !== "id-token");
}

export function scopeKey(scope: GitHubPermissionScope): GitHubPermissionKey {
  return scope.slice(0, scope.lastIndexOf(":")) as GitHubPermissionKey;
}

export function scopeLevel(scope: GitHubPermissionScope): GitHubPermissionLevel {
  return scope.slice(scope.lastIndexOf(":") + 1) as GitHubPermissionLevel;
}

/** Collapses scope strings into a permission block, with `write` winning. */
export function permissionsFromScopes(scopes: Iterable<GitHubPermissionScope>): GitHubPermissions {
  const merged: GitHubPermissions = {};
  for (const scope of scopes) {
    const key = scopeKey(scope);
    if (merged[key] === "write") continue;
    merged[key] = scopeLevel(scope);
  }
  return orderPermissions(merged);
}

/** Unions permission blocks, with `write` winning over `read`. */
export function mergePermissions(...sources: GitHubPermissions[]): GitHubPermissions {
  const merged: GitHubPermissions = {};
  for (const source of sources) {
    for (const key of GITHUB_PERMISSION_KEYS) {
      const value = source[key];
      if (value === undefined) continue;
      if (merged[key] === "write" || value === "write") merged[key] = "write";
      else merged[key] = "read";
    }
  }
  return orderPermissions(merged);
}

/** Rewrites a permission block into the canonical key order. */
export function orderPermissions(permissions: GitHubPermissions): GitHubPermissions {
  const ordered: GitHubPermissions = {};
  for (const key of GITHUB_PERMISSION_KEYS) {
    const value = permissions[key];
    if (value !== undefined) ordered[key] = value;
  }
  return ordered;
}

/** Write scopes the checkout-free apply job needs for one operation kind. */
export function operationApplyPermissions(kind: OperationKind): GitHubPermissions {
  return permissionsFromScopes(OPERATION_TOKEN_PERMISSIONS[kind]);
}

/** Read scopes planning needs to build preconditions for one operation kind. */
export function operationPlanningReadPermissions(kind: OperationKind): GitHubPermissions {
  return permissionsFromScopes(OPERATION_PLANNING_READ_PERMISSIONS[kind]);
}
