import {
  repositoryEventV2Schema,
  type GitHubIdentity,
  type RepositoryEventV2,
  type RepositoryRef,
} from "@gardener/contracts";

type JsonRecord = Record<string, unknown>;
const SHA = /^[a-fA-F0-9]{40}$/;
const ACTIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  issues: new Set(["opened", "edited", "reopened", "closed", "labeled", "unlabeled", "assigned", "unassigned", "milestoned", "demilestoned", "locked", "unlocked", "typed", "untyped", "transferred", "deleted", "pinned", "unpinned"]),
  pull_request: new Set(["opened", "edited", "reopened", "closed", "synchronize", "ready_for_review", "converted_to_draft", "labeled", "unlabeled", "assigned", "unassigned", "milestoned", "demilestoned", "locked", "unlocked", "enqueued", "dequeued", "review_requested", "review_request_removed", "auto_merge_enabled", "auto_merge_disabled"]),
  issue_comment: new Set(["created", "edited", "deleted"]),
  pull_request_review: new Set(["submitted", "edited", "dismissed"]),
  pull_request_review_comment: new Set(["created", "edited", "deleted"]),
  discussion: new Set(["created", "edited", "deleted", "transferred", "pinned", "unpinned", "locked", "unlocked", "category_changed", "labeled", "unlabeled", "answered", "unanswered"]),
  discussion_comment: new Set(["created", "edited", "deleted"]),
  check_run: new Set(["created", "rerequested", "completed", "requested_action"]),
  check_suite: new Set(["requested", "rerequested", "completed"]),
  push: new Set(["pushed"]),
  release: new Set(["created", "edited", "deleted", "published", "unpublished", "prereleased", "released"]),
};

