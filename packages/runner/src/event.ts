import { runnerEventV1Schema, type RunnerEventV1 } from "@gardener/protocol";

type Raw = Record<string, unknown>;

function object(value: unknown, what: string): Raw {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`GitHub event payload is missing ${what}`);
  }
  return value as Raw;
}

function actor(value: unknown, what: string): Raw {
  const user = object(value, what);
  return { id: String(user.id ?? ""), login: user.login };
}

const AUTHOR_ASSOCIATIONS = new Set([
  "OWNER",
  "MEMBER",
  "COLLABORATOR",
  "CONTRIBUTOR",
  "FIRST_TIME_CONTRIBUTOR",
  "FIRST_TIMER",
  "MANNEQUIN",
  "NONE",
]);

/**
 * GitHub's `author_association` for the text's author, when it is one Gardener
 * knows. An unknown or missing value is omitted, and `authors: maintainers`
 * then refuses the event.
 */
function association(value: Raw): Raw {
  const raw = value.author_association;
  return typeof raw === "string" && AUTHOR_ASSOCIATIONS.has(raw) ? { authorAssociation: raw } : {};
}

/** On an edited event, the body before the edit, when the edit changed it. */
function previousBody(raw: Raw): Raw {
  const changes = raw.changes;
  if (changes === null || typeof changes !== "object" || Array.isArray(changes)) return {};
  const body = (changes as Raw).body;
  if (body === null || typeof body !== "object" || Array.isArray(body)) return {};
  const from = (body as Raw).from;
  return typeof from === "string" ? { previousBody: from } : {};
}

function labelNames(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((label) => String(object(label, "a label").name ?? "")).filter((name) => name.length > 0)
    : [];
}

function changedLabel(raw: Raw): string {
  return String(object(raw.label, "the changed label").name ?? "");
}

function issuePayload(raw: Raw): Raw {
  const issue = object(raw.issue, "an issue");
  return {
    id: String(issue.id ?? ""),
    number: issue.number,
    title: issue.title,
    body: issue.body ?? null,
    state: issue.state === "closed" ? "closed" : "open",
    updatedAt: issue.updated_at,
    labels: labelNames(issue.labels),
    author: actor(issue.user, "an issue author"),
    ...association(issue),
  };
}

function repositoryRef(value: unknown): Raw | null {
  if (value === null || value === undefined) return null;
  const repository = object(value, "a pull-request repository");
  return { id: String(repository.id ?? ""), fullName: repository.full_name };
}

function pullRequestPayload(raw: Raw): Raw {
  const pullRequest = object(raw.pull_request, "a pull request");
  const base = object(pullRequest.base, "a pull-request base");
  const head = object(pullRequest.head, "a pull-request head");
  return {
    id: String(pullRequest.id ?? ""),
    number: pullRequest.number,
    title: pullRequest.title,
    body: pullRequest.body ?? null,
    labels: labelNames(pullRequest.labels),
    author: actor(pullRequest.user, "a pull-request author"),
    ...association(pullRequest),
    draft: Boolean(pullRequest.draft),
    state: pullRequest.state === "closed" ? "closed" : "open",
    merged: Boolean(pullRequest.merged),
    updatedAt: pullRequest.updated_at,
    base: { ref: base.ref, sha: base.sha, repo: repositoryRef(base.repo) },
    head: { ref: head.ref, sha: head.sha, repo: repositoryRef(head.repo) },
  };
}

function commentPayload(raw: Raw): Raw {
  const comment = object(raw.comment, "a comment");
  return {
    id: String(comment.id ?? ""),
    body: comment.body ?? null,
    updatedAt: comment.updated_at,
    author: actor(comment.user, "a comment author"),
    ...association(comment),
  };
}

function discussionPayload(raw: Raw): Raw {
  const discussion = object(raw.discussion, "a discussion");
  return {
    id: String(discussion.id ?? ""),
    nodeId: discussion.node_id,
    number: discussion.number,
    title: discussion.title,
    body: discussion.body ?? null,
    labels: labelNames(discussion.labels),
    author: actor(discussion.user, "a discussion author"),
    ...association(discussion),
    category: object(discussion.category, "a discussion category").name,
    answered: Boolean(discussion.answer_chosen_at ?? discussion.answer_html_url),
    state: discussion.state === "closed" ? "closed" : "open",
    updatedAt: discussion.updated_at,
  };
}

const MAX_INCLUDED_COMMITS = 20;

