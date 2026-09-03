import { generateKeyPairSync, webcrypto } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { executeGitHubOperation, successfulChecks } from "../src/github";

beforeAll(() => {
  if (!globalThis.crypto) Object.defineProperty(globalThis, "crypto", { value: webcrypto });
});

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const env = {
  GITHUB_APP_ID: "1",
  GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  GITHUB_APP_SLUG: "gardener-connect-dev",
  CONNECT_JWT_PRIVATE_KEY: "test-only-commit-marker-key",
} as Env;
const baseSha = "1234567890abcdef1234567890abcdef12345678";
const repository = { provider: "github" as const, id: "9", installationId: "7", owner: "acme", name: "widgets", defaultBranch: "main" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function mockGitHub(handler: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  const requests: Array<{ url: URL; init: RequestInit }> = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    requests.push({ url, init });
    if (url.pathname === "/app/installations/7/access_tokens") return json({ token: "installation-token" }, 201);
    return handler(url, init);
  });
  vi.stubGlobal("fetch", fetchMock);
  return requests;
}

afterEach(() => vi.unstubAllGlobals());

describe("typed GitHub maintainer operations", () => {
  it("matches GitHub's successful check-run conclusions without accepting failures or pending checks", () => {
    const checks = successfulChecks({ check_runs: [
      { name: "success", conclusion: "success", app: { id: 1 } },
      { name: "neutral", conclusion: "neutral", app: { id: 1 } },
      { name: "skipped", conclusion: "skipped", app: { id: 1 } },
      { name: "failure", conclusion: "failure", app: { id: 1 } },
      { name: "cancelled", conclusion: "cancelled", app: { id: 1 } },
      { name: "pending", conclusion: null, app: { id: 1 } },
    ] }, { statuses: [] });
    expect([...checks.appChecks].sort()).toEqual(["1:neutral", "1:skipped", "1:success"]);
    expect(checks.names.has("failure")).toBe(false);
    expect(checks.names.has("cancelled")).toBe(false);
    expect(checks.names.has("pending")).toBe(false);
  });

  it("creates a branch with a contents-only write token", async () => {
    const requests = mockGitHub((url, init) => {
      if (url.pathname === "/repos/acme/widgets/git/ref/heads/gardener%2Ffix") return json({ message: "Not Found" }, 404);
      if (url.pathname === "/repos/acme/widgets/git/refs" && init.method === "POST") return json({ object: { sha: "abcdef1234567890abcdef1234567890abcdef12" } }, 201);
      return json({ message: "unexpected" }, 500);
    });
    await expect(executeGitHubOperation(env, { schemaVersion: "v1", id: "branch-op", kind: "branch.create", repository, branch: "gardener/fix", fromSha: "abcdef1234567890abcdef1234567890abcdef12" })).resolves.toMatchObject({ status: "applied" });
    const tokenBody = JSON.parse(String(requests[0]?.init.body));
    expect(tokenBody.permissions).toEqual({ contents: "write", metadata: "read" });
    expect(JSON.parse(String(requests[2]?.init.body))).toEqual({ ref: "refs/heads/gardener/fix", sha: "abcdef1234567890abcdef1234567890abcdef12" });
  });

  it("creates and fast-forwards a bounded commit without force", async () => {
    const requests = mockGitHub((url, init) => {
      if (url.pathname === "/repos/acme/widgets/git/ref/heads/gardener%2Ffix" && !init.method) return json({ object: { sha: "abcdef1234567890abcdef1234567890abcdef12" } });
      if (url.pathname === "/repos/acme/widgets/git/commits/abcdef1234567890abcdef1234567890abcdef12" && !init.method) return json({ sha: "abcdef1234567890abcdef1234567890abcdef12", tree: { sha: "tree-old" } });
      if (url.pathname === "/repos/acme/widgets/git/trees/tree-old" && !init.method) return json({ sha: "tree-old", tree: [{ path: "script.sh", mode: "100755", type: "blob", sha: "blob-old" }] });
      if (url.pathname === "/repos/acme/widgets/git/trees" && init.method === "POST") return json({ sha: "tree-new" }, 201);
      if (url.pathname === "/repos/acme/widgets/git/commits" && init.method === "POST") return json({ sha: "fedcba0987654321fedcba0987654321fedcba09" }, 201);
      if (url.pathname === "/repos/acme/widgets/git/refs/heads/gardener%2Ffix" && init.method === "PATCH") return json({ object: { sha: "fedcba0987654321fedcba0987654321fedcba09" } });
      return json({ message: "unexpected" }, 500);
    });
    await expect(executeGitHubOperation(env, { schemaVersion: "v1", id: "commit-op", kind: "commit.create", repository, branch: "gardener/fix", expectedHeadSha: "abcdef1234567890abcdef1234567890abcdef12", message: "Fix script", files: [{ path: "script.sh", content: "#!/bin/sh\necho updated" }] })).resolves.toMatchObject({ status: "applied", githubId: "fedcba0987654321fedcba0987654321fedcba09" });
    const treeBody = JSON.parse(String(requests.find((request) => request.url.pathname.endsWith("/git/trees"))?.init.body));
    expect(treeBody).toMatchObject({ base_tree: "tree-old", tree: [{ path: "script.sh", mode: "100755", content: "#!/bin/sh\necho updated" }] });
    const commitBody = JSON.parse(String(requests.find((request) => request.url.pathname.endsWith("/git/commits") && request.init.method === "POST")?.init.body));
    expect(commitBody.message).toMatch(/Gardener-Operation: commit-op:[a-f0-9]{64}$/);
    const updateBody = JSON.parse(String(requests.at(-1)?.init.body));
    expect(updateBody).toEqual({ sha: "fedcba0987654321fedcba0987654321fedcba09", force: false });
  });

  it("fails closed when GitHub truncates the parent tree", async () => {
    const requests = mockGitHub((url) => {
      if (url.pathname === "/repos/acme/widgets/git/ref/heads/gardener%2Ffix") return json({ object: { sha: "abcdef1234567890abcdef1234567890abcdef12" } });
      if (url.pathname === "/repos/acme/widgets/git/commits/abcdef1234567890abcdef1234567890abcdef12") return json({ tree: { sha: "tree-old" } });
      if (url.pathname === "/repos/acme/widgets/git/trees/tree-old") return json({ truncated: true, tree: [] });
      return json({ message: "unexpected" }, 500);
    });
    await expect(executeGitHubOperation(env, { schemaVersion: "v1", id: "truncated", kind: "commit.create", repository, branch: "gardener/fix", expectedHeadSha: "abcdef1234567890abcdef1234567890abcdef12", message: "Update", files: [{ path: "script.sh", content: "echo changed\n" }] })).rejects.toThrow(/truncated/);
    expect(requests.some((request) => request.url.pathname === "/repos/acme/widgets/git/trees" && request.init.method === "POST")).toBe(false);
  });

  it("rejects replacing unsupported Git object modes", async () => {
    mockGitHub((url) => {
      if (url.pathname === "/repos/acme/widgets/git/ref/heads/gardener%2Ffix") return json({ object: { sha: "abcdef1234567890abcdef1234567890abcdef12" } });
      if (url.pathname === "/repos/acme/widgets/git/commits/abcdef1234567890abcdef1234567890abcdef12") return json({ tree: { sha: "tree-old" } });
      if (url.pathname === "/repos/acme/widgets/git/trees/tree-old") return json({ tree: [{ path: "linked", mode: "120000", type: "blob", sha: "blob-old" }] });
      return json({ message: "unexpected" }, 500);
    });
    await expect(executeGitHubOperation(env, { schemaVersion: "v1", id: "symlink", kind: "commit.create", repository, branch: "gardener/fix", expectedHeadSha: "abcdef1234567890abcdef1234567890abcdef12", message: "Update", files: [{ path: "linked", content: "target" }] })).rejects.toThrow(/unsupported Git object/);
  });

  it("opens a pull request only from the expected branch head", async () => {
    const requests = mockGitHub((url, init) => {
      if (url.pathname === "/repos/acme/widgets/git/ref/heads/gardener%2Ffix") return json({ object: { sha: "abcdef1234567890abcdef1234567890abcdef12" } });
      if (url.pathname === "/repos/acme/widgets/git/ref/heads/main") return json({ object: { sha: baseSha } });
      if (url.pathname === "/repos/acme/widgets/pulls" && !init.method) return json([]);
      if (url.pathname === "/repos/acme/widgets/pulls" && init.method === "POST") return json({ number: 3, html_url: "https://github.com/acme/widgets/pull/3", head: { sha: "abcdef1234567890abcdef1234567890abcdef12" }, base: { ref: "main", sha: baseSha } }, 201);
      return json({ message: "unexpected" }, 500);
    });
    await expect(executeGitHubOperation(env, { schemaVersion: "v1", id: "open-pr", kind: "pull_request.open", repository, head: "gardener/fix", base: "main", expectedHeadSha: "abcdef1234567890abcdef1234567890abcdef12", expectedBaseSha: baseSha, title: "Fix", body: "Details", draft: true })).resolves.toMatchObject({ status: "applied", githubId: 3 });
    const createBody = JSON.parse(String(requests.at(-1)?.init.body));
    expect(createBody.body).toContain("gardener-operation:open-pr");
    expect(createBody).toMatchObject({ head: "gardener/fix", base: "main", draft: true });
  });

  it("closes a pull request only at the expected head", async () => {
    const requests = mockGitHub((url, init) => {
      if (url.pathname === "/repos/acme/widgets/pulls/3" && !init.method) return json({ number: 3, state: "open", draft: false, node_id: "PR_3", html_url: "https://github.com/acme/widgets/pull/3", head: { sha: "abcdef1234567890abcdef1234567890abcdef12" }, base: { ref: "main", sha: baseSha } });
      if (url.pathname === "/repos/acme/widgets/pulls/3" && init.method === "PATCH") return json({ number: 3, state: "closed", html_url: "https://github.com/acme/widgets/pull/3", head: { sha: "abcdef1234567890abcdef1234567890abcdef12" }, base: { ref: "main", sha: baseSha } });
      return json({ message: "unexpected" }, 500);
    });
    await expect(executeGitHubOperation(env, { schemaVersion: "v1", id: "close-pr", kind: "pull_request.update", repository, pullNumber: 3, expectedHeadSha: "abcdef1234567890abcdef1234567890abcdef12", expectedBaseRef: "main", expectedBaseSha: baseSha, expectedState: "open", expectedDraft: false, state: "closed" })).resolves.toMatchObject({ status: "applied", githubId: 3 });
    expect(JSON.parse(String(requests.at(-1)?.init.body))).toEqual({ state: "closed" });
  });

  it("changes pull request draft state through an installation-authenticated GraphQL mutation", async () => {
    const requests = mockGitHub((url, init) => {
      if (url.pathname === "/repos/acme/widgets/pulls/3") return json({ number: 3, state: "open", draft: true, node_id: "PR_3", html_url: "https://github.com/acme/widgets/pull/3", head: { sha: "abcdef1234567890abcdef1234567890abcdef12" }, base: { ref: "main", sha: baseSha } });
      if (url.pathname === "/graphql" && init.method === "POST") return json({ data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } });
      return json({ message: "unexpected" }, 500);
    });
    await expect(executeGitHubOperation(env, { schemaVersion: "v1", id: "ready-pr", kind: "pull_request.update", repository, pullNumber: 3, expectedHeadSha: "abcdef1234567890abcdef1234567890abcdef12", expectedBaseRef: "main", expectedBaseSha: baseSha, expectedState: "open", expectedDraft: true, draft: false })).resolves.toMatchObject({ status: "applied", githubId: 3 });
    const mutationBody = JSON.parse(String(requests.at(-1)?.init.body));
    expect(mutationBody.query).toContain("markPullRequestReadyForReview");
    expect(mutationBody.variables).toEqual({ id: "PR_3" });
  });

  it("binds reviews to the expected commit and stable operation marker", async () => {
    const requests = mockGitHub((url, init) => {
      if (url.pathname === "/repos/acme/widgets/pulls/3") return json({ number: 3, state: "open", draft: false, head: { sha: "abcdef1234567890abcdef1234567890abcdef12" }, base: { ref: "main", sha: baseSha } });
      if (url.pathname === "/repos/acme/widgets/pulls/3/reviews" && !init.method) return json([]);
      if (url.pathname === "/repos/acme/widgets/pulls/3/reviews" && init.method === "POST") return json({ id: 44, html_url: "https://github.com/acme/widgets/pull/3#review-44" }, 200);
      return json({ message: "unexpected" }, 500);
    });
    await expect(executeGitHubOperation(env, { schemaVersion: "v1", id: "review-op", kind: "pull_request.review.submit", repository, pullNumber: 3, expectedHeadSha: "abcdef1234567890abcdef1234567890abcdef12", expectedBaseRef: "main", expectedBaseSha: baseSha, expectedState: "open", expectedDraft: false, event: "approve", body: "Looks good", comments: [] })).resolves.toMatchObject({ status: "applied", githubId: 44 });
    const reviewBody = JSON.parse(String(requests.at(-1)?.init.body));
    expect(reviewBody).toMatchObject({ commit_id: "abcdef1234567890abcdef1234567890abcdef12", event: "APPROVE" });
    expect(reviewBody.body).toContain("gardener-operation:review-op");
  });

  it("revalidates the pull request revision immediately before submitting a review", async () => {
    let lookups = 0;
    mockGitHub((url, init) => {
      if (url.pathname === "/repos/acme/widgets/pulls/3") {
        lookups += 1;
        return json({ number: 3, state: "open", draft: false, head: { sha: "abcdef1234567890abcdef1234567890abcdef12" }, base: { ref: lookups === 1 ? "main" : "release", sha: baseSha } });
      }
      if (url.pathname === "/repos/acme/widgets/pulls/3/reviews" && !init.method) return json([]);
      return json({ message: "unexpected" }, 500);
    });
    await expect(executeGitHubOperation(env, { schemaVersion: "v1", id: "review-race", kind: "pull_request.review.submit", repository, pullNumber: 3, expectedHeadSha: "abcdef1234567890abcdef1234567890abcdef12", expectedBaseRef: "main", expectedBaseSha: baseSha, expectedState: "open", expectedDraft: false, event: "approve", body: "", comments: [] })).rejects.toThrow(/base is release/);
  });

  it("does not accept a same-named required check from the wrong GitHub App", async () => {
    mockGitHub((url) => {
      if (url.pathname === "/repos/acme/widgets/pulls/3") return json({ number: 3, state: "open", draft: false, merged: false, head: { sha: "abcdef1234567890abcdef1234567890abcdef12" }, base: { ref: "main", sha: baseSha } });
      if (url.pathname === "/repos/acme/widgets") return json({ allow_squash_merge: true });
      if (url.pathname === "/repos/acme/widgets/branches/main/protection") return json({ required_status_checks: { checks: [{ context: "test", app_id: 123 }] } });
      if (url.pathname.endsWith("/check-runs")) return json({ check_runs: [{ name: "test", conclusion: "success", app: { id: 999 } }] });
      if (url.pathname.endsWith("/status")) return json({ statuses: [{ context: "test", state: "success" }] });
      return json({ message: "unexpected" }, 500);
    });
    await expect(executeGitHubOperation(env, { schemaVersion: "v1", id: "wrong-app", kind: "pull_request.merge", repository, pullNumber: 3, expectedHeadSha: "abcdef1234567890abcdef1234567890abcdef12", expectedBaseRef: "main", expectedBaseSha: baseSha, expectedState: "open", expectedDraft: false, method: "squash", requiredChecks: [{ context: "test", appId: 123 }] })).rejects.toThrow("test (App 123)");
  });

  it("merges only after app-bound and legacy required checks succeed", async () => {
    const requests = mockGitHub((url, init) => {
      if (url.pathname === "/repos/acme/widgets/pulls/3" && !init.method) return json({ number: 3, state: "open", draft: false, merged: false, html_url: "https://github.com/acme/widgets/pull/3", head: { sha: "abcdef1234567890abcdef1234567890abcdef12" }, base: { ref: "main", sha: baseSha } });
      if (url.pathname === "/repos/acme/widgets") return json({ allow_squash_merge: true });
      if (url.pathname === "/repos/acme/widgets/branches/main/protection") return json({ required_status_checks: { contexts: ["legacy"], checks: [{ context: "test", app_id: 123 }] } });
      if (url.pathname.endsWith("/check-runs")) return json({ check_runs: [{ name: "test", conclusion: "success", app: { id: 123 } }] });
      if (url.pathname.endsWith("/status")) return json({ statuses: [{ context: "legacy", state: "success" }] });
      if (url.pathname === "/repos/acme/widgets/pulls/3/merge" && init.method === "PUT") return json({ merged: true, sha: "fedcba0987654321fedcba0987654321fedcba09" });
      return json({ message: "unexpected" }, 500);
    });
    await expect(executeGitHubOperation(env, { schemaVersion: "v1", id: "merge-ok", kind: "pull_request.merge", repository, pullNumber: 3, expectedHeadSha: "abcdef1234567890abcdef1234567890abcdef12", expectedBaseRef: "main", expectedBaseSha: baseSha, expectedState: "open", expectedDraft: false, method: "squash", requiredChecks: [{ context: "test", appId: 123 }] })).resolves.toMatchObject({ status: "applied", githubId: "fedcba0987654321fedcba0987654321fedcba09" });
    expect(JSON.parse(String(requests[0]?.init.body)).permissions).toEqual({ administration: "read", checks: "read", contents: "write", metadata: "read", pull_requests: "read", statuses: "read" });
  });

  it("rejects a retargeted or differently merged pull request", async () => {
    mockGitHub((url) => {
      if (url.pathname === "/repos/acme/widgets/pulls/3") return json({ number: 3, state: "closed", draft: false, merged: true, head: { sha: "ffffffffffffffffffffffffffffffffffffffff" }, base: { ref: "release", sha: baseSha } });
      return json({ message: "unexpected" }, 500);
    });
    await expect(executeGitHubOperation(env, { schemaVersion: "v1", id: "retargeted", kind: "pull_request.merge", repository, pullNumber: 3, expectedHeadSha: "abcdef1234567890abcdef1234567890abcdef12", expectedBaseRef: "main", expectedBaseSha: baseSha, expectedState: "open", expectedDraft: false, method: "squash", requiredChecks: [{ context: "test", appId: 123 }] })).rejects.toThrow(/Precondition failed/);
  });

  it("fails merge closed when the base branch is unprotected", async () => {
    mockGitHub((url) => {
      if (url.pathname === "/repos/acme/widgets/pulls/3") return json({ number: 3, state: "open", draft: false, merged: false, html_url: "https://github.com/acme/widgets/pull/3", head: { sha: "abcdef1234567890abcdef1234567890abcdef12" }, base: { ref: "main", sha: baseSha } });
      if (url.pathname === "/repos/acme/widgets") return json({ allow_squash_merge: true });
      if (url.pathname === "/repos/acme/widgets/branches/main/protection") return json({ message: "Not Found" }, 404);
      return json({ message: "unexpected" }, 500);
    });
    await expect(executeGitHubOperation(env, { schemaVersion: "v1", id: "merge-op", kind: "pull_request.merge", repository, pullNumber: 3, expectedHeadSha: "abcdef1234567890abcdef1234567890abcdef12", expectedBaseRef: "main", expectedBaseSha: baseSha, expectedState: "open", expectedDraft: false, method: "squash", requiredChecks: [{ context: "test", appId: 123 }] })).rejects.toThrow("not protected");
  });
});
