import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { operationKindValues, operationSchema, type Operation } from "@gardener/contracts";
import {
  branchProtectionHash,
  canonicalOperationHash,
  executeActionsOperation,
  OPERATION_TOKEN_PERMISSIONS,
  successfulChecks,
  type GitHubEffectsContext,
} from "../src/github-effects";

const REPOSITORY = {
  provider: "github",
  id: "100",
  owner: "acme",
  name: "widgets",
  defaultBranch: "main",
} as const;

const REPO = "/repos/acme/widgets";
const CAPTURED_CONTENT = new TextEncoder().encode("const a = 1;");
const CAPTURED_FILE = {
  status: "modified",
  mode: "100644",
  sizeBytes: CAPTURED_CONTENT.byteLength,
  sha256: createHash("sha256").update(CAPTURED_CONTENT).digest("hex"),
} as const;
async function readCapturedFixture(file: { sha256: string }): Promise<Uint8Array> {
  if (file.sha256 !== CAPTURED_FILE.sha256) throw new Error("unknown captured file");
  return CAPTURED_CONTENT;
}
const ISSUE_UPDATED = "2026-01-01T00:00:00Z";
const PULL_UPDATED = "2026-01-02T00:00:00Z";
const COMMENT_UPDATED = "2026-01-03T00:00:00Z";
const DISCUSSION_UPDATED = "2026-01-04T00:00:00Z";
const RELEASE_UPDATED = "2026-01-05T00:00:00Z";
const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const NEW_COMMIT = "c".repeat(40);
const PARENT_TREE = "d".repeat(40);
const NEW_TREE = "e".repeat(40);
const BLOB = "f".repeat(40);
const MERGE_SHA = "9".repeat(40);
const BOT = { login: "github-actions[bot]" };
/** GraphQL exposes the same account as a Bot node with a bare login. */
const GRAPHQL_BOT = { login: "github-actions" };
const PROTECTION = { required_status_checks: { strict: true, contexts: ["ci"] } };
const PROTECTION_HASH = branchProtectionHash(PROTECTION);
const COMPLETED_CHECK = {
  id: 99,
  name: "build",
  status: "completed",
  conclusion: "failure",
  head_sha: HEAD,
  started_at: "2026-01-06T00:00:00Z",
  app: { id: 15368, slug: "github-actions" },
};

function marked(id: string, body: string): string {
  return `${body}\n<!-- gardener-operation:${id} -->`;
}

/* -------------------------------------------------------------------------- */
/* Mocked fetch harness                                                        */
/* -------------------------------------------------------------------------- */

interface Call { method: string; path: string; body: unknown }
interface Handler {
  when: (call: Call) => boolean;
  status?: number;
  json?: unknown;
  headers?: Record<string, string>;
}

function matches(path: string, pattern: string): boolean {
  return path === pattern || path.startsWith(`${pattern}?`);
}

function get(path: string, json: unknown, status = 200): Handler {
  return { when: (call) => call.method === "GET" && matches(call.path, path), json, status };
}

function send(method: string, path: string, json: unknown, status = 200): Handler {
  return { when: (call) => call.method === method && matches(call.path, path), json, status };
}

/** Matches a GraphQL request whose document contains `fragment`. */
function gql(fragment: string, data: unknown): Handler {
  return {
    when: (call) => {
      if (call.method !== "POST" || call.path !== "/graphql") return false;
      const query = (call.body as { query?: unknown } | undefined)?.query;
      return typeof query === "string" && query.includes(fragment);
    },
    json: { data },
  };
}