function pushPayload(raw: Raw): Raw {
  const commits = Array.isArray(raw.commits) ? raw.commits : [];
  const included = commits.slice(0, MAX_INCLUDED_COMMITS);
  return {
    ref: raw.ref,
    before: raw.before,
    after: raw.after,
    forced: Boolean(raw.forced),
    commits: included.map((entry) => {
      const commit = object(entry, "a pushed commit");
      const author = object(commit.author, "a commit author");
      return {
        sha: commit.id,
        message: String(commit.message ?? "").slice(0, 4_096),
        author: { name: String(author.name ?? ""), email: String(author.email ?? "") },
      };
    }),
    includedCommits: included.length,
    // GitHub caps its own push payload, so this only reports truncation we can
    // observe. It is never a claim about the true size of the push.
    commitsTruncated: commits.length > MAX_INCLUDED_COMMITS,
  };
}

/**
 * Repository facts carried from the payload because they exist nowhere else.
 *
 * Only the default branch qualifies. Identity (`id`, `full_name`) is
 * deliberately not carried: the runtime already has it from the OIDC hello and
 * the enrollment, and accepting a second copy from the runner would create two
 * sources of truth for the one fact everything else is bound to.
 */
function repositoryPayload(raw: Raw): Raw {
  const repository = object(raw.repository, "the repository");
  const defaultBranch = typeof repository.default_branch === "string" ? repository.default_branch.trim() : "";
  if (!defaultBranch) throw new Error("GitHub event payload is missing the repository default branch");
  return { defaultBranch };
}

/**
 * Normalizes the Actions payload into the bounded wire event. Only fields the
 * model or an effect can legitimately need are carried; the raw payload is
 * never forwarded. Repository, run, ref, commit, and actor identity are
 * deliberately omitted because the runtime derives them from the OIDC hello;
 * the sole repository field carried is the default branch, which is not an
 * OIDC claim and which every exact operation embeds.
 */
/** The issue or pull request a manual run names in its inputs, by number. */
export interface DispatchTargetRequest {
  kind: "issue" | "pull_request";
  number: number;
}

/** GitHub's REST representation of the targeted resource, fetched when the run starts. */
export interface ResolvedDispatchTarget {
  issue?: unknown;
  pull_request?: unknown;
}

function dispatchNumber(value: unknown, name: string): number | undefined {
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  if (value === undefined || value === null || text === "") return undefined;
  if (!/^[1-9][0-9]{0,9}$/.test(text)) throw new Error(`workflow_dispatch input ${name} must be a positive issue or pull request number`);
  return Number(text);
}

/**
 * The target a manual run names, or `null` when it names none. At most one of
 * the `issue` and `pull_request` inputs may be set.
 */
export function dispatchTargetRequest(eventName: string, source: unknown): DispatchTargetRequest | null {
  if (eventName !== "workflow_dispatch") return null;
  const raw = object(source, "an event payload");
  const inputs = raw.inputs === undefined || raw.inputs === null ? {} : object(raw.inputs, "dispatch inputs");
  const issue = dispatchNumber(inputs.issue, "issue");
  const pullRequest = dispatchNumber(inputs.pull_request, "pull_request");
  if (issue !== undefined && pullRequest !== undefined) {
    throw new Error("workflow_dispatch may target an issue or a pull request, not both");
  }
  if (issue !== undefined) return { kind: "issue", number: issue };
  if (pullRequest !== undefined) return { kind: "pull_request", number: pullRequest };
  return null;
}

/**
 * Normalizes an Actions event. A manual run that targets an issue or pull
 * request needs that resource as GitHub reports it now, which the caller
 * fetches and passes as `resolved`; everything else comes from the payload.
 */
