import { generateKeyPairSync, webcrypto } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { operationKindValues, operationSchema, repositoryEventV2Schema } from "@gardener/contracts";
import type { Env } from "../src/env";
import {
  GitHubOperationError,
  branchProtectionHash,
  discoverRepositories,
  executeGitHubOperation,
} from "../src/github-client";
import { normalizeGitHubWebhook } from "../src/webhooks";

beforeAll(() => { if (!globalThis.crypto) Object.defineProperty(globalThis, "crypto", { value: webcrypto }); });
afterEach(() => vi.unstubAllGlobals());

const repository = { provider: "github" as const, id: "9", installationId: "7", owner: "acme", name: "widgets", defaultBranch: "main" };
const sha = "abcdef1234567890abcdef1234567890abcdef12";
const baseSha = "1234567890abcdef1234567890abcdef12345678";
const account = (id: number, login: string, type = "User") => ({ id, login, type });
const common = {
  action: "opened",
  sender: account(11, "actor"),
  installation: { id: 7 },
  repository: { id: 9, name: "widgets", default_branch: "main", owner: { login: "acme" } },
};
const issue = { id: 21, number: 3, title: "A bug", body: "body", state: "open", locked: false, labels: [{ name: "bug" }], user: account(12, "author"), updated_at: "2026-01-01T00:00:00Z", html_url: "https://github.com/acme/widgets/issues/3" };
const pull = { id: 31, number: 4, title: "A pull", body: "body", state: "open", draft: true, merged: false, labels: [], user: account(12, "author"), updated_at: "2026-01-01T00:00:00Z", html_url: "https://github.com/acme/widgets/pull/4", head: { ref: "gardener/fix", sha }, base: { ref: "main", sha: baseSha } };

describe("RepositoryEventV2 normalization", () => {
  it("attests actor and resource author independently with immutable repository ids", () => {
    const event = normalizeGitHubWebhook("issues", { ...common, issue }, "delivery-1", "instance-1");
    expect(repositoryEventV2Schema.parse(event)).toMatchObject({ schemaVersion: "v2", kind: "github.issue", actor: { id: "11", login: "actor" }, resourceAuthor: { id: "12", login: "author" }, repository: { id: "9", installationId: "7" } });
  });

  it("fails closed on unknown actions, absent stable identities, and malformed SHAs", () => {
    expect(normalizeGitHubWebhook("issues", { ...common, action: "future_action", issue }, "d", "i")).toBeNull();
    expect(normalizeGitHubWebhook("issues", { ...common, sender: { login: "actor" }, issue }, "d", "i")).toBeNull();
    expect(normalizeGitHubWebhook("pull_request", { ...common, pull_request: { ...pull, head: { ...pull.head, sha: "main" } } }, "d", "i")).toBeNull();
  });

  it("does not mis-attest PR issue comments when GitHub omits head/base facts", () => {
    const comment = { id: 41, body: "hello", updated_at: "2026-01-01T00:00:01Z", html_url: "https://github.com/acme/widgets/issues/4#issuecomment-41", user: account(13, "commenter") };
    expect(normalizeGitHubWebhook("issue_comment", { ...common, action: "created", issue: { ...issue, pull_request: { url: "https://api.github.com/repos/acme/widgets/pulls/4" } }, comment }, "d", "i")).toBeNull();
  });

  it("normalizes pull request and review identities and facts", () => {
    const pr = normalizeGitHubWebhook("pull_request", { ...common, pull_request: pull }, "pr", "i");
    expect(pr).toMatchObject({ kind: "github.pull_request", pullRequest: { head: { sha }, base: { sha: baseSha }, draft: true } });
    const review = normalizeGitHubWebhook("pull_request_review", { ...common, action: "submitted", pull_request: pull, review: { id: 51, state: "APPROVED", body: "ok", commit_id: sha, submitted_at: "2026-01-01T00:00:02Z", user: account(14, "reviewer") } }, "review", "i");
    expect(review).toMatchObject({ kind: "github.pull_request_review", review: { state: "approved", commitSha: sha }, resourceAuthor: { id: "14" } });
  });

  it("normalizes independently attested comments, checks, pushes, and releases", () => {
    const comment = { id: 41, body: "hello", updated_at: "2026-01-01T00:00:01Z", html_url: "https://github.com/acme/widgets/issues/3#issuecomment-41", user: account(13, "commenter") };
    expect(normalizeGitHubWebhook("issue_comment", { ...common, action: "created", issue, comment }, "comment", "i")).toMatchObject({ kind: "github.issue_comment", resourceAuthor: { id: "13" } });
    expect(normalizeGitHubWebhook("check_run", { ...common, action: "completed", check_run: { id: 61, name: "test", head_sha: sha, status: "completed", conclusion: "success", details_url: null, completed_at: "2026-01-01T00:00:03Z" } }, "check", "i")).toMatchObject({ kind: "github.check_run", resourceAuthor: null });
    expect(normalizeGitHubWebhook("push", { ...common, before: baseSha, after: sha, ref: "refs/heads/main", forced: false, created: false, deleted: false, commits: [], head_commit: { timestamp: "2026-01-01T00:00:04Z" } }, "push", "i")).toMatchObject({ kind: "github.push", action: "pushed", resourceAuthor: null });
    expect(normalizeGitHubWebhook("release", { ...common, action: "published", release: { id: 71, tag_name: "v1.0.0", target_commitish: sha, name: "v1", body: "notes", draft: false, prerelease: false, published_at: "2026-01-01T00:00:05Z", updated_at: "2026-01-01T00:00:05Z", html_url: "https://github.com/acme/widgets/releases/tag/v1.0.0", author: account(15, "releaser") } }, "release", "i")).toMatchObject({ kind: "github.release", resourceAuthor: { id: "15" } });
  });
});

