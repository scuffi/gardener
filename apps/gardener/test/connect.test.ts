import { webcrypto } from "node:crypto";
import { beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import { canonicalOperationHash } from "@gardener/core";
import type { Operation } from "@gardener/contracts";
import { beginGitHubInstallation, ConnectUsernameResolutionError, executeThroughConnect, resolveGitHubUser } from "../src/connect";
import type { Env } from "../src/env";

beforeAll(() => {
  if (!globalThis.crypto) Object.defineProperty(globalThis, "crypto", { value: webcrypto });
});

afterEach(() => vi.unstubAllGlobals());

const operation: Operation = {
  schemaVersion: "v2",
  id: "comment-op",
  kind: "issue.comment.create",
  repository: {
    provider: "github",
    id: "9",
    installationId: "7",
    owner: "acme",
    name: "widgets",
    defaultBranch: "main",
  },
  issueNumber: 3,
  expectedIssueState: "open",
  expectedIssueUpdatedAt: "2026-01-01T00:00:00Z",
  body: "A bounded triage response.",
};

const env = {
  CONNECT_URL: "https://connect.example.test",
  GARDENER_INSTANCE_TOKEN: `gdn_instance-test.${"x".repeat(20)}`,
} as Env;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("W3 instance-authenticated Connect calls",()=>{
  it("starts installation setup with the instance token and immutable owner subject",async()=>{const fetchMock=vi.fn().mockResolvedValue(json({installationUrl:"https://github.com/apps/gardener/installations/new"}));vi.stubGlobal("fetch",fetchMock); await expect(beginGitHubInstallation(env,"101","https://gardener.example.test/")).resolves.toContain("github.com"); const [url,init]=fetchMock.mock.calls[0] as [URL,RequestInit]; expect(url.pathname).toBe("/v1/instances/installations/setup"); expect((init.headers as Record<string,string>).authorization).toBe(`Bearer ${env.GARDENER_INSTANCE_TOKEN}`); expect(JSON.parse(String(init.body))).toEqual({githubUserId:"101",redirectUri:"https://gardener.example.test/"}); expect(String(init.body)).not.toContain("identity_token");});
  it("uses stable github_user_resolution errors without exposing upstream bodies",async()=>{vi.stubGlobal("fetch",vi.fn().mockResolvedValue(json({error:"private upstream detail"},429))); await expect(resolveGitHubUser(env,"octocat")).rejects.toEqual(expect.objectContaining<Partial<ConnectUsernameResolutionError>>({message:"github_user_resolution_429",status:429}));});
});

describe("Connect operation receipts", () => {
  it.each([
    { status: 409, code: "github_execution_failed", retryable: false },
    { status: 422, code: "unsupported_operation", retryable: false },
    { status: 503, code: "github_http_error", retryable: true },
  ])("returns a valid exact receipt from HTTP $status", async ({ status, code, retryable }) => {
    const operationHash = await canonicalOperationHash(operation);
    const receipt = {
      schemaVersion: "v2",
      operationId: operation.id,
      operationHash,
      kind: operation.kind,
      status: "failed",
      attempt: 1,
      attemptedAt: "2026-01-01T00:00:00Z",
      completedAt: "2026-01-01T00:00:01Z",
      error: { code, message: "Connect returned a typed failure.", retryable },
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ grant: "run-grant" }))
      .mockResolvedValueOnce(json(receipt, status));
    vi.stubGlobal("fetch", fetchMock);

    await expect(executeThroughConnect(env, "run-1", "event-1", operation)).resolves.toEqual(receipt);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects a non-2xx receipt that is not bound to the exact operation", async () => {
    const operationHash = await canonicalOperationHash(operation);
    const mismatchedReceipt = {
      schemaVersion: "v2",
      operationId: "different-operation",
      operationHash,
      kind: operation.kind,
      status: "failed",
      attempt: 1,
      attemptedAt: "2026-01-01T00:00:00Z",
      completedAt: "2026-01-01T00:00:01Z",
      error: { code: "github_execution_failed", message: "Failure.", retryable: false },
    };
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(json({ grant: "run-grant" }))
      .mockResolvedValueOnce(json(mismatchedReceipt, 409)));

    await expect(executeThroughConnect(env, "run-1", "event-1", operation)).rejects.toThrow(
      "Connect /v1/operations failed (409)",
    );
  });
});