export function normalizeGitHubEvent(eventName: string, source: unknown, resolved?: ResolvedDispatchTarget): RunnerEventV1 {
  const raw = object(source, "an event payload");
  const action = typeof raw.action === "string" ? raw.action : undefined;
  const unsupported = (): never => {
    throw new Error(`Gardener does not support ${eventName}${action ? `: ${action}` : ""}`);
  };

  const payload = ((): Raw => {
    switch (eventName) {
      case "issues": {
        if (!action || !["opened", "edited", "labeled", "unlabeled", "reopened"].includes(action)) unsupported();
        const issue = { issue: issuePayload(raw) };
        if (action === "labeled" || action === "unlabeled") {
          return { kind: `github.issue.${action}`, ...issue, label: changedLabel(raw) };
        }
        return { kind: `github.issue.${action}`, ...issue, ...(action === "edited" ? previousBody(raw) : {}) };
      }
      case "issue_comment": {
        if (action !== "created" && action !== "edited") unsupported();
        return {
          kind: `github.issue_comment.${action}`,
          issue: issuePayload(raw),
          comment: commentPayload(raw),
          ...(action === "edited" ? previousBody(raw) : {}),
        };
      }
      case "pull_request": {
        const supported = ["opened", "reopened", "synchronize", "ready_for_review", "converted_to_draft", "edited", "labeled", "unlabeled"];
        if (!action || !supported.includes(action)) unsupported();
        const pullRequest = { pullRequest: pullRequestPayload(raw) };
        if (action === "labeled" || action === "unlabeled") {
          return { kind: `github.pull_request.${action}`, ...pullRequest, label: changedLabel(raw) };
        }
        return { kind: `github.pull_request.${action}`, ...pullRequest, ...(action === "edited" ? previousBody(raw) : {}) };
      }
      case "pull_request_review": {
        if (action !== "submitted") unsupported();
        const review = object(raw.review, "a review");
        return {
          kind: "github.pull_request_review.submitted",
          pullRequest: pullRequestPayload(raw),
          review: {
            id: String(review.id ?? ""),
            state: String(review.state ?? "").toLowerCase(),
            body: review.body ?? null,
            author: actor(review.user, "a review author"),
            ...association(review),
          },
        };
      }
      case "pull_request_review_comment": {
        if (action !== "created" && action !== "edited") unsupported();
        return {
          kind: `github.pull_request_review_comment.${action}`,
          pullRequest: pullRequestPayload(raw),
          comment: commentPayload(raw),
          ...(action === "edited" ? previousBody(raw) : {}),
        };
      }
      case "push":
        return { kind: "github.push", push: pushPayload(raw) };
      case "workflow_dispatch": {
        const inputs = raw.inputs === undefined || raw.inputs === null ? {} : object(raw.inputs, "dispatch inputs");
        const prompt = typeof inputs.prompt === "string" ? inputs.prompt.trim() : "";
        const dispatch: Raw = { kind: "github.workflow_dispatch", ...(prompt ? { prompt } : {}) };
        const target = dispatchTargetRequest(eventName, raw);
        if (target === null) {
          if (resolved?.issue !== undefined || resolved?.pull_request !== undefined) {
            throw new Error("A resolved target was supplied for a manual run that names none");
          }
          return dispatch;
        }
        if (target.kind === "issue") {
          const issue = object(resolved?.issue, `issue #${target.number}`);
          // GitHub's issues API also returns pull requests.
          if (issue.pull_request !== undefined && issue.pull_request !== null) {
            throw new Error(`#${target.number} is a pull request; use the pull_request input`);
          }
          if (issue.number !== target.number) throw new Error(`Fetched issue does not match #${target.number}`);
          return { ...dispatch, issue: issuePayload({ issue }) };
        }
        const pullRequest = object(resolved?.pull_request, `pull request #${target.number}`);
        if (pullRequest.number !== target.number) throw new Error(`Fetched pull request does not match #${target.number}`);
        return { ...dispatch, pullRequest: pullRequestPayload({ pull_request: pullRequest }) };
      }
      case "schedule": {
        const cron = typeof raw.schedule === "string" ? raw.schedule.trim() : "";
        if (!cron) throw new Error("schedule event payload is missing its cron expression");
        return { kind: "github.schedule", cron };
      }
      case "discussion": {
        const supported = ["created", "edited", "answered", "unanswered", "labeled", "unlabeled"];
        if (!action || !supported.includes(action)) unsupported();
        const discussion = { discussion: discussionPayload(raw) };
        if (action === "labeled" || action === "unlabeled") {
          return { kind: `github.discussion.${action}`, ...discussion, label: changedLabel(raw) };
        }
        return { kind: `github.discussion.${action}`, ...discussion, ...(action === "edited" ? previousBody(raw) : {}) };
      }
      case "discussion_comment": {
        if (action !== "created" && action !== "edited") unsupported();
        const comment = object(raw.comment, "a discussion comment");
        return {
          kind: `github.discussion_comment.${action}`,
          ...(action === "edited" ? previousBody(raw) : {}),
          discussion: discussionPayload(raw),
          comment: {
            id: String(comment.id ?? ""),
            nodeId: comment.node_id,
            body: comment.body ?? null,
            updatedAt: comment.updated_at,
            author: actor(comment.user, "a discussion comment author"),
            ...association(comment),
          },
        };
      }
      default:
        return unsupported();
    }
  })();

  return runnerEventV1Schema.parse({
    schemaVersion: "gardener.runner.event/v1",
    repository: repositoryPayload(raw),
    ...payload,
  });
}