function harness(handlers: Handler[]): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const raw = init?.body;
    const call: Call = {
      method: (init?.method ?? "GET").toUpperCase(),
      path: `${url.pathname}${url.search}`,
      body: typeof raw === "string" && raw.length > 0 ? JSON.parse(raw) : undefined,
    };
    calls.push(call);
    const handler = handlers.find((candidate) => candidate.when(call));
    if (!handler) throw new Error(`Unhandled request: ${call.method} ${call.path}`);
    const status = handler.status ?? 200;
    return new Response(status === 204 ? null : JSON.stringify(handler.json ?? {}), {
      status,
      headers: { "content-type": "application/json", "x-github-request-id": "REQ-1", ...(handler.headers ?? {}) },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function context(
  fetchImpl: typeof fetch,
  operation: Operation,
  overrides: Partial<GitHubEffectsContext> = {},
): GitHubEffectsContext {
  return {
    token: "ghs_token",
    repositoryFullName: "acme/widgets",
    operationHash: canonicalOperationHash(operation),
    attempt: 1,
    fetch: fetchImpl,
    now: () => new Date("2026-02-01T00:00:00Z"),
    readCapturedFile: readCapturedFixture,
    ...overrides,
  };
}

async function run(operation: Operation, handlers: Handler[], overrides: Partial<GitHubEffectsContext> = {}) {
  const { fetchImpl, calls } = harness(handlers);
  const result = await executeActionsOperation(operation, context(fetchImpl, operation, overrides));
  return { ...result, calls };
}

/* -------------------------------------------------------------------------- */
/* Shared operation fixtures                                                   */
/* -------------------------------------------------------------------------- */

const issueBase = {
  schemaVersion: "v2",
  repository: REPOSITORY,
  issueNumber: 5,
  expectedIssueState: "open",
  expectedIssueUpdatedAt: ISSUE_UPDATED,
} as const;

const pullBase = {
  schemaVersion: "v2",
  repository: REPOSITORY,
  pullNumber: 7,
  expectedHeadSha: HEAD,
  expectedBaseRef: "main",
  expectedBaseSha: BASE,
  expectedState: "open",
  expectedDraft: false,
  expectedPullUpdatedAt: PULL_UPDATED,
} as const;

const discussionBase = {
  schemaVersion: "v2",
  repository: REPOSITORY,
  discussionNumber: 3,
  expectedDiscussionState: "open",
  expectedDiscussionUpdatedAt: DISCUSSION_UPDATED,
} as const;

const OPEN_ISSUE = {
  id: 500,
  number: 5,
  state: "open",
  updated_at: ISSUE_UPDATED,
  labels: [],
  assignees: [],
  html_url: "https://github.com/acme/widgets/issues/5",
};

const OPEN_PULL = {
  id: 700,
  number: 7,
  node_id: "PR_node",
  state: "open",
  draft: false,
  title: "Original",
  body: "Original body",
  updated_at: PULL_UPDATED,
  head: { sha: HEAD, ref: "gardener/feature" },
  base: { ref: "main", sha: BASE },
  requested_reviewers: [],
  pull_request: { url: "https://api.github.com/repos/acme/widgets/pulls/7" },
  html_url: "https://github.com/acme/widgets/pull/7",
};

const OCTOCAT = { id: 42, login: "octocat" };
const DISCUSSION_URL = "https://github.com/acme/widgets/discussions/3";
const DISCUSSION_COMMENT_URL = `${DISCUSSION_URL}#discussioncomment-501`;
const RELEASE_URL = "https://github.com/acme/widgets/releases/tag/v1.0.0";

function issueComment(body: string, updatedAt = COMMENT_UPDATED, issueNumber = 5) {
  return {
    id: issueNumber === 5 ? 33 : 21,
    user: BOT,
    body,
    updated_at: updatedAt,
    issue_url: `https://api.github.com/repos/acme/widgets/issues/${issueNumber}`,
    html_url: `https://github.com/acme/widgets/issues/${issueNumber}#issuecomment-33`,
  };
}

function discussionNode(overrides: Record<string, unknown> = {}) {
  return {
    repository: {
      discussion: {
        id: "D_1",
        number: 3,
        url: DISCUSSION_URL,
        closed: false,
        updatedAt: DISCUSSION_UPDATED,
        answer: null,
        ...overrides,
      },
    },
  };
}

function discussionComments(nodes: unknown[]) {
  return { repository: { discussion: { comments: { pageInfo: { hasNextPage: false }, nodes } } } };
}

function discussionComment(body: string, updatedAt = COMMENT_UPDATED) {
  return { id: "DC_1", databaseId: 501, body, url: DISCUSSION_COMMENT_URL, updatedAt, author: BOT };
}

function release(overrides: Record<string, unknown> = {}) {
  return {
    id: 77,
    node_id: "RE_1",
    tag_name: "v1.0.0",
    target_commitish: HEAD,
    name: "Release 1.0.0",
    body: "Notes",
    draft: true,
    prerelease: false,
    html_url: RELEASE_URL,
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* Scenario table                                                              */
/* -------------------------------------------------------------------------- */

interface Scenario {
  operation: Operation;
  /** Handlers for a first attempt that must apply the effect. */
  apply: Handler[];
  /** Handlers for a retry where the effect already exists. */
  duplicate: Handler[];
  outputs?: Record<string, unknown>;
  resourceUrl?: string;
}

const COMMIT_OPERATION = operationSchema.parse({
  schemaVersion: "v2",
  repository: REPOSITORY,
  id: "op-commit",
  kind: "commit.create",
  branch: "gardener/feature",
  expectedHeadSha: HEAD,
  message: "Apply Gardener changes",
  files: [{ path: "src/a.ts", captured: CAPTURED_FILE }],
});
const COMMIT_MARKER = `Gardener-Operation: op-commit:${canonicalOperationHash(COMMIT_OPERATION)}`;

const scenarios: Record<string, Scenario> = {
  "issue.label.add": {
    operation: operationSchema.parse({ ...issueBase, id: "op-label-add", kind: "issue.label.add", label: "bug" }),
    apply: [
      get(`${REPO}/issues/5`, OPEN_ISSUE),
      get(`${REPO}/labels/bug`, { id: 1, name: "bug" }),
      send("POST", `${REPO}/issues/5/labels`, [{ name: "bug" }]),
    ],
    duplicate: [get(`${REPO}/issues/5`, { ...OPEN_ISSUE, labels: [{ name: "bug" }] })],
    outputs: { issueNumber: 5, label: "bug", labels: ["bug"] },
  },
  "issue.label.remove": {
    operation: operationSchema.parse({ ...issueBase, id: "op-label-remove", kind: "issue.label.remove", label: "bug" }),
    apply: [
      get(`${REPO}/issues/5`, { ...OPEN_ISSUE, labels: [{ name: "bug" }] }),
      send("DELETE", `${REPO}/issues/5/labels/bug`, []),
    ],
    duplicate: [get(`${REPO}/issues/5`, OPEN_ISSUE)],
    outputs: { label: "bug", labels: [] },
  },
  "issue.comment.create": {
    operation: operationSchema.parse({
      ...issueBase,
      id: "op-issue-comment",
      kind: "issue.comment.create",
      body: marked("op-issue-comment", "Triage summary"),
    }),
    apply: [
      get(`${REPO}/issues/5/comments`, []),
      get(`${REPO}/issues/5`, OPEN_ISSUE),
      send("POST", `${REPO}/issues/5/comments`, issueComment(marked("op-issue-comment", "Triage summary"))),
    ],
    duplicate: [get(`${REPO}/issues/5/comments`, [issueComment(marked("op-issue-comment", "Triage summary"))])],
    outputs: { issueNumber: 5, commentId: "33" },
    resourceUrl: "https://github.com/acme/widgets/issues/5#issuecomment-33",
  },
  "issue.comment.update": {
    operation: operationSchema.parse({
      ...issueBase,
      id: "op-issue-comment-update",
      kind: "issue.comment.update",
      commentId: "33",
      expectedCommentUpdatedAt: COMMENT_UPDATED,
      body: "Revised text",
    }),
    apply: [
      get(`${REPO}/issues/comments/33`, issueComment("Stale text")),
      get(`${REPO}/issues/5`, OPEN_ISSUE),
      send("PATCH", `${REPO}/issues/comments/33`, issueComment("Revised text")),
    ],
    duplicate: [get(`${REPO}/issues/comments/33`, issueComment("Revised text"))],
    outputs: { issueNumber: 5, commentId: "33" },
  },
  "issue.close": {
    operation: operationSchema.parse({ ...issueBase, id: "op-issue-close", kind: "issue.close", expectedIssueState: "open" }),
    apply: [get(`${REPO}/issues/5`, OPEN_ISSUE), send("PATCH", `${REPO}/issues/5`, { ...OPEN_ISSUE, state: "closed" })],
    duplicate: [get(`${REPO}/issues/5`, { ...OPEN_ISSUE, state: "closed" })],
    outputs: { state: "closed" },
    resourceUrl: "https://github.com/acme/widgets/issues/5",
  },
  "issue.reopen": {
    operation: operationSchema.parse({ ...issueBase, id: "op-issue-reopen", kind: "issue.reopen", expectedIssueState: "closed" }),
    apply: [
      get(`${REPO}/issues/5`, { ...OPEN_ISSUE, state: "closed" }),
      send("PATCH", `${REPO}/issues/5`, OPEN_ISSUE),
    ],
    duplicate: [get(`${REPO}/issues/5`, OPEN_ISSUE)],
    outputs: { state: "open" },
  },
  "issue.assignee.add": {
    operation: operationSchema.parse({ ...issueBase, id: "op-assignee-add", kind: "issue.assignee.add", assigneeId: "42" }),
    apply: [
      get(`${REPO}/issues/5`, OPEN_ISSUE),
      get("/user/42", OCTOCAT),
      send("POST", `${REPO}/issues/5/assignees`, { ...OPEN_ISSUE, assignees: [OCTOCAT] }),
    ],
    duplicate: [get(`${REPO}/issues/5`, { ...OPEN_ISSUE, assignees: [OCTOCAT] }), get("/user/42", OCTOCAT)],
    outputs: { assigneeId: "42", assigneeLogin: "octocat", assigneeIds: ["42"] },
  },
  "issue.assignee.remove": {
    operation: operationSchema.parse({ ...issueBase, id: "op-assignee-remove", kind: "issue.assignee.remove", assigneeId: "42" }),
    apply: [
      get(`${REPO}/issues/5`, { ...OPEN_ISSUE, assignees: [OCTOCAT] }),
      get("/user/42", OCTOCAT),
      send("DELETE", `${REPO}/issues/5/assignees`, OPEN_ISSUE),
    ],
    duplicate: [get(`${REPO}/issues/5`, OPEN_ISSUE), get("/user/42", OCTOCAT)],
    outputs: { assigneeLogin: "octocat", assigneeIds: [] },
  },
  "pull_request.comment.create": {
    operation: operationSchema.parse({
      ...pullBase,
      id: "op-pull-comment",
      kind: "pull_request.comment.create",
      body: "Review note",
    }),
    apply: [
      get(`${REPO}/issues/7/comments`, []),
      get(`${REPO}/pulls/7`, OPEN_PULL),
      send("POST", `${REPO}/issues/7/comments`, issueComment("Review note", COMMENT_UPDATED, 7)),
    ],
    duplicate: [get(`${REPO}/issues/7/comments`, [issueComment("Review note", COMMENT_UPDATED, 7)])],
    outputs: { pullNumber: 7, commentId: "21" },
  },
  "pull_request.comment.update": {
    operation: operationSchema.parse({
      ...pullBase,
      id: "op-pull-comment-update",
      kind: "pull_request.comment.update",
      commentId: "21",
      expectedCommentUpdatedAt: COMMENT_UPDATED,
      body: "Updated review note",
    }),
    apply: [
      get(`${REPO}/issues/comments/21`, issueComment("Old note", COMMENT_UPDATED, 7)),
      get(`${REPO}/pulls/7`, OPEN_PULL),
      send("PATCH", `${REPO}/issues/comments/21`, issueComment("Updated review note", COMMENT_UPDATED, 7)),
    ],
    duplicate: [get(`${REPO}/issues/comments/21`, issueComment("Updated review note", COMMENT_UPDATED, 7))],
    outputs: { pullNumber: 7, commentId: "21" },
  },
  "pull_request.review.submit": {
    operation: operationSchema.parse({
      ...pullBase,
      id: "op-review",
      kind: "pull_request.review.submit",
      expectedState: "open",
      event: "comment",
      body: marked("op-review", "Looks reasonable"),
      comments: [],
    }),
    apply: [
      get(`${REPO}/pulls/7/reviews`, []),
      get(`${REPO}/pulls/7`, OPEN_PULL),
      send("POST", `${REPO}/pulls/7/reviews`, {
        id: 55,
        state: "COMMENTED",
        html_url: "https://github.com/acme/widgets/pull/7#pullrequestreview-55",
      }),
    ],
    duplicate: [
      get(`${REPO}/pulls/7/reviews`, [{
        id: 55,
        user: BOT,
        state: "COMMENTED",
        commit_id: HEAD,
        body: marked("op-review", "Looks reasonable"),
        html_url: "https://github.com/acme/widgets/pull/7#pullrequestreview-55",
      }]),
    ],
    outputs: { reviewId: "55", reviewState: "COMMENTED" },
  },
  "pull_request.reviewer.request": {
    operation: operationSchema.parse({
      ...pullBase,
      id: "op-reviewer-add",
      kind: "pull_request.reviewer.request",
      reviewerIds: ["42"],
    }),
    apply: [
      get(`${REPO}/pulls/7`, OPEN_PULL),
      get("/user/42", OCTOCAT),
      send("POST", `${REPO}/pulls/7/requested_reviewers`, { ...OPEN_PULL, requested_reviewers: [OCTOCAT] }),
    ],
    duplicate: [get(`${REPO}/pulls/7`, { ...OPEN_PULL, requested_reviewers: [OCTOCAT] }), get("/user/42", OCTOCAT)],
    outputs: { reviewerIds: ["42"], reviewerLogins: ["octocat"] },
  },
  "pull_request.reviewer.remove": {
    operation: operationSchema.parse({
      ...pullBase,
      id: "op-reviewer-remove",
      kind: "pull_request.reviewer.remove",
      reviewerIds: ["42"],
    }),
    apply: [
      get(`${REPO}/pulls/7`, { ...OPEN_PULL, requested_reviewers: [OCTOCAT] }),
      get("/user/42", OCTOCAT),
      send("DELETE", `${REPO}/pulls/7/requested_reviewers`, OPEN_PULL),
    ],
    duplicate: [get(`${REPO}/pulls/7`, OPEN_PULL), get("/user/42", OCTOCAT)],
    outputs: { reviewerLogins: ["octocat"] },
  },
  "pull_request.update": {
    operation: operationSchema.parse({ ...pullBase, id: "op-pull-update", kind: "pull_request.update", title: "Renamed" }),
    apply: [get(`${REPO}/pulls/7`, OPEN_PULL), send("PATCH", `${REPO}/pulls/7`, { ...OPEN_PULL, title: "Renamed" })],
    duplicate: [get(`${REPO}/pulls/7`, { ...OPEN_PULL, title: "Renamed" })],
    outputs: { pullNumber: 7, title: "Renamed", state: "open", draft: false },
  },
  "branch.create": {
    operation: operationSchema.parse({
      schemaVersion: "v2",
      repository: REPOSITORY,
      id: "op-branch",
      kind: "branch.create",
      branch: "gardener/feature",
      fromSha: HEAD,
      expectedAbsent: true,
    }),
    apply: [
      get(`${REPO}/git/ref/heads/gardener/feature`, {}, 404),
      send("POST", `${REPO}/git/refs`, { object: { sha: HEAD } }),
    ],
    duplicate: [get(`${REPO}/git/ref/heads/gardener/feature`, { object: { sha: HEAD } })],
    outputs: { branch: "gardener/feature", ref: "refs/heads/gardener/feature", commitSha: HEAD },
  },
  "commit.create": {
    operation: COMMIT_OPERATION,
    apply: [
      get(`${REPO}/git/ref/heads/gardener/feature`, { object: { sha: HEAD } }),
      get(`${REPO}/git/commits/${HEAD}`, { tree: { sha: PARENT_TREE } }),
      get(`${REPO}/git/trees/${PARENT_TREE}`, {
        tree: [{ path: "src/a.ts", type: "blob", mode: "100644" }],
        truncated: false,
      }),
      send("POST", `${REPO}/git/blobs`, { sha: BLOB }),
      send("POST", `${REPO}/git/trees`, { sha: NEW_TREE }),
      send("POST", `${REPO}/git/commits`, { sha: NEW_COMMIT }),
      send("PATCH", `${REPO}/git/refs/heads/gardener/feature`, { object: { sha: NEW_COMMIT } }),
    ],
    duplicate: [
      get(`${REPO}/git/ref/heads/gardener/feature`, { object: { sha: NEW_COMMIT } }),
      get(`${REPO}/commits`, [{
        sha: NEW_COMMIT,
        commit: { message: `Apply Gardener changes\n\n${COMMIT_MARKER}`, tree: { sha: NEW_TREE } },
        parents: [{ sha: HEAD }],
      }]),
    ],
    outputs: { branch: "gardener/feature", commitSha: NEW_COMMIT, treeSha: NEW_TREE, parentSha: HEAD },
  },
  "pull_request.open_draft": {
    operation: operationSchema.parse({
      schemaVersion: "v2",
      repository: REPOSITORY,
      id: "op-draft-pr",
      kind: "pull_request.open_draft",
      head: "gardener/feature",
      base: "main",
      expectedHeadSha: HEAD,
      expectedBaseSha: BASE,
      title: "Gardener changes",
      body: marked("op-draft-pr", "Automated changes"),
      draft: true,
    }),
    apply: [
      get(`${REPO}/pulls`, []),
      get(`${REPO}/git/ref/heads/gardener/feature`, { object: { sha: HEAD } }),
      get(`${REPO}/git/ref/heads/main`, { object: { sha: BASE } }),
      send("POST", `${REPO}/pulls`, {
        number: 12,
        node_id: "PR_new",
        head: { sha: HEAD },
        base: { ref: "main", sha: BASE },
        html_url: "https://github.com/acme/widgets/pull/12",
      }),
    ],
    duplicate: [
      get(`${REPO}/pulls`, [{
        number: 12,
        node_id: "PR_new",
        user: BOT,
        state: "open",
        draft: true,
        title: "Gardener changes",
        body: marked("op-draft-pr", "Automated changes"),
        head: { sha: HEAD },
        base: { ref: "main" },
        html_url: "https://github.com/acme/widgets/pull/12",
      }]),
    ],
    outputs: { pullNumber: 12, pullNodeId: "PR_new", headRef: "gardener/feature", baseRef: "main" },
  },
  "pull_request.merge": {
    operation: operationSchema.parse({
      ...pullBase,
      id: "op-merge",
      kind: "pull_request.merge",
      expectedState: "open",
      expectedDraft: false,
      method: "squash",
      requiredChecks: [{ context: "ci", appId: 15368 }],
      expectedBranchProtectionHash: PROTECTION_HASH,
    }),
    apply: [
      get(REPO, { allow_squash_merge: true }),
      get(`${REPO}/commits/${HEAD}/check-runs`, {
        check_runs: [{ name: "ci", conclusion: "success", app: { id: 15368 } }],
      }),
      get(`${REPO}/commits/${HEAD}/status`, { statuses: [] }),
      get(`${REPO}/pulls/7`, OPEN_PULL),
      send("PUT", `${REPO}/pulls/7/merge`, { merged: true, sha: MERGE_SHA }),
    ],
    duplicate: [get(`${REPO}/pulls/7`, { ...OPEN_PULL, merged: true, merge_commit_sha: MERGE_SHA })],
    outputs: { pullNumber: 7, mergeCommitSha: MERGE_SHA },
  },
  "discussion.comment.create": {
    operation: operationSchema.parse({
      ...discussionBase,
      id: "op-discussion-comment",
      kind: "discussion.comment.create",
      body: "Helpful answer",
    }),
    apply: [
      gql("comments(first:100", discussionComments([])),
      gql("answer{ id databaseId }", discussionNode()),
      gql("{addDiscussionComment", {
        addDiscussionComment: { comment: { id: "DC_1", databaseId: 501, url: DISCUSSION_COMMENT_URL } },
      }),
    ],
    duplicate: [gql("comments(first:100", discussionComments([discussionComment("Helpful answer")]))],
    outputs: { discussionNumber: 3, commentId: "501", commentNodeId: "DC_1" },
  },
  "discussion.comment.update": {
    operation: operationSchema.parse({
      ...discussionBase,
      id: "op-discussion-comment-update",
      kind: "discussion.comment.update",
      commentId: "501",
      expectedCommentUpdatedAt: COMMENT_UPDATED,
      body: "Corrected answer",
    }),
    apply: [
      gql("comments(first:100", discussionComments([discussionComment("Stale answer")])),
      gql("answer{ id databaseId }", discussionNode()),
      gql("{updateDiscussionComment", {
        updateDiscussionComment: { comment: { id: "DC_1", databaseId: 501, url: DISCUSSION_COMMENT_URL, body: "Corrected answer" } },
      }),
    ],
    duplicate: [gql("comments(first:100", discussionComments([discussionComment("Corrected answer")]))],
    outputs: { commentId: "501", commentNodeId: "DC_1" },
  },
  "discussion.answer.mark": {
    operation: operationSchema.parse({
      ...discussionBase,
      id: "op-answer-mark",
      kind: "discussion.answer.mark",
      answerCommentId: "501",
      expectedAnswerCommentId: null,
    }),
    apply: [
      gql("answer{ id databaseId }", discussionNode()),
      gql("comments(first:100", discussionComments([discussionComment("Helpful answer")])),
      gql("{markDiscussionCommentAsAnswer", { markDiscussionCommentAsAnswer: { discussion: { id: "D_1" } } }),
    ],
    duplicate: [gql("answer{ id databaseId }", discussionNode({ answer: { id: "DC_1", databaseId: 501 } }))],
    outputs: { discussionNumber: 3, answerCommentId: "501" },
  },
  "discussion.answer.unmark": {
    operation: operationSchema.parse({
      ...discussionBase,
      id: "op-answer-unmark",
      kind: "discussion.answer.unmark",
      expectedAnswerCommentId: "501",
    }),
    apply: [
      gql("answer{ id databaseId }", discussionNode({ answer: { id: "DC_1", databaseId: 501 } })),
      gql("{unmarkDiscussionCommentAsAnswer", { unmarkDiscussionCommentAsAnswer: { discussion: { id: "D_1" } } }),
    ],
    duplicate: [gql("answer{ id databaseId }", discussionNode())],
    outputs: { answerCommentId: null },
  },
  "discussion.close": {
    operation: operationSchema.parse({
      ...discussionBase,
      id: "op-discussion-close",
      kind: "discussion.close",
      expectedDiscussionState: "open",
    }),
    apply: [
      gql("answer{ id databaseId }", discussionNode()),
      gql("closeDiscussion", { closeDiscussion: { discussion: { id: "D_1", closed: true, url: DISCUSSION_URL } } }),
    ],
    duplicate: [gql("answer{ id databaseId }", discussionNode({ closed: true }))],
    outputs: { state: "closed", discussionUrl: DISCUSSION_URL },
  },
  "discussion.reopen": {
    operation: operationSchema.parse({
      ...discussionBase,
      id: "op-discussion-reopen",
      kind: "discussion.reopen",
      expectedDiscussionState: "closed",
    }),
    apply: [
      gql("answer{ id databaseId }", discussionNode({ closed: true })),
      gql("reopenDiscussion", { reopenDiscussion: { discussion: { id: "D_1", closed: false, url: DISCUSSION_URL } } }),
    ],
    duplicate: [gql("answer{ id databaseId }", discussionNode())],
    outputs: { state: "open" },
  },
  "check.rerun": {
    operation: operationSchema.parse({
      schemaVersion: "v2",
      repository: REPOSITORY,
      id: "op-check-rerun",
      kind: "check.rerun",
      checkRunId: "99",
      expectedHeadSha: HEAD,
      expectedStatus: "completed",
      expectedConclusion: "failure",
    }),
    apply: [
      get(`${REPO}/check-runs/99`, COMPLETED_CHECK),
      get(`${REPO}/commits/${HEAD}/check-runs`, { total_count: 1, check_runs: [COMPLETED_CHECK] }),
      send("POST", `${REPO}/check-runs/99/rerequest`, {}, 201),
    ],
    duplicate: [get(`${REPO}/check-runs/99`, { ...COMPLETED_CHECK, status: "in_progress", conclusion: null })],
    outputs: { checkRunId: "99", headSha: HEAD },
  },
  "release.create": {
    operation: operationSchema.parse({
      schemaVersion: "v2",
      repository: REPOSITORY,
      id: "op-release-create",
      kind: "release.create",
      tagName: "v1.0.0",
      targetCommitSha: HEAD,
      expectedTagAbsent: true,
      name: "Release 1.0.0",
      body: "Notes",
      draft: true,
      prerelease: false,
    }),
    apply: [
      get(`${REPO}/releases`, []),
      get(`${REPO}/git/ref/tags/v1.0.0`, {}, 404),
      send("POST", `${REPO}/releases`, release()),
    ],
    duplicate: [get(`${REPO}/releases`, [release()])],
    outputs: { releaseId: "77", tagName: "v1.0.0", draft: true, prerelease: false },
    resourceUrl: RELEASE_URL,
  },
  "release.update": {
    operation: operationSchema.parse({
      schemaVersion: "v2",
      repository: REPOSITORY,
      id: "op-release-update",
      kind: "release.update",
      releaseId: "77",
      expectedTagName: "v1.0.0",
      expectedTargetCommitSha: HEAD,
      expectedDraft: true,
      expectedPrerelease: false,
      expectedReleaseUpdatedAt: RELEASE_UPDATED,
      name: "Release 1.0.1",
    }),
    apply: [
      get(`${REPO}/releases/77`, release()),
      gql("on Release", { node: { updatedAt: RELEASE_UPDATED } }),
      send("PATCH", `${REPO}/releases/77`, release({ name: "Release 1.0.1" })),
    ],
    duplicate: [get(`${REPO}/releases/77`, release({ name: "Release 1.0.1" }))],
    outputs: { releaseId: "77", draft: true },
  },
  "release.publish": {
    operation: operationSchema.parse({
      schemaVersion: "v2",
      repository: REPOSITORY,
      id: "op-release-publish",
      kind: "release.publish",
      releaseId: "77",
      expectedTagName: "v1.0.0",
      expectedTargetCommitSha: HEAD,
      expectedDraft: true,
      expectedPrerelease: false,
      expectedPublished: false,
      expectedReleaseUpdatedAt: RELEASE_UPDATED,
    }),
    apply: [
      get(`${REPO}/releases/77`, release()),
      gql("on Release", { node: { updatedAt: RELEASE_UPDATED } }),
      send("PATCH", `${REPO}/releases/77`, release({ draft: false })),
    ],
    duplicate: [get(`${REPO}/releases/77`, release({ draft: false }))],
    outputs: { releaseId: "77", draft: false },
  },
  "release.delete": {
    operation: operationSchema.parse({
      schemaVersion: "v2",
      repository: REPOSITORY,
      id: "op-release-delete",
      kind: "release.delete",
      releaseId: "77",
      expectedTagName: "v1.0.0",
      expectedTargetCommitSha: HEAD,
      expectedDraft: false,
      expectedPublished: true,
      expectedReleaseUpdatedAt: RELEASE_UPDATED,
    }),
    apply: [
      get(`${REPO}/releases/77`, release({ draft: false })),
      gql("on Release", { node: { updatedAt: RELEASE_UPDATED } }),
      send("DELETE", `${REPO}/releases/77`, null, 204),
    ],
    duplicate: [get(`${REPO}/releases/77`, {}, 404)],
    outputs: { releaseId: "77", tagName: "v1.0.0" },
  },
};

function scenarioFor(kind: string): Scenario {
  const scenario = scenarios[kind];
  if (!scenario) throw new Error(`No scenario registered for ${kind}`);
  return scenario;
}

/* -------------------------------------------------------------------------- */
/* Table-driven dispatch coverage                                              */
/* -------------------------------------------------------------------------- */

describe("executeActionsOperation dispatch", () => {
  it("covers every canonical operation kind", () => {
    expect(Object.keys(scenarios).sort()).toEqual([...operationKindValues].sort());
  });

  for (const [kind, scenario] of Object.entries(scenarios)) {
    it(`applies ${kind} and reports succeeded`, async () => {
      const { receipt, outputs } = await run(scenario.operation, scenario.apply);
      expect(receipt.status, JSON.stringify(receipt.error)).toBe("succeeded");
      expect(receipt.kind).toBe(kind);
      expect(receipt.operationId).toBe(scenario.operation.id);
      expect(receipt.operationHash).toBe(canonicalOperationHash(scenario.operation));
      expect(receipt.attempt).toBe(1);
      expect(receipt.error).toBeUndefined();
      expect(outputs?.kind).toBe(kind);
      if (scenario.outputs) expect(outputs).toMatchObject(scenario.outputs);
      if (scenario.resourceUrl) expect(receipt.resourceUrl).toBe(scenario.resourceUrl);
    });

    it(`reconciles an already-applied ${kind} as skipped`, async () => {
      const { receipt, outputs, calls } = await run(scenario.operation, scenario.duplicate);
      expect(receipt.status, JSON.stringify(receipt.error)).toBe("skipped");
      expect(receipt.error).toBeUndefined();
      expect(outputs?.kind).toBe(kind);
      // Reconciliation must never issue a state-changing request.
      const mutating = calls.filter((call) => {
        if (call.path === "/graphql") return /^\s*mutation\b/.test(String((call.body as { query: string }).query));
        return call.method !== "GET" && call.method !== "HEAD";
      });
      expect(mutating).toEqual([]);
    });
  }
});

/* -------------------------------------------------------------------------- */
/* Conflict classification                                                     */
/* -------------------------------------------------------------------------- */

describe("precondition conflicts", () => {
  it("conflicts when the issue changed after planning", async () => {
    const { receipt } = await run(scenarioFor("issue.label.add").operation, [
      get(`${REPO}/issues/5`, { ...OPEN_ISSUE, updated_at: "2026-01-09T00:00:00Z" }),
    ]);
    expect(receipt.status).toBe("conflicted");
    expect(receipt.error?.code).toBe("issue_changed");
    expect(receipt.error?.retryable).toBe(false);
  });

  it("adds a comment to a thread that moved since planning, without extending the version chain", async () => {
    const moved = "2026-01-09T00:00:00Z";
    const issue = scenarioFor("issue.comment.create");
    const onIssue = await run(issue.operation, [
      get(`${REPO}/issues/5/comments`, []),
      get(`${REPO}/issues/5`, { ...OPEN_ISSUE, updated_at: moved }),
      send("POST", `${REPO}/issues/5/comments`, issueComment(marked("op-issue-comment", "Triage summary"))),
    ], { readBackVersion: true });
    expect(onIssue.receipt.status, JSON.stringify(onIssue.receipt.error)).toBe("succeeded");
    // Someone else moved the issue, so a later exact step must not inherit a version it never checked.
    expect(onIssue.resourceVersion).toBeUndefined();

    const onPull = await run(scenarioFor("pull_request.comment.create").operation, [
      get(`${REPO}/issues/7/comments`, []),
      get(`${REPO}/pulls/7`, { ...OPEN_PULL, updated_at: moved }),
      send("POST", `${REPO}/issues/7/comments`, issueComment("Review note", COMMENT_UPDATED, 7)),
    ]);
    expect(onPull.receipt.status, JSON.stringify(onPull.receipt.error)).toBe("succeeded");

    const onDiscussion = await run(scenarioFor("discussion.comment.create").operation, [
      gql("comments(first:100", discussionComments([])),
      gql("answer{ id databaseId }", discussionNode({ updatedAt: moved })),
      gql("{addDiscussionComment", {
        addDiscussionComment: { comment: { id: "DC_1", databaseId: 501, url: DISCUSSION_COMMENT_URL } },
      }),
    ]);
    expect(onDiscussion.receipt.status, JSON.stringify(onDiscussion.receipt.error)).toBe("succeeded");
  });

  it("still refuses a comment when the thread's state or pull request revision changed", async () => {
    const pull = await run(scenarioFor("pull_request.comment.create").operation, [
      get(`${REPO}/issues/7/comments`, []),
      get(`${REPO}/pulls/7`, { ...OPEN_PULL, head: { ...OPEN_PULL.head, sha: NEW_COMMIT } }),
    ]);
    expect(pull.receipt.status).toBe("conflicted");
    expect(pull.receipt.error?.code).toBe("pull_head_changed");
    const discussion = await run(scenarioFor("discussion.comment.create").operation, [
      gql("comments(first:100", discussionComments([])),
      gql("answer{ id databaseId }", discussionNode({ closed: true })),
    ]);
    expect(discussion.receipt.status).toBe("conflicted");
    expect(discussion.receipt.error?.code).toBe("discussion_state_changed");
  });

  it("refuses a comment on a locked conversation as a conflict", async () => {
    const issue = await run(scenarioFor("issue.comment.create").operation, [
      get(`${REPO}/issues/5/comments`, []),
      get(`${REPO}/issues/5`, { ...OPEN_ISSUE, locked: true, updated_at: "2026-01-09T00:00:00Z" }),
    ]);
    expect(issue.receipt.status).toBe("conflicted");
    expect(issue.receipt.error?.code).toBe("issue_locked");
    const pull = await run(scenarioFor("pull_request.comment.create").operation, [
      get(`${REPO}/issues/7/comments`, []),
      get(`${REPO}/pulls/7`, { ...OPEN_PULL, locked: true }),
    ]);
    expect(pull.receipt.status).toBe("conflicted");
    expect(pull.receipt.error?.code).toBe("pull_locked");
  });

  it("conflicts when the issue state changed after planning", async () => {
    const { receipt } = await run(scenarioFor("issue.comment.create").operation, [
      get(`${REPO}/issues/5/comments`, []),
      get(`${REPO}/issues/5`, { ...OPEN_ISSUE, state: "closed" }),
    ]);
    expect(receipt.status).toBe("conflicted");
    expect(receipt.error?.code).toBe("issue_state_changed");
  });

  it("conflicts when a branch already exists at a different commit", async () => {
    const { receipt } = await run(scenarioFor("branch.create").operation, [
      get(`${REPO}/git/ref/heads/gardener/feature`, { object: { sha: NEW_COMMIT } }),
    ]);
    expect(receipt.status).toBe("conflicted");
    expect(receipt.error?.code).toBe("branch_exists");
  });

  it("conflicts when the branch head moved without a Gardener marker", async () => {
    const { receipt } = await run(COMMIT_OPERATION, [
      get(`${REPO}/git/ref/heads/gardener/feature`, { object: { sha: NEW_COMMIT } }),
      get(`${REPO}/commits`, [{ sha: NEW_COMMIT, commit: { message: "Unrelated work" }, parents: [{ sha: HEAD }] }]),
    ]);
    expect(receipt.status).toBe("conflicted");
    expect(receipt.error?.code).toBe("branch_head_changed");
  });

  it("accepts only capture-backed commit content", () => {
    for (const file of [
      { path: "src/a.ts", contentBase64: "Y29uc3QgYSA9IDE7" },
      { path: "src/a.ts", contentBase64: null },
      { path: "src/a.ts", captured: CAPTURED_FILE, contentBase64: "Y29uc3QgYSA9IDE7" },
    ]) {
      expect(() => operationSchema.parse({ ...COMMIT_OPERATION, files: [file] })).toThrow();
    }
  });

  it("requires a capture reader for commits that write content", async () => {
    const { fetchImpl, calls } = harness([]);
    const { readCapturedFile: _reader, ...withoutReader } = context(fetchImpl, COMMIT_OPERATION);
    const { receipt } = await executeActionsOperation(COMMIT_OPERATION, withoutReader);
    expect(receipt.status).toBe("failed");
    expect(calls).toHaveLength(0);
  });

  it("refuses to delete a path absent from the parent tree", async () => {
    const operation = operationSchema.parse({
      ...COMMIT_OPERATION,
      id: "op-commit-delete",
      files: [{ path: "src/gone.ts", captured: { status: "deleted" } }],
    });
    const { receipt } = await run(operation, [
      get(`${REPO}/git/ref/heads/gardener/feature`, { object: { sha: HEAD } }),
      get(`${REPO}/git/commits/${HEAD}`, { tree: { sha: PARENT_TREE } }),
      get(`${REPO}/git/trees/${PARENT_TREE}`, { tree: [], truncated: false }),
    ]);
    expect(receipt.status).toBe("conflicted");
    expect(receipt.error?.code).toBe("delete_target_missing");
  });

  it("refuses a truncated parent tree rather than writing a partial commit", async () => {
    const { receipt } = await run(COMMIT_OPERATION, [
      get(`${REPO}/git/ref/heads/gardener/feature`, { object: { sha: HEAD } }),
      get(`${REPO}/git/commits/${HEAD}`, { tree: { sha: PARENT_TREE } }),
      get(`${REPO}/git/trees/${PARENT_TREE}`, { tree: [], truncated: true }),
    ]);
    expect(receipt.status).toBe("failed");
    expect(receipt.error?.code).toBe("github_tree_truncated");
  });

  it("refuses to update a comment authored by another identity", async () => {
    const { receipt } = await run(scenarioFor("issue.comment.update").operation, [
      get(`${REPO}/issues/comments/33`, { ...issueComment("Stale text"), user: { login: "someone-else" } }),
    ]);
    expect(receipt.status).toBe("conflicted");
    expect(receipt.error?.code).toBe("comment_not_owned");
  });

  it("refuses a comment that belongs to a different issue", async () => {
    const { receipt } = await run(scenarioFor("issue.comment.update").operation, [
      get(`${REPO}/issues/comments/33`, { ...issueComment("Stale text"), issue_url: "https://api.github.com/repos/acme/widgets/issues/99" }),
    ]);
    expect(receipt.status).toBe("conflicted");
    expect(receipt.error?.code).toBe("comment_out_of_scope");
  });

  it("conflicts when the comment changed after planning", async () => {
    const { receipt } = await run(scenarioFor("issue.comment.update").operation, [
      get(`${REPO}/issues/comments/33`, issueComment("Stale text", "2026-01-09T00:00:00Z")),
      get(`${REPO}/issues/5`, OPEN_ISSUE),
    ]);
    expect(receipt.status).toBe("conflicted");
    expect(receipt.error?.code).toBe("comment_changed");
  });

  it("conflicts when GitHub silently ignores an assignee", async () => {
    const { receipt } = await run(scenarioFor("issue.assignee.add").operation, [
      get(`${REPO}/issues/5`, OPEN_ISSUE),
      get("/user/42", OCTOCAT),
      send("POST", `${REPO}/issues/5/assignees`, OPEN_ISSUE),
    ]);
    expect(receipt.status).toBe("conflicted");
    expect(receipt.error?.code).toBe("assignee_not_applied");
  });

  it("conflicts when a reviewer request is silently dropped", async () => {
    const { receipt } = await run(scenarioFor("pull_request.reviewer.request").operation, [
      get(`${REPO}/pulls/7`, OPEN_PULL),
      get("/user/42", OCTOCAT),
      send("POST", `${REPO}/pulls/7/requested_reviewers`, OPEN_PULL),
    ]);
    expect(receipt.status).toBe("conflicted");
    expect(receipt.error?.code).toBe("reviewer_not_applied");
  });

  it("conflicts when the pull request head moved", async () => {
    const { receipt } = await run(scenarioFor("pull_request.update").operation, [
      get(`${REPO}/pulls/7`, { ...OPEN_PULL, head: { sha: NEW_COMMIT, ref: "gardener/feature" } }),
    ]);
    expect(receipt.status).toBe("conflicted");
    expect(receipt.error?.code).toBe("pull_head_changed");
  });

  it("conflicts when required checks are not successful", async () => {
    const { receipt } = await run(scenarioFor("pull_request.merge").operation, [
      get(`${REPO}/pulls/7`, OPEN_PULL),
      get(REPO, { allow_squash_merge: true }),
      get(`${REPO}/commits/${HEAD}/check-runs`, { check_runs: [{ name: "ci", conclusion: "failure", app: { id: 15368 } }] }),
      get(`${REPO}/commits/${HEAD}/status`, { statuses: [] }),
    ]);
    expect(receipt.status).toBe("conflicted");
    expect(receipt.error?.code).toBe("required_checks_incomplete");
  });

  it("refuses a required check that succeeded under a different app", async () => {
    const { receipt } = await run(scenarioFor("pull_request.merge").operation, [
      get(`${REPO}/pulls/7`, OPEN_PULL),
      get(REPO, { allow_squash_merge: true }),
      get(`${REPO}/commits/${HEAD}/check-runs`, { check_runs: [{ name: "ci", conclusion: "success", app: { id: 99 } }] }),
      get(`${REPO}/commits/${HEAD}/status`, { statuses: [{ context: "ci", state: "success" }] }),
    ]);
    expect(receipt.status).toBe("conflicted");
    expect(receipt.error?.code).toBe("required_checks_incomplete");
    expect(receipt.error?.message).toContain("not from App 15368");
  });

  it("conflicts when the requested merge method is disabled", async () => {
    const { receipt } = await run(scenarioFor("pull_request.merge").operation, [
      get(`${REPO}/pulls/7`, OPEN_PULL),
      get(REPO, { allow_squash_merge: false }),
    ]);
    expect(receipt.status).toBe("conflicted");
    expect(receipt.error?.code).toBe("merge_method_disabled");
  });

  it("never reads branch protection, which GITHUB_TOKEN cannot access", async () => {
    const scenario = scenarioFor("pull_request.merge");
    const { receipt, calls } = await run(scenario.operation, scenario.apply);
    expect(receipt.status, JSON.stringify(receipt.error)).toBe("succeeded");
    expect(calls.some((call) => call.path.includes("/protection"))).toBe(false);
  });

  it("conflicts when the discussion answer moved", async () => {
    const { receipt } = await run(scenarioFor("discussion.answer.mark").operation, [
      gql("answer{ id databaseId }", discussionNode({ answer: { id: "DC_9", databaseId: 902 } })),
    ]);
    expect(receipt.status).toBe("conflicted");
    expect(receipt.error?.code).toBe("discussion_answer_changed");
  });

  it("conflicts when the check run head moved", async () => {
    const { receipt } = await run(scenarioFor("check.rerun").operation, [
      get(`${REPO}/check-runs/99`, { ...COMPLETED_CHECK, head_sha: NEW_COMMIT }),
    ]);
    expect(receipt.status).toBe("conflicted");
    expect(receipt.error?.code).toBe("check_head_changed");
  });

  it("conflicts when the check run conclusion changed", async () => {
    const { receipt } = await run(scenarioFor("check.rerun").operation, [
      get(`${REPO}/check-runs/99`, { ...COMPLETED_CHECK, conclusion: "success" }),
      get(`${REPO}/commits/${HEAD}/check-runs`, { total_count: 1, check_runs: [COMPLETED_CHECK] }),
    ]);
    expect(receipt.status).toBe("conflicted");
    expect(receipt.error?.code).toBe("check_conclusion_changed");
  });

  it("conflicts when a release tag already exists", async () => {
    const { receipt } = await run(scenarioFor("release.create").operation, [
      get(`${REPO}/releases`, []),
      get(`${REPO}/git/ref/tags/v1.0.0`, { object: { sha: HEAD } }),
    ]);
    expect(receipt.status).toBe("conflicted");
    expect(receipt.error?.code).toBe("tag_exists");
  });

  it("conflicts when a different release already uses the tag", async () => {
    const { receipt } = await run(scenarioFor("release.create").operation, [
      get(`${REPO}/releases`, [release({ name: "Someone else" })]),
    ]);
    expect(receipt.status).toBe("conflicted");
    expect(receipt.error?.code).toBe("release_exists");
  });

  it("conflicts when the release changed after planning", async () => {
    const { receipt } = await run(scenarioFor("release.publish").operation, [
      get(`${REPO}/releases/77`, release()),
      gql("on Release", { node: { updatedAt: "2026-01-09T00:00:00Z" } }),
    ]);
    expect(receipt.status).toBe("conflicted");
    expect(receipt.error?.code).toBe("release_changed");
  });

  it("conflicts when an issue number actually refers to a pull request", async () => {
    const { receipt } = await run(scenarioFor("issue.label.add").operation, [
      get(`${REPO}/issues/5`, { ...OPEN_ISSUE, pull_request: { url: "https://example.invalid" } }),
    ]);
    expect(receipt.status).toBe("conflicted");
    expect(receipt.error?.code).toBe("resource_kind_mismatch");
  });
});

/* -------------------------------------------------------------------------- */
/* Transport failures and retry classification                                 */
/* -------------------------------------------------------------------------- */

describe("failure classification", () => {
  it("marks 5xx responses retryable", async () => {
    const { receipt } = await run(scenarioFor("issue.label.add").operation, [
      get(`${REPO}/issues/5`, { message: "upstream" }, 503),
    ]);
    expect(receipt.status).toBe("failed");
    expect(receipt.error?.code).toBe("github_unavailable");
    expect(receipt.error?.retryable).toBe(true);
  });

  it("marks rate limiting retryable", async () => {
    const { receipt } = await run(scenarioFor("issue.label.add").operation, [
      get(`${REPO}/issues/5`, { message: "rate limited" }, 429),
    ]);
    expect(receipt.error?.retryable).toBe(true);
  });

  it("marks 403 responses non-retryable failures", async () => {
    const { receipt } = await run(scenarioFor("issue.label.add").operation, [
      get(`${REPO}/issues/5`, { message: "Resource not accessible by integration" }, 403),
    ]);
    expect(receipt.status).toBe("failed");
    expect(receipt.error?.code).toBe("github_http_error");
    expect(receipt.error?.retryable).toBe(false);
    expect(receipt.error?.message).toContain("Resource not accessible by integration");
  });

  it("maps 422 rejections to conflicts", async () => {
    const { receipt } = await run(scenarioFor("issue.label.add").operation, [
      get(`${REPO}/issues/5`, OPEN_ISSUE),
      get(`${REPO}/labels/bug`, { id: 1, name: "bug" }),
      send("POST", `${REPO}/issues/5/labels`, { message: "Validation failed" }, 422),
    ]);
    expect(receipt.status).toBe("conflicted");
    expect(receipt.error?.code).toBe("github_precondition_rejected");
  });

  it("maps GraphQL NOT_FOUND to a conflict when discussions are disabled", async () => {
    const { receipt } = await run(scenarioFor("discussion.close").operation, [{
      when: (call) => call.path === "/graphql",
      json: { errors: [{ type: "NOT_FOUND", message: "Could not resolve to a Discussion" }] },
    }]);
    expect(receipt.status).toBe("conflicted");
    expect(receipt.error?.code).toBe("github_graphql_not_found");
  });

  it("maps GraphQL rate limiting to a retryable failure", async () => {
    const { receipt } = await run(scenarioFor("discussion.close").operation, [{
      when: (call) => call.path === "/graphql",
      json: { errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }] },
    }]);
    expect(receipt.status).toBe("failed");
    expect(receipt.error?.retryable).toBe(true);
  });

  it("records the GitHub request id on both success and failure", async () => {
    const applied = await run(scenarioFor("issue.label.add").operation, scenarioFor("issue.label.add").apply);
    expect(applied.receipt.providerRequestId).toBe("REQ-1");
    const failed = await run(scenarioFor("issue.label.add").operation, [get(`${REPO}/issues/5`, {}, 503)]);
    expect(failed.receipt.providerRequestId).toBe("REQ-1");
  });

  it("stops a runaway idempotency scan at the page ceiling", async () => {
    const { receipt } = await run(scenarioFor("issue.comment.create").operation, [{
      when: (call) => call.method === "GET" && call.path.startsWith(`${REPO}/issues/5/comments`),
      json: Array.from({ length: 100 }, (_, index) => ({ id: index + 1, user: BOT, body: "noise" })),
      headers: { link: '<https://api.github.com/next>; rel="next"' },
    }], { maxPages: 3 });
    expect(receipt.status).toBe("failed");
    expect(receipt.error?.code).toBe("github_pagination_exhausted");
  });
});

/* -------------------------------------------------------------------------- */
/* Authoring and binding guards                                                */
/* -------------------------------------------------------------------------- */

describe("executor guards", () => {
  it("rejects an operation bound to a different repository", async () => {
    const operation = scenarioFor("issue.label.add").operation;
    const { fetchImpl } = harness([]);
    await expect(executeActionsOperation(operation, context(fetchImpl, operation, { repositoryFullName: "evil/repo" })))
      .rejects.toThrow(/not the bound repository/);
  });

  it("rejects a caller hash that drifted from the canonical operation", async () => {
    const operation = scenarioFor("issue.label.add").operation;
    const { fetchImpl } = harness([]);
    await expect(executeActionsOperation(operation, context(fetchImpl, operation, { operationHash: "f".repeat(64) })))
      .rejects.toThrow(/does not match the canonical hash/);
  });

  it("derives the operation hash when the caller supplies none", async () => {
    const scenario = scenarioFor("issue.label.add");
    const { fetchImpl } = harness(scenario.apply);
    const { receipt } = await executeActionsOperation(scenario.operation, {
      token: "ghs_token",
      repositoryFullName: "acme/widgets",
      attempt: 1,
      now: () => new Date("2026-02-01T00:00:00Z"),
      fetch: fetchImpl,
    });
    expect(receipt.operationHash).toBe(canonicalOperationHash(scenario.operation));
  });

  it("rejects an out-of-range attempt counter", async () => {
    const operation = scenarioFor("issue.label.add").operation;
    const { fetchImpl } = harness([]);
    await expect(executeActionsOperation(operation, context(fetchImpl, operation, { attempt: 0 })))
      .rejects.toThrow(/attempt must be/);
  });

  it("rejects a missing token", async () => {
    const operation = scenarioFor("issue.label.add").operation;
    const { fetchImpl } = harness([]);
    await expect(executeActionsOperation(operation, context(fetchImpl, operation, { token: "" })))
      .rejects.toThrow(/GitHub token is required/);
  });

  it("refuses an exact comment body without its operation marker", async () => {
    const operation = operationSchema.parse({
      ...issueBase,
      id: "op-unmarked",
      kind: "issue.comment.create",
      body: "No provenance marker",
    });
    const { receipt, calls } = await run(operation, []);
    expect(receipt.status).toBe("failed");
    expect(receipt.error?.code).toBe("canonical_marker_missing");
    expect(calls).toEqual([]);
  });

  it("refuses to commit to protected repository paths", async () => {
    const operation = operationSchema.parse({
      ...COMMIT_OPERATION,
      id: "op-commit-workflow",
      files: [{ path: ".github/workflows/release.yml", captured: CAPTURED_FILE }],
    });
    const { receipt, calls } = await run(operation, []);
    expect(receipt.status).toBe("failed");
    expect(receipt.error?.code).toBe("protected_commit_path");
    expect(calls).toEqual([]);
  });

  it("never sends the token to a host other than the GitHub API", async () => {
    const scenario = scenarioFor("issue.label.add");
    const seen: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new URL(String(input)).origin);
      const headers = new Headers(init?.headers as HeadersInit);
      expect(headers.get("authorization")).toBe("Bearer ghs_token");
      return new Response(JSON.stringify(OPEN_ISSUE), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    await executeActionsOperation(scenario.operation, context(fetchImpl, scenario.operation));
    expect([...new Set(seen)]).toEqual(["https://api.github.com"]);
  });

  it("honours a non-default writer identity for reconciliation", async () => {
    const scenario = scenarioFor("issue.comment.create");
    const { receipt } = await run(
      scenario.operation,
      [get(`${REPO}/issues/5/comments`, [{
        id: 33,
        user: { login: "gardener[bot]" },
        body: marked("op-issue-comment", "Triage summary"),
        html_url: "https://github.com/acme/widgets/issues/5#issuecomment-33",
      }])],
      { actorLogin: "gardener[bot]" },
    );
    expect(receipt.status).toBe("skipped");
  });

  it("accepts an app-slug attribution when the login differs", async () => {
    const scenario = scenarioFor("issue.comment.create");
    const { receipt } = await run(scenario.operation, [get(`${REPO}/issues/5/comments`, [{
      id: 33,
      user: { login: "some-proxy" },
      performed_via_github_app: { slug: "github-actions" },
      body: marked("op-issue-comment", "Triage summary"),
      html_url: "https://github.com/acme/widgets/issues/5#issuecomment-33",
    }])]);
    expect(receipt.status).toBe("skipped");
  });

  it("never lets completedAt precede attemptedAt under a regressing clock", async () => {
    const scenario = scenarioFor("issue.label.add");
    const times = ["2026-02-01T00:00:05Z", "2026-02-01T00:00:00Z"];
    const { receipt } = await run(scenario.operation, scenario.apply, {
      now: () => new Date(times.shift() ?? "2026-02-01T00:00:00Z"),
    });
    expect(Date.parse(receipt.completedAt)).toBeGreaterThanOrEqual(Date.parse(receipt.attemptedAt));
  });
});

/* -------------------------------------------------------------------------- */
/* Draft transitions and helpers                                               */
/* -------------------------------------------------------------------------- */

describe("draft transitions", () => {
  const readyForReview = operationSchema.parse({
    ...pullBase,
    id: "op-ready",
    kind: "pull_request.update",
    expectedDraft: true,
    draft: false,
  });

  it("marks a draft pull request ready for review through GraphQL", async () => {
    let reads = 0;
    const { receipt, outputs } = await run(readyForReview, [
      {
        when: (call) => call.method === "GET" && call.path === `${REPO}/pulls/7`,
        get json() {
          reads += 1;
          return reads === 1 ? { ...OPEN_PULL, draft: true } : { ...OPEN_PULL, draft: false };
        },
      },
      gql("markPullRequestReadyForReview", { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } }),
    ]);
    expect(receipt.status, JSON.stringify(receipt.error)).toBe("succeeded");
    expect(outputs).toMatchObject({ kind: "pull_request.update", draft: false });
  });

  it("converts a ready pull request back to draft through GraphQL", async () => {
    const operation = operationSchema.parse({
      ...pullBase,
      id: "op-to-draft",
      kind: "pull_request.update",
      expectedDraft: false,
      draft: true,
    });
    let reads = 0;
    const { receipt } = await run(operation, [
      {
        when: (call) => call.method === "GET" && call.path === `${REPO}/pulls/7`,
        get json() {
          reads += 1;
          return reads === 1 ? OPEN_PULL : { ...OPEN_PULL, draft: true };
        },
      },
      gql("convertPullRequestToDraft", { convertPullRequestToDraft: { pullRequest: { isDraft: true } } }),
    ]);
    expect(receipt.status, JSON.stringify(receipt.error)).toBe("succeeded");
  });

  it("reconciles a draft transition that a previous attempt already applied", async () => {
    // The planned expectation says `draft: true`, but the retry observes the
    // post-transition state, which must reconcile instead of self-conflicting.
    const { receipt } = await run(readyForReview, [get(`${REPO}/pulls/7`, { ...OPEN_PULL, draft: false })]);
    expect(receipt.status).toBe("skipped");
  });
});

/* -------------------------------------------------------------------------- */
/* Remediation coverage                                                        */
/* -------------------------------------------------------------------------- */

describe("git ref path encoding", () => {
  // Git ref names may contain `/`, `#`, `%` and `+`. GitHub addresses refs as
  // multi-segment paths, so separators must survive while everything else is
  // percent-encoded.
  const cases: Array<{ branch: string; encoded: string }> = [
    { branch: "gardener/fix/nested/deep", encoded: "gardener/fix/nested/deep" },
    { branch: "gardener/issue-#42", encoded: "gardener/issue-%2342" },
    { branch: "gardener/100%-coverage", encoded: "gardener/100%25-coverage" },
    { branch: "gardener/c++-port", encoded: "gardener/c%2B%2B-port" },
    { branch: "gardener/a+b#c%d/e", encoded: "gardener/a%2Bb%23c%25d/e" },
  ];

  for (const { branch, encoded } of cases) {
    it(`addresses ${branch} as ${encoded}`, async () => {
      const operation = operationSchema.parse({
        schemaVersion: "v2",
        repository: REPOSITORY,
        id: "op-branch-encoding",
        kind: "branch.create",
        branch,
        fromSha: HEAD,
        expectedAbsent: true,
      });
      const { receipt, outputs, calls } = await run(operation, [
        get(`${REPO}/git/ref/heads/${encoded}`, {}, 404),
        send("POST", `${REPO}/git/refs`, { object: { sha: HEAD } }),
      ]);
      expect(receipt.status, JSON.stringify(receipt.error)).toBe("succeeded");
      expect(calls[0]?.path).toBe(`${REPO}/git/ref/heads/${encoded}`);
      // The ref body carries the raw, unencoded name.
      expect(calls[1]?.body).toMatchObject({ ref: `refs/heads/${branch}` });
      expect(outputs).toMatchObject({ branch, ref: `refs/heads/${branch}` });
    });

    it(`reconciles a retry of ${branch} against the same encoded path`, async () => {
      const operation = operationSchema.parse({
        schemaVersion: "v2",
        repository: REPOSITORY,
        id: "op-branch-encoding",
        kind: "branch.create",
        branch,
        fromSha: HEAD,
        expectedAbsent: true,
      });
      const { receipt, calls } = await run(operation, [
        get(`${REPO}/git/ref/heads/${encoded}`, { object: { sha: HEAD } }),
      ]);
      expect(receipt.status).toBe("skipped");
      expect(calls).toHaveLength(1);
    });
  }

  it("fast-forwards a nested branch through the segmented refs path", async () => {
    const branch = "gardener/fix/nested";
    const operation = operationSchema.parse({
      schemaVersion: "v2",
      repository: REPOSITORY,
      id: "op-commit-nested",
      kind: "commit.create",
      branch,
      expectedHeadSha: HEAD,
      message: "Apply Gardener changes",
      files: [{ path: "src/a.ts", captured: CAPTURED_FILE }],
    });
    const { receipt, calls } = await run(operation, [
      get(`${REPO}/git/ref/heads/${branch}`, { object: { sha: HEAD } }),
      get(`${REPO}/git/commits/${HEAD}`, { tree: { sha: PARENT_TREE } }),
      get(`${REPO}/git/trees/${PARENT_TREE}`, { tree: [{ path: "src/a.ts", type: "blob", mode: "100644" }], truncated: false }),
      send("POST", `${REPO}/git/blobs`, { sha: BLOB }),
      send("POST", `${REPO}/git/trees`, { sha: NEW_TREE }),
      send("POST", `${REPO}/git/commits`, { sha: NEW_COMMIT }),
      send("PATCH", `${REPO}/git/refs/heads/${branch}`, { object: { sha: NEW_COMMIT } }),
    ]);
    expect(receipt.status, JSON.stringify(receipt.error)).toBe("succeeded");
    expect(calls.at(-1)?.path).toBe(`${REPO}/git/refs/heads/${branch}`);
  });

  it("encodes a slash-bearing release tag as separate ref segments", async () => {
    const operation = operationSchema.parse({
      schemaVersion: "v2",
      repository: REPOSITORY,
      id: "op-release-nested-tag",
      kind: "release.create",
      tagName: "release/v1.0.0+build",
      targetCommitSha: HEAD,
      expectedTagAbsent: true,
      name: "Release 1.0.0",
      body: "Notes",
      draft: true,
      prerelease: false,
    });
    const { receipt, calls } = await run(operation, [
      get(`${REPO}/releases`, []),
      get(`${REPO}/git/ref/tags/release/v1.0.0%2Bbuild`, {}, 404),
      send("POST", `${REPO}/releases`, release({ tag_name: "release/v1.0.0+build" })),
    ]);
    expect(receipt.status, JSON.stringify(receipt.error)).toBe("succeeded");
    expect(calls[1]?.path).toBe(`${REPO}/git/ref/tags/release/v1.0.0%2Bbuild`);
  });
});

describe("reconcile-before-precondition ordering", () => {
  it("reconciles a pull request update even after the head moved", async () => {
    // A retry must not conflict on a head that advanced after the title landed.
    const { receipt, calls } = await run(scenarioFor("pull_request.update").operation, [
      get(`${REPO}/pulls/7`, {
        ...OPEN_PULL,
        title: "Renamed",
        head: { sha: NEW_COMMIT, ref: "gardener/feature" },
        updated_at: "2026-01-09T00:00:00Z",
      }),
    ]);
    expect(receipt.status, JSON.stringify(receipt.error)).toBe("skipped");
    expect(calls).toHaveLength(1);
  });

  it("still conflicts on a moved head when the update has not been applied", async () => {
    const { receipt } = await run(scenarioFor("pull_request.update").operation, [
      get(`${REPO}/pulls/7`, { ...OPEN_PULL, head: { sha: NEW_COMMIT, ref: "gardener/feature" } }),
    ]);
    expect(receipt.status).toBe("conflicted");
    expect(receipt.error?.code).toBe("pull_head_changed");
  });

  it("refuses to reconcile a draft pull request that was closed", async () => {
    const { receipt } = await run(scenarioFor("pull_request.open_draft").operation, [
      get(`${REPO}/pulls`, [{
        number: 12,
        node_id: "PR_new",
        user: BOT,
        state: "closed",
        draft: true,
        title: "Gardener changes",
        body: marked("op-draft-pr", "Automated changes"),
        head: { sha: HEAD },
        base: { ref: "main" },
        html_url: "https://github.com/acme/widgets/pull/12",
      }]),
    ]);
    expect(receipt.status).toBe("conflicted");
    expect(receipt.error?.code).toBe("pull_request_not_open");
  });
});

describe("path segment safety", () => {
  function labelOperation(kind: "issue.label.add" | "issue.label.remove", label: string): Operation {
    return operationSchema.parse({ ...issueBase, id: "op-label-traversal", kind, label });
  }

  it("demonstrates that an unguarded dot segment would rewrite the request path", () => {
    // This is why encodeSegment rejects rather than percent-encodes: URL
    // normalisation strips dot segments before the request is ever sent.
    // `.` collapses onto the label *collection*, where DELETE clears them all.
    expect(new URL(`https://api.github.com${REPO}/issues/5/labels/${encodeURIComponent(".")}`).pathname)
      .toBe(`${REPO}/issues/5/labels/`);
    // `..` climbs a level entirely, off the labels resource.
    expect(new URL(`https://api.github.com${REPO}/issues/5/labels/${encodeURIComponent("..")}`).pathname)
      .toBe(`${REPO}/issues/5/`);
  });

  for (const label of [".", ".."]) {
    it(`refuses to look up a label named "${label}"`, async () => {
      const { receipt, calls } = await run(labelOperation("issue.label.add", label), []);
      expect(receipt.status).toBe("failed");
      expect(receipt.error?.code).toBe("unsafe_path_segment");
      // Must fail before any I/O: GET /labels/. collapses to the list endpoint,
      // which returns 200 and would satisfy the definition check.
      expect(calls).toEqual([]);
    });

    it(`refuses to remove a label named "${label}" instead of clearing every label`, async () => {
      const { receipt, calls } = await run(labelOperation("issue.label.remove", label), []);
      expect(receipt.status).toBe("failed");
      expect(receipt.error?.code).toBe("unsafe_path_segment");
      // DELETE /issues/5/labels/. collapses to DELETE /issues/5/labels, which
      // removes every label on the issue.
      expect(calls).toEqual([]);
    });
  }

  it("still accepts a label whose name merely contains dots", async () => {
    const operation = labelOperation("issue.label.add", "area/.github");
    const { receipt, calls } = await run(operation, [
      get(`${REPO}/issues/5`, OPEN_ISSUE),
      get(`${REPO}/labels/area%2F.github`, { id: 2, name: "area/.github" }),
      send("POST", `${REPO}/issues/5/labels`, [{ name: "area/.github" }]),
    ]);
    expect(receipt.status, JSON.stringify(receipt.error)).toBe("succeeded");
    // A slash inside a label is one segment, so it stays percent-encoded.
    expect(calls[1]?.path).toBe(`${REPO}/labels/area%2F.github`);
  });

  it("refuses a release tag that would climb the ref path", async () => {
    const operation = operationSchema.parse({
      schemaVersion: "v2",
      repository: REPOSITORY,
      id: "op-release-traversal",
      kind: "release.create",
      tagName: "..",
      targetCommitSha: HEAD,
      expectedTagAbsent: true,
      name: "Release",
      body: "Notes",
      draft: true,
      prerelease: false,
    });
    const { receipt, calls } = await run(operation, [get(`${REPO}/releases`, [])]);
    expect(receipt.status).toBe("failed");
    expect(receipt.error?.code).toBe("unsafe_path_segment");
    expect(calls.every((call) => !call.path.includes("/git/ref"))).toBe(true);
  });

  it("leaves dotted-but-safe ref segments alone", async () => {
    // Branch names cannot traverse (the contract rejects `..` and leading dots)
    // but tag names can, so the ref guard must still pass ordinary version-like
    // segments untouched rather than being overbroad.
    const operation = operationSchema.parse({
      schemaVersion: "v2",
      repository: REPOSITORY,
      id: "op-branch-dotted",
      kind: "branch.create",
      branch: "gardener/v1.2.3",
      fromSha: HEAD,
      expectedAbsent: true,
    });
    const { receipt, calls } = await run(operation, [
      get(`${REPO}/git/ref/heads/gardener/v1.2.3`, {}, 404),
      send("POST", `${REPO}/git/refs`, { object: { sha: HEAD } }),
    ]);
    expect(receipt.status, JSON.stringify(receipt.error)).toBe("succeeded");
    expect(calls[0]?.path).toBe(`${REPO}/git/ref/heads/gardener/v1.2.3`);
  });
});

describe("plan-owned resource versions", () => {
  const labelAdd = () => scenarioFor("issue.label.add");
  const writtenAt = "2026-01-06T00:00:00Z";

  it("accepts the version the plan's own earlier write left", async () => {
    const { receipt } = await run(labelAdd().operation, [
      get(`${REPO}/issues/5`, { ...OPEN_ISSUE, updated_at: writtenAt }),
      get(`${REPO}/labels/bug`, { id: 1, name: "bug" }),
      send("POST", `${REPO}/issues/5/labels`, [{ name: "bug" }]),
    ], { chainedResourceVersion: writtenAt });
    expect(receipt.status, JSON.stringify(receipt.error)).toBe("succeeded");
  });

  it("still conflicts on a version neither planned nor written by the plan", async () => {
    const { receipt } = await run(labelAdd().operation, [
      get(`${REPO}/issues/5`, { ...OPEN_ISSUE, updated_at: "2026-01-07T00:00:00Z" }),
    ], { chainedResourceVersion: writtenAt });
    expect(receipt.status).toBe("conflicted");
    expect(receipt.error?.code).toBe("issue_changed");
  });

  /** Label add whose issue reports `writtenAt` once the label POST has happened. */
  function labelAddWithReadBack(options: { failFirstReadBack?: boolean } = {}): Handler[] {
    let written = false;
    let failed = false;
    return [
      {
        when: (call) => call.method === "GET" && matches(call.path, `${REPO}/issues/5`),
        get status() {
          if (written && options.failFirstReadBack && !failed) { failed = true; return 502; }
          return 200;
        },
        get json() { return written ? { ...OPEN_ISSUE, labels: [{ name: "bug" }], updated_at: writtenAt } : OPEN_ISSUE; },
      },
      get(`${REPO}/labels/bug`, { id: 1, name: "bug" }),
      {
        when: (call) => {
          const hit = call.method === "POST" && matches(call.path, `${REPO}/issues/5/labels`);
          if (hit) written = true;
          return hit;
        },
        json: [{ name: "bug" }],
      },
    ];
  }

  it("reports the version a verified write left its resource at", async () => {
    const { receipt, resourceVersion, calls } = await run(labelAdd().operation, labelAddWithReadBack(), { readBackVersion: true });
    expect(receipt.status).toBe("succeeded");
    expect(resourceVersion).toEqual({ resource: "issue:5", updatedAt: writtenAt });
    expect(calls.at(-1)?.path).toBe(`${REPO}/issues/5`);
  });

  it("retries a transient read-back failure", async () => {
    const { receipt, resourceVersion } = await run(labelAdd().operation, labelAddWithReadBack({ failFirstReadBack: true }), { readBackVersion: true });
    expect(receipt.status).toBe("succeeded");
    expect(resourceVersion).toEqual({ resource: "issue:5", updatedAt: writtenAt });
  });

  it("does not read back unless a later step needs the version", async () => {
    const { receipt, resourceVersion, calls } = await run(labelAdd().operation, labelAddWithReadBack());
    expect(receipt.status).toBe("succeeded");
    expect(resourceVersion).toBeUndefined();
    expect(calls.filter((call) => call.method === "GET" && call.path === `${REPO}/issues/5`)).toHaveLength(1);
  });

  it("never chains from a reconciled step that skipped the version check", async () => {
    // The label is already present, so the executor reconciles before checking
    // updated_at. Its read-back would adopt this third-party edit as the plan's own.
    const { receipt, resourceVersion } = await run(labelAdd().operation, [
      get(`${REPO}/issues/5`, { ...OPEN_ISSUE, labels: [{ name: "bug" }], updated_at: "2026-01-07T00:00:00Z" }),
    ], { readBackVersion: true });
    expect(receipt.status).toBe("skipped");
    expect(resourceVersion).toBeUndefined();
  });

  it("reports no version for a failed step or an operation without a versioned resource", async () => {
    const conflicted = await run(labelAdd().operation, [
      get(`${REPO}/issues/5`, { ...OPEN_ISSUE, updated_at: "2026-01-07T00:00:00Z" }),
    ], { readBackVersion: true });
    expect(conflicted.resourceVersion).toBeUndefined();
    const branch = await run(scenarioFor("branch.create").operation, scenarioFor("branch.create").apply, { readBackVersion: true });
    expect(branch.receipt.status).toBe("succeeded");
    expect(branch.resourceVersion).toBeUndefined();
  });
});

describe("mutation classification", () => {
  it("treats a GraphQL query as read-only despite it being an HTTP POST", async () => {
    const { receipt, calls } = await run(scenarioFor("discussion.close").operation, [
      gql("answer{ id databaseId }", discussionNode({ closed: true })),
    ]);
    expect(receipt.status).toBe("skipped");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
  });

  it("treats a GraphQL mutation as state-changing", async () => {
    const scenario = scenarioFor("discussion.close");
    const { receipt, calls } = await run(scenario.operation, scenario.apply);
    expect(receipt.status).toBe("succeeded");
    expect(calls.every((call) => call.method === "POST")).toBe(true);
  });

  it("records the direct cleanup request issued outside the rest wrappers", async () => {
    // The open_draft revision race closes the pull request through raw(), which
    // is the one mutation that does not go through rest()/restOptional().
    const { receipt, calls } = await run(scenarioFor("pull_request.open_draft").operation, [
      get(`${REPO}/pulls`, []),
      get(`${REPO}/git/ref/heads/gardener/feature`, { object: { sha: HEAD } }),
      get(`${REPO}/git/ref/heads/main`, { object: { sha: BASE } }),
      send("POST", `${REPO}/pulls`, {
        number: 12,
        node_id: "PR_new",
        head: { sha: NEW_COMMIT },
        base: { ref: "main", sha: BASE },
        html_url: "https://github.com/acme/widgets/pull/12",
      }),
      send("PATCH", `${REPO}/pulls/12`, { number: 12, state: "closed" }),
    ]);
    expect(receipt.status).toBe("conflicted");
    expect(receipt.error?.code).toBe("pull_request_revision_race");
    expect(calls.some((call) => call.method === "PATCH" && call.path === `${REPO}/pulls/12`)).toBe(true);
  });
});

describe("label taxonomy safety", () => {
  it("refuses to invent a repository label that does not exist", async () => {
    const { receipt, calls } = await run(scenarioFor("issue.label.add").operation, [
      get(`${REPO}/issues/5`, OPEN_ISSUE),
      get(`${REPO}/labels/bug`, { message: "Not Found" }, 404),
    ]);
    expect(receipt.status).toBe("conflicted");
    expect(receipt.error?.code).toBe("label_not_defined");
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("does not require a label definition when removing", async () => {
    const scenario = scenarioFor("issue.label.remove");
    const { receipt, calls } = await run(scenario.operation, scenario.apply);
    expect(receipt.status).toBe("succeeded");
    expect(calls.some((call) => call.path === `${REPO}/labels/bug`)).toBe(false);
  });
});

describe("discussion actor identity", () => {
  it("reconciles a comment authored under the bare GraphQL bot login", async () => {
    // GraphQL reports `github-actions`, REST reports `github-actions[bot]`.
    const { receipt } = await run(scenarioFor("discussion.comment.create").operation, [
      gql("comments(first:100", discussionComments([
        { ...discussionComment("Helpful answer"), author: GRAPHQL_BOT },
      ])),
    ]);
    expect(receipt.status, JSON.stringify(receipt.error)).toBe("skipped");
  });

  it("updates a comment authored under the bare GraphQL bot login", async () => {
    const { receipt } = await run(scenarioFor("discussion.comment.update").operation, [
      gql("comments(first:100", discussionComments([
        { ...discussionComment("Stale answer"), author: GRAPHQL_BOT },
      ])),
      gql("answer{ id databaseId }", discussionNode()),
      gql("{updateDiscussionComment", {
        updateDiscussionComment: {
          comment: { id: "DC_1", databaseId: 501, url: DISCUSSION_COMMENT_URL, body: "Corrected answer" },
        },
      }),
    ]);
    expect(receipt.status, JSON.stringify(receipt.error)).toBe("succeeded");
  });

  it("still refuses a discussion comment authored by a human", async () => {
    const { receipt } = await run(scenarioFor("discussion.comment.update").operation, [
      gql("comments(first:100", discussionComments([
        { ...discussionComment("Stale answer"), author: { login: "octocat" } },
      ])),
    ]);
    expect(receipt.status).toBe("conflicted");
    expect(receipt.error?.code).toBe("comment_not_owned");
  });
});

describe("check rerun semantics", () => {
  it("conflicts on a check produced by a third-party app", async () => {
    const { receipt, calls } = await run(scenarioFor("check.rerun").operation, [
      get(`${REPO}/check-runs/99`, { ...COMPLETED_CHECK, app: { id: 77, slug: "circleci-checks" } }),
    ]);
    expect(receipt.status).toBe("conflicted");
    expect(receipt.error?.code).toBe("check_not_owned");
    expect(receipt.error?.message).toContain("circleci-checks");
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("conflicts when the check run has no app attribution", async () => {
    const { receipt } = await run(scenarioFor("check.rerun").operation, [
      get(`${REPO}/check-runs/99`, { ...COMPLETED_CHECK, app: undefined }),
    ]);
    expect(receipt.error?.code).toBe("check_not_owned");
  });

  it("reconciles when a prior attempt already produced a newer run", async () => {
    // Re-requesting spawns a new check run; the original stays completed forever.
    const { receipt, outputs } = await run(scenarioFor("check.rerun").operation, [
      get(`${REPO}/check-runs/99`, COMPLETED_CHECK),
      get(`${REPO}/commits/${HEAD}/check-runs`, { total_count: 1, check_runs: [
        COMPLETED_CHECK,
        { ...COMPLETED_CHECK, id: 100, status: "in_progress", conclusion: null, started_at: "2026-01-07T00:00:00Z" },
      ] }),
    ]);
    expect(receipt.status).toBe("skipped");
    expect(outputs).toMatchObject({ checkRunId: "100", status: "in_progress" });
  });

  it("reconciles when a newer completed run exists for the same name", async () => {
    const { receipt, outputs } = await run(scenarioFor("check.rerun").operation, [
      get(`${REPO}/check-runs/99`, COMPLETED_CHECK),
      get(`${REPO}/commits/${HEAD}/check-runs`, { total_count: 1, check_runs: [
        { ...COMPLETED_CHECK, id: 101, conclusion: "success", started_at: "2026-01-08T00:00:00Z" },
      ] }),
    ]);
    expect(receipt.status).toBe("skipped");
    expect(outputs).toMatchObject({ checkRunId: "101" });
  });

  it("does not treat an older sibling run as evidence of a rerun", async () => {
    const { receipt, calls } = await run(scenarioFor("check.rerun").operation, [
      get(`${REPO}/check-runs/99`, COMPLETED_CHECK),
      get(`${REPO}/commits/${HEAD}/check-runs`, { total_count: 1, check_runs: [
        { ...COMPLETED_CHECK, id: 98, started_at: "2025-12-31T00:00:00Z" },
      ] }),
      send("POST", `${REPO}/check-runs/99/rerequest`, {}, 201),
    ]);
    expect(receipt.status, JSON.stringify(receipt.error)).toBe("succeeded");
    expect(calls.some((call) => call.path.endsWith("/rerequest"))).toBe(true);
  });

  it("does not treat a pre-existing in-flight sibling as evidence of a rerun", async () => {
    // An unrelated run of the same name queued before this operation was
    // planned must not silently satisfy it.
    const { receipt, calls } = await run(scenarioFor("check.rerun").operation, [
      get(`${REPO}/check-runs/99`, COMPLETED_CHECK),
      get(`${REPO}/commits/${HEAD}/check-runs`, { total_count: 1, check_runs: [
        { ...COMPLETED_CHECK, id: 98, status: "in_progress", conclusion: null, started_at: "2025-12-31T00:00:00Z" },
      ] }),
      send("POST", `${REPO}/check-runs/99/rerequest`, {}, 201),
    ]);
    expect(receipt.status, JSON.stringify(receipt.error)).toBe("succeeded");
    expect(calls.some((call) => call.path.endsWith("/rerequest"))).toBe(true);
  });

  it("does not reconcile against an in-flight sibling with no start time", async () => {
    const { receipt, calls } = await run(scenarioFor("check.rerun").operation, [
      get(`${REPO}/check-runs/99`, COMPLETED_CHECK),
      get(`${REPO}/commits/${HEAD}/check-runs`, { total_count: 1, check_runs: [
        { ...COMPLETED_CHECK, id: 98, status: "queued", conclusion: null, started_at: undefined },
      ] }),
      send("POST", `${REPO}/check-runs/99/rerequest`, {}, 201),
    ]);
    expect(receipt.status, JSON.stringify(receipt.error)).toBe("succeeded");
    expect(calls.some((call) => call.path.endsWith("/rerequest"))).toBe(true);
  });

  it("skips the reconciliation scan when the target has no usable start time", async () => {
    const { receipt, calls } = await run(scenarioFor("check.rerun").operation, [
      get(`${REPO}/check-runs/99`, { ...COMPLETED_CHECK, started_at: undefined }),
      send("POST", `${REPO}/check-runs/99/rerequest`, {}, 201),
    ]);
    expect(receipt.status, JSON.stringify(receipt.error)).toBe("succeeded");
    // No boundary is available, so no scan is attempted and the rerun is issued.
    expect(calls.some((call) => call.path.includes("/commits/"))).toBe(false);
  });
});

describe("release target resolution", () => {
  const publishOperation = operationSchema.parse({
    schemaVersion: "v2",
    repository: REPOSITORY,
    id: "op-release-publish-branch",
    kind: "release.publish",
    releaseId: "77",
    expectedTagName: "v1.0.0",
    expectedTargetCommitSha: BASE,
    expectedDraft: true,
    expectedPrerelease: false,
    expectedPublished: false,
    expectedReleaseUpdatedAt: RELEASE_UPDATED,
  });

  it("resolves a branch-valued target_commitish on a draft release", async () => {
    const { receipt } = await run(publishOperation, [
      get(`${REPO}/releases/77`, release({ target_commitish: "main" })),
      get(`${REPO}/git/ref/heads/main`, { object: { sha: BASE } }),
      gql("on Release", { node: { updatedAt: RELEASE_UPDATED } }),
      send("PATCH", `${REPO}/releases/77`, release({ target_commitish: "main", draft: false })),
    ]);
    expect(receipt.status, JSON.stringify(receipt.error)).toBe("succeeded");
  });

  it("resolves a published release through its annotated tag", async () => {
    const deleteOperation = operationSchema.parse({
      schemaVersion: "v2",
      repository: REPOSITORY,
      id: "op-release-delete-tagged",
      kind: "release.delete",
      releaseId: "77",
      expectedTagName: "v1.0.0",
      expectedTargetCommitSha: BASE,
      expectedDraft: false,
      expectedPublished: true,
      expectedReleaseUpdatedAt: RELEASE_UPDATED,
    });
    const { receipt } = await run(deleteOperation, [
      get(`${REPO}/releases/77`, release({ target_commitish: "main", draft: false })),
      get(`${REPO}/git/ref/tags/v1.0.0`, { object: { sha: NEW_COMMIT, type: "tag" } }),
      get(`${REPO}/git/tags/${NEW_COMMIT}`, { object: { sha: BASE, type: "commit" } }),
      gql("on Release", { node: { updatedAt: RELEASE_UPDATED } }),
      send("DELETE", `${REPO}/releases/77`, null, 204),
    ]);
    expect(receipt.status, JSON.stringify(receipt.error)).toBe("succeeded");
  });

  it("conflicts when the resolved target commit differs from the plan", async () => {
    const { receipt } = await run(publishOperation, [
      get(`${REPO}/releases/77`, release({ target_commitish: "main" })),
      get(`${REPO}/git/ref/heads/main`, { object: { sha: NEW_COMMIT } }),
    ]);
    expect(receipt.status).toBe("conflicted");
    expect(receipt.error?.code).toBe("release_target_changed");
    expect(receipt.error?.message).toContain(NEW_COMMIT);
  });

  it("conflicts when a branch-valued target no longer resolves", async () => {
    const { receipt } = await run(publishOperation, [
      get(`${REPO}/releases/77`, release({ target_commitish: "deleted-branch" })),
      get(`${REPO}/git/ref/heads/deleted-branch`, {}, 404),
    ]);
    expect(receipt.status).toBe("conflicted");
    expect(receipt.error?.code).toBe("release_target_unresolved");
  });

  it("reconciles release creation against a branch-valued existing draft", async () => {
    const { receipt } = await run(scenarioFor("release.create").operation, [
      get(`${REPO}/releases`, [release({ target_commitish: "main" })]),
      get(`${REPO}/git/ref/heads/main`, { object: { sha: HEAD } }),
    ]);
    expect(receipt.status, JSON.stringify(receipt.error)).toBe("skipped");
  });
});

describe("cumulative budget", () => {
  it("stops issuing requests once the operation budget is spent", async () => {
    let ticks = 0;
    const { receipt, calls } = await run(
      scenarioFor("issue.label.add").operation,
      scenarioFor("issue.label.add").apply,
      {
        budgetMs: 1_000,
        // First call sets the deadline; later reads advance past it.
        now: () => new Date(Date.parse("2026-02-01T00:00:00Z") + (ticks++ === 0 ? 0 : 60_000)),
      },
    );
    expect(receipt.status).toBe("failed");
    expect(receipt.error?.code).toBe("operation_budget_exhausted");
    expect(receipt.error?.retryable).toBe(true);
    expect(calls).toEqual([]);
  });

  it("completes normally inside the budget", async () => {
    const scenario = scenarioFor("issue.label.add");
    const { receipt } = await run(scenario.operation, scenario.apply, { budgetMs: 60_000 });
    expect(receipt.status).toBe("succeeded");
  });
});

describe("no placeholder outputs", () => {
  it("fails rather than emitting an empty pull request node id", async () => {
    const { receipt } = await run(scenarioFor("pull_request.open_draft").operation, [
      get(`${REPO}/pulls`, []),
      get(`${REPO}/git/ref/heads/gardener/feature`, { object: { sha: HEAD } }),
      get(`${REPO}/git/ref/heads/main`, { object: { sha: BASE } }),
      send("POST", `${REPO}/pulls`, {
        number: 12,
        head: { sha: HEAD },
        base: { ref: "main", sha: BASE },
        html_url: "https://github.com/acme/widgets/pull/12",
      }),
    ]);
    expect(receipt.status).toBe("failed");
    expect(receipt.error?.message).toContain("node id");
  });

  it("fails rather than emitting an empty tree sha on commit reconciliation", async () => {
    const { receipt } = await run(COMMIT_OPERATION, [
      get(`${REPO}/git/ref/heads/gardener/feature`, { object: { sha: NEW_COMMIT } }),
      get(`${REPO}/commits`, [{
        sha: NEW_COMMIT,
        commit: { message: `Apply Gardener changes\n\n${COMMIT_MARKER}` },
        parents: [{ sha: HEAD }],
      }]),
    ]);
    expect(receipt.status).toBe("failed");
    expect(receipt.error?.message).toContain("tree sha");
  });

  it("fails rather than emitting an empty release tag name", async () => {
    const { receipt } = await run(scenarioFor("release.create").operation, [
      get(`${REPO}/releases`, []),
      get(`${REPO}/git/ref/tags/v1.0.0`, {}, 404),
      send("POST", `${REPO}/releases`, { id: 77, html_url: RELEASE_URL, draft: true }),
    ]);
    expect(receipt.status).toBe("failed");
    expect(receipt.error?.message).toContain("tag name");
  });

  it("fails rather than emitting an empty discussion comment url", async () => {
    const { receipt } = await run(scenarioFor("discussion.comment.create").operation, [
      gql("comments(first:100", discussionComments([])),
      gql("answer{ id databaseId }", discussionNode()),
      gql("{addDiscussionComment", { addDiscussionComment: { comment: { id: "DC_1", databaseId: 501 } } }),
    ]);
    expect(receipt.status).toBe("failed");
    expect(receipt.error?.message).toContain("URL");
  });
});

describe("exported helpers", () => {
  it("hashes operations deterministically and independently of key order", () => {
    const operation = scenarioFor("issue.label.add").operation;
    const reordered = Object.fromEntries(
      Object.entries(operation as Record<string, unknown>).reverse(),
    ) as unknown as Operation;
    expect(canonicalOperationHash(reordered)).toBe(canonicalOperationHash(operation));
    expect(canonicalOperationHash(operation)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("hashes branch protection stably", () => {
    expect(branchProtectionHash(PROTECTION)).toBe(branchProtectionHash({ ...PROTECTION }));
    expect(branchProtectionHash(PROTECTION)).not.toBe(branchProtectionHash({}));
  });

  it("treats neutral and skipped check conclusions as successful", () => {
    const { names, appChecks } = successfulChecks(
      { check_runs: [{ name: "lint", conclusion: "neutral", app: { id: 5 } }, { name: "slow", conclusion: "failure" }] },
      { statuses: [{ context: "legacy", state: "success" }] },
    );
    expect([...names].sort()).toEqual(["legacy", "lint"]);
    expect([...appChecks]).toEqual(["5:lint"]);
  });

  it("publishes a least-privilege permission set for every kind", () => {
    expect(Object.keys(OPERATION_TOKEN_PERMISSIONS).sort()).toEqual([...operationKindValues].sort());
    expect(OPERATION_TOKEN_PERMISSIONS["discussion.close"]).toEqual(["discussions:write"]);
    expect(OPERATION_TOKEN_PERMISSIONS["check.rerun"]).toEqual(["checks:write"]);
    expect(OPERATION_TOKEN_PERMISSIONS["pull_request.merge"]).toContain("contents:write");
  });
});