describe("GitHub repository discovery", () => {
  it("returns the provider-qualified repository contract used by installation finalization", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const env = {
      GITHUB_APP_ID: "1",
      GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    } as Env;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/app/installations/7/access_tokens") {
        return new Response(JSON.stringify({ token: "installation-token" }), { status: 201 });
      }
      if (url.pathname === "/installation/repositories") {
        return new Response(JSON.stringify({
          repositories: [{
            id: 9,
            full_name: "acme/widgets",
            default_branch: "main",
          }],
        }));
      }
      return new Response(JSON.stringify({ message: "unexpected" }), { status: 500 });
    }));

    await expect(discoverRepositories(env, "7")).resolves.toEqual([{
      provider: "github",
      id: "9",
      installationId: "7",
      owner: "acme",
      name: "widgets",
      defaultBranch: "main",
    }]);
  });
});

describe("Operation V2 exact execution", () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const env = {
    GITHUB_APP_ID: "1",
    GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    GITHUB_APP_SLUG: "gardener-gateway-dev",
    OPERATION_MARKER_KEY: "test-operation-marker-key",
  } as Env;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("rejects every unverified catalog operation with a typed permanent error before requesting credentials", async () => {
    const unverified = operationKindValues.filter((kind) => !["issue.label.add", "issue.label.remove", "issue.comment.create", "issue.comment.update", "issue.close", "issue.reopen", "pull_request.review.submit", "pull_request.update", "branch.create", "commit.create", "pull_request.open_draft", "pull_request.merge"].includes(kind));
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    const candidate = operationSchema.parse({ schemaVersion: "v2", id: "unsupported", kind: "check.rerun", repository, checkRunId: "99", expectedHeadSha: sha, expectedStatus: "completed", expectedConclusion: "failure" });
    await expect(executeGitHubOperation(env, candidate)).rejects.toMatchObject<Partial<GitHubOperationError>>({ code: "unsupported_operation", retryable: false });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(unverified).toContain("check.rerun");
  });

  it("creates only the exact approved gardener branch with a V2 operation", async () => {
    const requests: Array<{ url: URL; init: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input)); requests.push({ url, init });
      if (url.pathname === "/app/installations/7/access_tokens") return json({ token: "token" }, 201);
      if (url.pathname === "/repos/acme/widgets/git/ref/heads/gardener%2Ffix") return json({ message: "Not Found" }, 404);
      if (url.pathname === "/repos/acme/widgets/git/refs") return json({ object: { sha } }, 201);
      return json({ message: "unexpected" }, 500);
    }));
    const operation = operationSchema.parse({ schemaVersion: "v2", id: "branch-op", kind: "branch.create", repository, branch: "gardener/fix", fromSha: sha, expectedAbsent: true });
    await expect(executeGitHubOperation(env, operation)).resolves.toMatchObject({ status: "applied", githubId: sha });
    expect(JSON.parse(String(requests[0]!.init.body)).permissions).toEqual({ contents: "write", metadata: "read" });
    expect(JSON.parse(String(requests.at(-1)!.init.body))).toEqual({ ref: "refs/heads/gardener/fix", sha });
  });

  it("recovers an ambiguously successful issue comment before mutable issue preconditions", async () => {
    const requests: Array<{ url: URL; init: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input)); requests.push({ url, init });
      if (url.pathname === "/app/installations/7/access_tokens") return json({ token: "token" }, 201);
      if (url.pathname === "/repos/acme/widgets/issues/3") return json({ ...issue, state: "closed", updated_at: "2026-01-02T00:00:00Z" });
      if (url.pathname === "/repos/acme/widgets/issues/3/comments") return json([{ id: 88, body: "Triage response\n<!-- gardener-operation:comment-retry -->", html_url: "https://github.com/acme/widgets/issues/3#issuecomment-88", user: { login: "gardener-gateway-dev[bot]" } }]);
      return json({ message: "unexpected" }, 500);
    }));
    const operation = operationSchema.parse({ schemaVersion: "v2", id: "comment-retry", kind: "issue.comment.create", repository, issueNumber: 3, expectedIssueState: "open", expectedIssueUpdatedAt: issue.updated_at, body: "Triage response\n<!-- gardener-operation:comment-retry -->" });

    await expect(executeGitHubOperation(env, operation)).resolves.toEqual({ status: "already-applied", githubId: 88, url: "https://github.com/acme/widgets/issues/3#issuecomment-88" });
    expect(requests).toHaveLength(3);
    expect(requests.some(({ init }) => init.method === "POST" && String(init.body).includes("Triage response"))).toBe(false);
  });

  it("finds an exact comment marker beyond the former ten-page scan bound", async () => {
    let pages = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/app/installations/7/access_tokens") return json({ token: "token" }, 201);
      if (url.pathname === "/repos/acme/widgets/issues/3") {
        return json({ ...issue, state: "closed", updated_at: "2026-01-02T00:00:00Z" });
      }
      if (url.pathname === "/repos/acme/widgets/issues/3/comments") {
        pages += 1;
        if (pages < 11) {
          return json(Array.from({ length: 100 }, (_, index) => ({
            id: pages * 100 + index,
            body: "unrelated",
            user: { login: "someone" },
          })));
        }
        return json([{
          id: 1_101,
          body: "Triage response\n<!-- gardener-operation:comment-page-eleven -->",
          html_url: "https://github.com/acme/widgets/issues/3#issuecomment-1101",
          user: { login: "gardener-gateway-dev[bot]" },
        }]);
      }
      return json({ message: "unexpected" }, 500);
    }));
    const operation = operationSchema.parse({
      schemaVersion: "v2",
      id: "comment-page-eleven",
      kind: "issue.comment.create",
      repository,
      issueNumber: 3,
      expectedIssueState: "open",
      expectedIssueUpdatedAt: issue.updated_at,
      body: "Triage response\n<!-- gardener-operation:comment-page-eleven -->",
    });
    await expect(executeGitHubOperation(env, operation)).resolves.toMatchObject({
      status: "already-applied",
      githubId: 1_101,
    });
    expect(pages).toBe(11);
  });

  it("compares comment update preconditions as instants across equivalent ISO formatting", async () => {
    const requests: Array<{ url: URL; init: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input)); requests.push({ url, init });
      if (url.pathname === "/app/installations/7/access_tokens") return json({ token: "token" }, 201);
      if (url.pathname === "/repos/acme/widgets/issues/3") return json(issue);
      if (url.pathname === "/repos/acme/widgets/issues/comments/44" && init.method !== "PATCH") return json({ id: 44, issue_url: "https://api.github.com/repos/acme/widgets/issues/3", updated_at: "2026-01-01T00:00:00Z", body: "Old", user: { login: "gardener-gateway-dev[bot]" } });
      if (url.pathname === "/repos/acme/widgets/issues/comments/44" && init.method === "PATCH") return json({ id: 44, html_url: "https://github.com/acme/widgets/issues/3#issuecomment-44" });
      return json({ message: "unexpected" }, 500);
    }));
    const operation = operationSchema.parse({ schemaVersion: "v2", id: "comment-update-iso", kind: "issue.comment.update", repository, issueNumber: 3, expectedIssueState: "open", expectedIssueUpdatedAt: "2026-01-01T00:00:00.000Z", commentId: "44", expectedCommentUpdatedAt: "2026-01-01T00:00:00.000Z", body: "Updated" });
    await expect(executeGitHubOperation(env, operation)).resolves.toEqual({ status: "applied", githubId: 44, url: "https://github.com/acme/widgets/issues/3#issuecomment-44" });
    expect(requests).toHaveLength(4);
  });

  it("rejects a genuinely newer comment update instant", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/app/installations/7/access_tokens") return json({ token: "token" }, 201);
      if (url.pathname === "/repos/acme/widgets/issues/3") return json(issue);
      if (url.pathname === "/repos/acme/widgets/issues/comments/44") return json({ id: 44, issue_url: "https://api.github.com/repos/acme/widgets/issues/3", updated_at: "2026-01-01T00:00:01Z", body: "Old", user: { login: "gardener-gateway-dev[bot]" } });
      return json({ message: "unexpected" }, 500);
    }));
    const operation = operationSchema.parse({ schemaVersion: "v2", id: "comment-update-stale", kind: "issue.comment.update", repository, issueNumber: 3, expectedIssueState: "open", expectedIssueUpdatedAt: issue.updated_at, commentId: "44", expectedCommentUpdatedAt: issue.updated_at, body: "Updated" });
    await expect(executeGitHubOperation(env, operation)).rejects.toThrow("comment changed after the operation was approved");
  });

  it("compares pull update preconditions as instants across equivalent ISO formatting", async () => {
    const requests: Array<{ url: URL; init: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input)); requests.push({ url, init });
      if (url.pathname === "/app/installations/7/access_tokens") return json({ token: "token" }, 201);
      if (url.pathname === "/repos/acme/widgets/pulls/4") return json(pull);
      if (url.pathname === "/repos/acme/widgets/pulls/4/reviews" && init.method !== "POST") return json([]);
      if (url.pathname === "/repos/acme/widgets/pulls/4/reviews" && init.method === "POST") return json({ id: 90, html_url: "https://github.com/acme/widgets/pull/4#pullrequestreview-90" }, 201);
      return json({ message: "unexpected" }, 500);
    }));
    const operation = operationSchema.parse({ schemaVersion: "v2", id: "review-iso", kind: "pull_request.review.submit", repository, pullNumber: 4, expectedHeadSha: sha, expectedBaseRef: "main", expectedBaseSha: baseSha, expectedState: "open", expectedDraft: true, expectedPullUpdatedAt: "2026-01-01T00:00:00.000Z", event: "approve", body: "Looks good\n<!-- gardener-operation:review-iso -->", comments: [] });
    await expect(executeGitHubOperation(env, operation)).resolves.toEqual({ status: "applied", githubId: 90, url: "https://github.com/acme/widgets/pull/4#pullrequestreview-90" });
    expect(requests).toHaveLength(4);
  });

  it("rejects a genuinely newer pull update instant", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/app/installations/7/access_tokens") return json({ token: "token" }, 201);
      if (url.pathname === "/repos/acme/widgets/pulls/4") return json({ ...pull, updated_at: "2026-01-01T00:00:01Z" });
      if (url.pathname === "/repos/acme/widgets/pulls/4/reviews") return json([]);
      return json({ message: "unexpected" }, 500);
    }));
    const operation = operationSchema.parse({ schemaVersion: "v2", id: "review-stale", kind: "pull_request.review.submit", repository, pullNumber: 4, expectedHeadSha: sha, expectedBaseRef: "main", expectedBaseSha: baseSha, expectedState: "open", expectedDraft: true, expectedPullUpdatedAt: pull.updated_at, event: "approve", body: "Looks good\n<!-- gardener-operation:review-stale -->", comments: [] });
    await expect(executeGitHubOperation(env, operation)).rejects.toThrow("pull request changed after the operation was approved");
  });

  it("compares issue update preconditions as instants across equivalent ISO formatting", async () => {
    const requests: Array<{ url: URL; init: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input)); requests.push({ url, init });
      if (url.pathname === "/app/installations/7/access_tokens") return json({ token: "token" }, 201);
      if (url.pathname === "/repos/acme/widgets/issues/3") return json(issue);
      if (url.pathname === "/repos/acme/widgets/issues/3/comments" && init.method !== "POST") return json([]);
      if (url.pathname === "/repos/acme/widgets/issues/3/comments" && init.method === "POST") return json({ id: 89, html_url: "https://github.com/acme/widgets/issues/3#issuecomment-89" }, 201);
      return json({ message: "unexpected" }, 500);
    }));
    const operation = operationSchema.parse({ schemaVersion: "v2", id: "comment-iso", kind: "issue.comment.create", repository, issueNumber: 3, expectedIssueState: "open", expectedIssueUpdatedAt: "2026-01-01T00:00:00.000Z", body: "Triage response\n<!-- gardener-operation:comment-iso -->" });

    await expect(executeGitHubOperation(env, operation)).resolves.toEqual({ status: "applied", githubId: 89, url: "https://github.com/acme/widgets/issues/3#issuecomment-89" });
    expect(requests).toHaveLength(4);
  });

  it("rejects a genuinely newer issue update instant", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/app/installations/7/access_tokens") return json({ token: "token" }, 201);
      if (url.pathname === "/repos/acme/widgets/issues/3") return json({ ...issue, updated_at: "2026-01-01T00:00:01Z" });
      if (url.pathname === "/repos/acme/widgets/issues/3/comments") return json([]);
      return json({ message: "unexpected" }, 500);
    }));
    const operation = operationSchema.parse({ schemaVersion: "v2", id: "comment-stale", kind: "issue.comment.create", repository, issueNumber: 3, expectedIssueState: "open", expectedIssueUpdatedAt: issue.updated_at, body: "Triage response\n<!-- gardener-operation:comment-stale -->" });
    await expect(executeGitHubOperation(env, operation)).rejects.toThrow("issue changed after the operation was approved");
  });

  it("reconciles exact issue and merge outcomes before stale event preconditions", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/app/installations/7/access_tokens") return json({ token: "token" }, 201);
      if (url.pathname === "/repos/acme/widgets/issues/3") {
        return json({
          ...issue,
          updated_at: "2026-01-02T00:00:00Z",
          labels: [...issue.labels, { name: "triaged" }],
        });
      }
      if (url.pathname === "/repos/acme/widgets/pulls/4") {
        return json({
          ...pull,
          state: "closed",
          draft: false,
          merged: true,
          merged_at: "2026-01-02T00:00:00Z",
          updated_at: "2026-01-02T00:00:00Z",
        });
      }
      return json({ message: "unexpected" }, 500);
    }));
    const labelOperation = operationSchema.parse({
      schemaVersion: "v2",
      id: "label-reconcile",
      kind: "issue.label.add",
      repository,
      issueNumber: 3,
      expectedIssueState: "open",
      expectedIssueUpdatedAt: issue.updated_at,
      label: "triaged",
    });
    await expect(executeGitHubOperation(env, labelOperation)).resolves.toEqual({
      status: "already-applied",
    });
    const mergeOperation = operationSchema.parse({
      schemaVersion: "v2",
      id: "merge-reconcile",
      kind: "pull_request.merge",
      repository,
      pullNumber: 4,
      expectedHeadSha: sha,
      expectedBaseRef: "main",
      expectedBaseSha: baseSha,
      expectedState: "open",
      expectedDraft: false,
      expectedPullUpdatedAt: pull.updated_at,
      method: "squash",
      requiredChecks: [{ context: "test", appId: 1 }],
      expectedBranchProtectionHash: "a".repeat(64),
    });
    await expect(executeGitHubOperation(env, mergeOperation)).resolves.toMatchObject({
      status: "already-applied",
      githubId: 4,
    });
  });

  it("requires draft and metadata changes to be separate exact operations", () => {
    expect(operationSchema.safeParse({
      schemaVersion: "v2",
      id: "pull-update-combined",
      kind: "pull_request.update",
      repository,
      pullNumber: 4,
      expectedHeadSha: sha,
      expectedBaseRef: "main",
      expectedBaseSha: baseSha,
      expectedState: "open",
      expectedDraft: true,
      expectedPullUpdatedAt: pull.updated_at,
      draft: false,
      title: "Updated title",
    }).success).toBe(false);
  });

  it("rejects merge when any hash-bound branch protection fact changed", async () => {
    const protection = {
      required_status_checks: {
        strict: true,
        contexts: ["test"],
        checks: [{ context: "test", app_id: 1 }],
      },
      required_pull_request_reviews: { required_approving_review_count: 2 },
      enforce_admins: { enabled: true },
      restrictions: null,
    };
    expect(await branchProtectionHash(protection)).not.toBe(await branchProtectionHash({
      ...protection,
      required_pull_request_reviews: { required_approving_review_count: 1 },
    }));
    const requests: Array<{ url: URL; init: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input)); requests.push({ url, init });
      if (url.pathname === "/app/installations/7/access_tokens") return json({ token: "token" }, 201);
      if (url.pathname === "/repos/acme/widgets/pulls/4") {
        return json({ ...pull, draft: false });
      }
      if (url.pathname === "/repos/acme/widgets") return json({ allow_squash_merge: true });
      if (url.pathname.endsWith("/branches/main/protection")) return json(protection);
      return json({ message: "unexpected" }, 500);
    }));
    const operation = operationSchema.parse({
      schemaVersion: "v2",
      id: "merge-protection-change",
      kind: "pull_request.merge",
      repository,
      pullNumber: 4,
      expectedHeadSha: sha,
      expectedBaseRef: "main",
      expectedBaseSha: baseSha,
      expectedState: "open",
      expectedDraft: false,
      expectedPullUpdatedAt: pull.updated_at,
      method: "squash",
      requiredChecks: [{ context: "test", appId: 1 }],
      expectedBranchProtectionHash: await branchProtectionHash({
        ...protection,
        required_pull_request_reviews: { required_approving_review_count: 1 },
      }),
    });
    await expect(executeGitHubOperation(env, operation)).rejects.toMatchObject({
      code: "branch_protection_changed",
      retryable: false,
    });
    expect(requests.some(({ url }) => url.pathname.endsWith("/merge"))).toBe(false);
  });

  it("enforces issue preconditions before posting when no marked comment exists", async () => {
    const requests: Array<{ url: URL; init: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input)); requests.push({ url, init });
      if (url.pathname === "/app/installations/7/access_tokens") return json({ token: "token" }, 201);
      if (url.pathname === "/repos/acme/widgets/issues/3") return json({ ...issue, state: "closed", updated_at: "2026-01-02T00:00:00Z" });
      if (url.pathname === "/repos/acme/widgets/issues/3/comments") return json([]);
      return json({ message: "unexpected" }, 500);
    }));
    const operation = operationSchema.parse({ schemaVersion: "v2", id: "comment-new", kind: "issue.comment.create", repository, issueNumber: 3, expectedIssueState: "open", expectedIssueUpdatedAt: issue.updated_at, body: "Triage response\n<!-- gardener-operation:comment-new -->" });

    await expect(executeGitHubOperation(env, operation)).rejects.toThrow("Precondition failed: issue state is closed");
    expect(requests).toHaveLength(3);
  });
});