function record(value: unknown): value is JsonRecord { return typeof value === "object" && value !== null && !Array.isArray(value); }
function integer(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
function string(value: unknown, max: number): value is string { return typeof value === "string" && value.length <= max; }
function timestamp(value: unknown): string | null {
  if (typeof value === "string" && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString();
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return new Date(value * 1_000).toISOString();
  return null;
}
function url(value: unknown): value is string { if (typeof value !== "string") return false; try { new URL(value); return true; } catch { return false; } }
function labels(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > 100) return null;
  const result: string[] = [];
  for (const item of value) { if (!record(item) || typeof item.name !== "string" || item.name.trim().length < 1 || item.name.length > 100) return null; result.push(item.name); }
  return result;
}
function identity(value: unknown): GitHubIdentity | null {
  if (!record(value) || !integer(value.id) || typeof value.login !== "string" || value.login.trim().length < 1 || value.login.length > 255) return null;
  const accountType = value.type;
  if (accountType !== "User" && accountType !== "Organization" && accountType !== "Bot" && accountType !== "Mannequin") return null;
  return { id: String(value.id), login: value.login, accountType };
}
function repository(payload: JsonRecord): RepositoryRef | null {
  const repo = payload.repository, installation = payload.installation;
  if (!record(repo) || !integer(repo.id) || !record(repo.owner) || typeof repo.owner.login !== "string" || typeof repo.name !== "string" || typeof repo.default_branch !== "string" || !record(installation) || !integer(installation.id)) return null;
  const parsed = { provider: "github" as const, id: String(repo.id), installationId: String(installation.id), owner: repo.owner.login, name: repo.name, defaultBranch: repo.default_branch };
  const result = repositoryEventV2Schema; // retain one schema authority; final parse validates this ref.
  void result;
  return parsed;
}
function issue(value: unknown) {
  if (!record(value) || !integer(value.id) || !integer(value.number) || !string(value.title, 1_024) || (value.body !== null && !string(value.body, 65_536)) || (value.state !== "open" && value.state !== "closed") || typeof value.locked !== "boolean" || !url(value.html_url)) return null;
  const updatedAt = timestamp(value.updated_at), parsedLabels = labels(value.labels); if (!updatedAt || !parsedLabels) return null;
  return { id: String(value.id), number: value.number, title: value.title, body: value.body as string | null, state: value.state, labels: parsedLabels, locked: value.locked, updatedAt, htmlUrl: value.html_url };
}
function pull(value: unknown) {
  if (!record(value) || !integer(value.id) || !integer(value.number) || !string(value.title, 1_024) || (value.body !== null && !string(value.body, 65_536)) || (value.state !== "open" && value.state !== "closed") || typeof value.draft !== "boolean" || typeof value.merged !== "boolean" || !record(value.head) || typeof value.head.ref !== "string" || !SHA.test(String(value.head.sha)) || !record(value.base) || typeof value.base.ref !== "string" || !SHA.test(String(value.base.sha)) || !url(value.html_url)) return null;
  const updatedAt = timestamp(value.updated_at), parsedLabels = labels(value.labels); if (!updatedAt || !parsedLabels) return null;
  return { id: String(value.id), number: value.number, title: value.title, body: value.body as string | null, state: value.state, draft: value.draft, merged: value.merged, labels: parsedLabels, head: { ref: value.head.ref, sha: value.head.sha }, base: { ref: value.base.ref, sha: value.base.sha }, updatedAt, htmlUrl: value.html_url };
}
function comment(value: unknown) {
  if (!record(value) || !integer(value.id) || !string(value.body, 65_536) || !url(value.html_url)) return null;
  const updatedAt = timestamp(value.updated_at); return updatedAt ? { id: String(value.id), body: value.body, updatedAt, htmlUrl: value.html_url } : null;
}
function base(payload: JsonRecord, deliveryId: string, instanceId: string, occurredAt: string, repo: RepositoryRef, actor: GitHubIdentity, resourceAuthor: GitHubIdentity | null) {
  void payload;
  return { schemaVersion: "v2" as const, id: `github:${deliveryId}`, deliveryId, instanceId, occurredAt, repository: repo, actor, resourceAuthor };
}

/** Pure, strict normalization. Unknown actions and incomplete identity/fact payloads fail closed. */
export function normalizeGitHubWebhook(eventName: string, payloadValue: unknown, deliveryId: string, instanceId = "pending"): RepositoryEventV2 | null {
  if (!record(payloadValue) || !ACTIONS[eventName]) return null;
  const payload = payloadValue;
  const rawAction = eventName === "push" ? "pushed" : payload.action;
  if (typeof rawAction !== "string" || !ACTIONS[eventName]!.has(rawAction)) return null;
  const repo = repository(payload), actor = identity(payload.sender); if (!repo || !actor) return null;
  let candidate: unknown = null;

  if (eventName === "issues") {
    const resource = issue(payload.issue), author = record(payload.issue) ? identity(payload.issue.user) : null;
    if (resource && author) candidate = { ...base(payload, deliveryId, instanceId, resource.updatedAt, repo, actor, author), kind: "github.issue", action: rawAction, issue: resource };
  } else if (eventName === "pull_request") {
    const resource = pull(payload.pull_request), author = record(payload.pull_request) ? identity(payload.pull_request.user) : null;
    if (resource && author) candidate = { ...base(payload, deliveryId, instanceId, resource.updatedAt, repo, actor, author), kind: "github.pull_request", action: rawAction, pullRequest: resource };
  } else if (eventName === "issue_comment") {
    // GitHub's issue_comment payload does not contain immutable PR head/base facts. PR issue comments therefore fail closed instead of being mis-attested.
    if (record(payload.issue) && payload.issue.pull_request === undefined) {
      const parent = issue(payload.issue), resource = comment(payload.comment), author = record(payload.comment) ? identity(payload.comment.user) : null;
      if (parent && resource && author) candidate = { ...base(payload, deliveryId, instanceId, resource.updatedAt, repo, actor, author), kind: "github.issue_comment", action: rawAction, issue: parent, comment: resource };
    }
  } else if (eventName === "pull_request_review") {
    const parent = pull(payload.pull_request), review = payload.review, author = record(review) ? identity(review.user) : null;
    if (parent && record(review) && integer(review.id) && author && typeof review.state === "string" && typeof review.body === "string" && review.body.length <= 65_536 && SHA.test(String(review.commit_id))) {
      const states: Record<string, string> = { PENDING: "pending", COMMENTED: "commented", APPROVED: "approved", CHANGES_REQUESTED: "changes_requested", DISMISSED: "dismissed" };
      const state = states[review.state.toUpperCase()]; const occurredAt = timestamp(review.submitted_at) ?? parent.updatedAt;
      if (state) candidate = { ...base(payload, deliveryId, instanceId, occurredAt, repo, actor, author), kind: "github.pull_request_review", action: rawAction, pullRequest: parent, review: { id: String(review.id), state, body: review.body, submittedAt: timestamp(review.submitted_at), commitSha: review.commit_id } };
    }
  } else if (eventName === "pull_request_review_comment") {
    const parent = pull(payload.pull_request), resource = comment(payload.comment), value = payload.comment, author = record(value) ? identity(value.user) : null;
    if (parent && resource && record(value) && author && typeof value.path === "string" && value.path.length <= 1_024 && (value.line === null || integer(value.line)) && SHA.test(String(value.commit_id))) candidate = { ...base(payload, deliveryId, instanceId, resource.updatedAt, repo, actor, author), kind: "github.pull_request_review_comment", action: rawAction, pullRequest: parent, comment: { ...resource, path: value.path, line: value.line, commitSha: value.commit_id } };
  } else if (eventName === "discussion") {
    const value = payload.discussion, author = record(value) ? identity(value.user) : null;
    if (record(value) && integer(value.id) && integer(value.number) && string(value.title, 1_024) && string(value.body, 65_536) && (value.state === "open" || value.state === "closed") && typeof value.locked === "boolean" && url(value.html_url) && author) {
      const updatedAt = timestamp(value.updated_at), parsedLabels = labels(value.labels); if (updatedAt && parsedLabels) candidate = { ...base(payload, deliveryId, instanceId, updatedAt, repo, actor, author), kind: "github.discussion", action: rawAction, discussion: { id: String(value.id), number: value.number, title: value.title, body: value.body, state: value.state, answered: value.answer_chosen_at != null, labels: parsedLabels, updatedAt, htmlUrl: value.html_url } };
    }
  } else if (eventName === "discussion_comment") {
    const discussion = payload.discussion, author = record(payload.comment) ? identity(payload.comment.user) : null, resource = comment(payload.comment);
    if (record(discussion) && resource && author && integer(discussion.id) && integer(discussion.number) && string(discussion.title, 1_024) && string(discussion.body, 65_536) && (discussion.state === "open" || discussion.state === "closed") && typeof discussion.locked === "boolean" && url(discussion.html_url)) {
      const updatedAt = timestamp(discussion.updated_at), parsedLabels = labels(discussion.labels); if (updatedAt && parsedLabels) candidate = { ...base(payload, deliveryId, instanceId, resource.updatedAt, repo, actor, author), kind: "github.discussion_comment", action: rawAction, discussion: { id: String(discussion.id), number: discussion.number, title: discussion.title, body: discussion.body, state: discussion.state, answered: discussion.answer_chosen_at != null, labels: parsedLabels, updatedAt, htmlUrl: discussion.html_url }, comment: resource };
    }
  } else if (eventName === "check_run") {
    const value = payload.check_run;
    if (record(value) && integer(value.id) && typeof value.name === "string" && SHA.test(String(value.head_sha)) && ["queued", "in_progress", "completed", "waiting", "pending"].includes(String(value.status)) && (value.conclusion === null || typeof value.conclusion === "string") && (value.details_url === null || url(value.details_url))) {
      const occurredAt = timestamp(value.completed_at) ?? timestamp(value.started_at) ?? timestamp(value.created_at);
      if (occurredAt) candidate = { ...base(payload, deliveryId, instanceId, occurredAt, repo, actor, null), kind: "github.check_run", action: rawAction, checkRun: { id: String(value.id), name: value.name, headSha: value.head_sha, status: value.status, conclusion: value.conclusion, detailsUrl: value.details_url } };
    }
  } else if (eventName === "check_suite") {
    const value = payload.check_suite;
    if (record(value) && integer(value.id) && SHA.test(String(value.head_sha)) && ["queued", "in_progress", "completed", "waiting", "pending"].includes(String(value.status)) && (value.conclusion === null || typeof value.conclusion === "string")) {
      const occurredAt = timestamp(value.updated_at) ?? timestamp(value.created_at); if (occurredAt) candidate = { ...base(payload, deliveryId, instanceId, occurredAt, repo, actor, null), kind: "github.check_suite", action: rawAction, checkSuite: { id: String(value.id), headSha: value.head_sha, status: value.status, conclusion: value.conclusion } };
    }
  } else if (eventName === "push") {
    const occurredAt = (record(payload.head_commit) ? timestamp(payload.head_commit.timestamp) : null) ?? (record(payload.repository) ? timestamp(payload.repository.pushed_at) : null);
    if (typeof payload.ref === "string" && SHA.test(String(payload.before)) && SHA.test(String(payload.after)) && typeof payload.forced === "boolean" && typeof payload.created === "boolean" && typeof payload.deleted === "boolean" && Array.isArray(payload.commits) && payload.commits.length <= 10_000 && occurredAt) candidate = { ...base(payload, deliveryId, instanceId, occurredAt, repo, actor, null), kind: "github.push", action: "pushed", push: { ref: payload.ref, before: payload.before, after: payload.after, forced: payload.forced, created: payload.created, deleted: payload.deleted, commitCount: payload.commits.length } };
  } else if (eventName === "release") {
    const value = payload.release, author = record(value) ? identity(value.author) : null;
    if (record(value) && integer(value.id) && typeof value.tag_name === "string" && typeof value.target_commitish === "string" && (value.name === null || typeof value.name === "string") && (value.body === null || string(value.body, 65_536)) && typeof value.draft === "boolean" && typeof value.prerelease === "boolean" && url(value.html_url) && author) {
      const updatedAt = timestamp(value.updated_at); if (updatedAt) candidate = { ...base(payload, deliveryId, instanceId, updatedAt, repo, actor, author), kind: "github.release", action: rawAction, release: { id: String(value.id), tagName: value.tag_name, targetCommitish: value.target_commitish, name: value.name, body: value.body, draft: value.draft, prerelease: value.prerelease, publishedAt: timestamp(value.published_at), updatedAt, htmlUrl: value.html_url } };
    }
  }
  const parsed = repositoryEventV2Schema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}
