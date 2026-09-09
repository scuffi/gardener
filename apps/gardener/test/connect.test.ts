import { webcrypto } from "node:crypto";
import { beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import { canonicalOperationHash } from "@gardener/core";
import type { Operation } from "@gardener/contracts";
import { executeThroughConnect } from "../src/connect";
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
