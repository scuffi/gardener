import { generateKeyPairSync, webcrypto } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { operationKindValues, operationSchema, repositoryEventV2Schema } from "@gardener/contracts";
import { canonicalOperationHash as coreOperationHash } from "@gardener/core";
import type { Env } from "../src/env";
import { ConnectOperationError, executeGitHubOperation } from "../src/github";
import { canonicalOperationHash as connectOperationHash, createEventRelayRequest } from "../src/index";
import { callbackUrlSchema } from "../src/schema";
import { normalizeGitHubWebhook } from "../src/webhook";

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

describe("Connect relay boundary", () => {
  it("uses an Authorization-only, non-redirecting event relay request", () => {
    const request = createEventRelayRequest("https://tenant.account.workers.dev/hooks/connect", "signed-event", { "CF-Access-Client-Id": "id" });
    expect(request.headers.get("authorization")).toBe("Bearer signed-event");
    expect(request.headers.get("cf-access-client-id")).toBe("id");
    expect(request.headers.get("content-type")).toBeNull();
    expect(request.redirect).toBe("manual");
  });

  it("rejects tenant callbacks outside public workers.dev hosts", () => {
    expect(callbackUrlSchema.safeParse("https://tenant.account.workers.dev/hooks/connect").success).toBe(true);
    expect(callbackUrlSchema.safeParse("https://127.0.0.1.nip.io/hooks/connect").success).toBe(false);
    expect(callbackUrlSchema.safeParse("https://example.com/hooks/connect").success).toBe(false);
    expect(callbackUrlSchema.safeParse("https://user:pass@tenant.account.workers.dev/hooks/connect").success).toBe(false);
  });
});

describe("Operation V2 exact execution", () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const env = { GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), GITHUB_APP_SLUG: "gardener-connect-dev", CONNECT_JWT_PRIVATE_KEY: "test-key" } as Env;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("rejects every unverified catalog operation with a typed permanent error before requesting credentials", async () => {
    const unverified = operationKindValues.filter((kind) => !["issue.label.add", "issue.label.remove", "issue.comment.create", "issue.comment.update", "issue.close", "issue.reopen", "pull_request.review.submit", "pull_request.update", "branch.create", "commit.create", "pull_request.open_draft", "pull_request.merge"].includes(kind));
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    const candidate = operationSchema.parse({ schemaVersion: "v2", id: "unsupported", kind: "check.rerun", repository, checkRunId: "99", expectedHeadSha: sha, expectedStatus: "completed", expectedConclusion: "failure" });
    await expect(executeGitHubOperation(env, candidate)).rejects.toMatchObject<Partial<ConnectOperationError>>({ code: "unsupported_operation", retryable: false });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(unverified).toContain("check.rerun");
  });

  it("uses the Gardener canonical exact-effect hash", async () => {
    const operation = operationSchema.parse({ schemaVersion: "v2", id: "branch-hash", kind: "branch.create", repository, branch: "gardener/fix", fromSha: sha, expectedAbsent: true });
    await expect(connectOperationHash(operation)).resolves.toBe(await coreOperationHash(operation));
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
});
