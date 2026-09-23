/// <reference types="node" />
import { webcrypto } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { canonicalSha256 } from "../src/database";
import type { Env } from "../src/env";
import { GitHubOperationError } from "../src/github-client";
import { executeBoundedOperation } from "../src/operations";
import { normalizeGitHubWebhook } from "../src/webhooks";
import { testDatabase } from "./d1";

const github = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("../src/github-client", async (original) => {
  const module = await original<typeof import("../src/github-client")>();
  return { ...module, executeGitHubOperation: github.execute };
});

beforeAll(() => {
  if (!globalThis.crypto) Object.defineProperty(globalThis, "crypto", { value: webcrypto });
});

const payload = {
  action: "opened",
  sender: { id: 11, login: "actor", type: "User" },
  installation: { id: 7 },
  repository: {
    id: 9,
    name: "widgets",
    default_branch: "main",
    owner: { login: "acme" },
  },
  issue: {
    id: 21,
    number: 3,
    title: "A bug",
    body: "body",
    state: "open",
    locked: false,
    labels: [],
    user: { id: 12, login: "author", type: "User" },
    updated_at: "2026-01-01T00:00:00Z",
    html_url: "https://github.com/acme/widgets/issues/3",
  },
};

async function seeded() {
  const value = testDatabase();
  const event = normalizeGitHubWebhook("issues", payload, "delivery-1", "workspace-1");
  if (!event) throw new Error("event fixture did not normalize");
  await value.db.prepare(
    "INSERT INTO installations(id,account_id,account_login,account_type) " +
    "VALUES('7','50','acme','Organization')",
  ).run();
  await value.db.prepare(
    "INSERT INTO repositories(id,installation_id,owner,name,default_branch) " +
    "VALUES('9','7','acme','widgets','main')",
  ).run();
  await value.db.prepare(
    "INSERT INTO webhook_deliveries " +
    "(delivery_id,event_name,payload_hash,installation_id,repository_id,normalized_event_id," +
    "normalized_event_json,normalized_event_hash,status) VALUES(?,?,?,?,?,?,?,?, 'delivered')",
  ).bind(
    "delivery-1",
    "issues",
    "a".repeat(64),
    "7",
    "9",
    event.id,
    JSON.stringify(event),
    await canonicalSha256(event),
  ).run();
  return { ...value, event };
}

function operation(id = "comment-operation-1") {
  return {
    schemaVersion: "v2" as const,
    id,
    kind: "issue.comment.create" as const,
    repository: {
      provider: "github" as const,
      id: "9",
      installationId: "7",
      owner: "acme",
      name: "widgets",
      defaultBranch: "main",
    },
    issueNumber: 3,
    expectedIssueState: "open" as const,
    expectedIssueUpdatedAt: "2026-01-01T00:00:00.000Z",
    body: `A bounded response.\n<!-- gardener-operation:${id} -->`,
  };
}

describe("Gateway operation receipts", () => {
  it("refuses an operation that carries no installation identity", async () => {
    const { sqlite, db, event } = await seeded();
    try {
      github.execute.mockReset();
      const { installationId: _omitted, ...repository } = operation().repository;
      const input = {
        runId: "run-1234567890123456",
        eventId: event.id,
        operation: { ...operation(), repository },
      };
      // `installationId` is optional in the contract because an
      // Actions-planned operation genuinely has none. This gateway mints
      // installation tokens and binds `installation_id` into its lease and
      // receipt rows, so it must refuse before any of that, rather than
      // binding `undefined` into a query and matching whatever row results.
      await expect(executeBoundedOperation({ DB: db } as Env, input)).rejects.toThrow(GitHubOperationError);
      await expect(executeBoundedOperation({ DB: db } as Env, input)).rejects.toThrow(/installation-bound operation/);
      expect(github.execute).not.toHaveBeenCalled();
      const leases = await db.prepare("SELECT COUNT(*) AS total FROM operation_receipts").first<{ total: number }>();
      expect(leases?.total).toBe(0);
    } finally {
      sqlite.close();
    }
  });

  it("executes an event-bound operation once and replays its hash-bound receipt", async () => {
    const { sqlite, db, event } = await seeded();
    try {
      github.execute.mockReset().mockResolvedValue({
        status: "applied",
        githubId: 88,
        url: "https://github.com/acme/widgets/issues/3#issuecomment-88",
      });
      const env = { DB: db } as Env;
      const input = {
        runId: "run-1234567890123456",
        eventId: event.id,
        operation: operation(),
      };
      const first = await executeBoundedOperation(env, input);
      const replay = await executeBoundedOperation(env, input);
      expect(first).toEqual(replay);
      expect(first.receipt).toMatchObject({ status: "succeeded", attempt: 1 });
      expect(github.execute).toHaveBeenCalledOnce();
      const row = sqlite.prepare(
        "SELECT status,attempt_count,receipt_hash FROM operation_receipts WHERE operation_id=?",
      ).get(operation().id) as { status: string; attempt_count: number; receipt_hash: string };
      expect(row).toMatchObject({ status: "succeeded", attempt_count: 1 });
      expect(row.receipt_hash).toHaveLength(64);
      sqlite.prepare(
        "UPDATE operation_receipts SET receipt_json=json_set(receipt_json,'$.attempt',2) " +
        "WHERE operation_id=?",
      ).run(operation().id);
      await expect(executeBoundedOperation(env, input)).rejects.toMatchObject({
        code: "receipt_integrity_failed",
      });
    } finally { sqlite.close(); }
  });

  it("persists and replays a branch-protection conflict as conflicted", async () => {
    const value = testDatabase();
    try {
      const pullPayload = {
        ...payload,
        pull_request: {
          id: 31,
          number: 4,
          title: "A pull",
          body: "body",
          state: "open",
          draft: false,
          merged: false,
          labels: [],
          user: { id: 12, login: "author", type: "User" },
          updated_at: "2026-01-01T00:00:00Z",
          html_url: "https://github.com/acme/widgets/pull/4",
          head: { ref: "gardener/fix", sha: "a".repeat(40) },
          base: { ref: "main", sha: "b".repeat(40) },
        },
      };
      const event = normalizeGitHubWebhook(
        "pull_request",
        pullPayload,
        "delivery-pull",
        "workspace-1",
      );
      if (!event || event.kind !== "github.pull_request") throw new Error("pull fixture failed");
      await value.db.prepare(
        "INSERT INTO installations(id,account_id,account_login,account_type) " +
        "VALUES('7','50','acme','Organization')",
      ).run();
      await value.db.prepare(
        "INSERT INTO repositories(id,installation_id,owner,name,default_branch) " +
        "VALUES('9','7','acme','widgets','main')",
      ).run();
      await value.db.prepare(
        "INSERT INTO webhook_deliveries " +
        "(delivery_id,event_name,payload_hash,installation_id,repository_id,normalized_event_id," +
        "normalized_event_json,normalized_event_hash,status) VALUES(?,?,?,?,?,?,?,?, 'delivered')",
      ).bind(
        "delivery-pull",
        "pull_request",
        "b".repeat(64),
        "7",
        "9",
        event.id,
        JSON.stringify(event),
        await canonicalSha256(event),
      ).run();
      github.execute.mockReset().mockRejectedValue(new GitHubOperationError(
        "branch_protection_changed",
        "Branch protection changed after approval",
      ));
      const input = {
        runId: "run-1234567890123456",
        eventId: event.id,
        operation: {
          schemaVersion: "v2" as const,
          id: "merge-conflict-operation",
          kind: "pull_request.merge" as const,
          repository: operation().repository,
          pullNumber: 4,
          expectedHeadSha: "a".repeat(40),
          expectedBaseRef: "main",
          expectedBaseSha: "b".repeat(40),
          expectedState: "open" as const,
          expectedDraft: false as const,
          expectedPullUpdatedAt: "2026-01-01T00:00:00.000Z",
          method: "squash" as const,
          requiredChecks: [{ context: "test", appId: 1 }],
          expectedBranchProtectionHash: "c".repeat(64),
        },
      };
      const first = await executeBoundedOperation({ DB: value.db } as Env, input);
      const replay = await executeBoundedOperation({ DB: value.db } as Env, input);
      expect(first).toEqual(replay);
      expect(first.receipt).toMatchObject({ status: "conflicted" });
      expect(value.sqlite.prepare(
        "SELECT status FROM operation_receipts WHERE operation_id='merge-conflict-operation'",
      ).get()).toEqual({ status: "conflicted" });
      expect(github.execute).toHaveBeenCalledOnce();
    } finally { value.sqlite.close(); }
  });

  it("requires the exact comment event before authorizing a comment update", async () => {
    const { sqlite, db, event } = await seeded();
    try {
      github.execute.mockReset().mockResolvedValue({ status: "applied" });
      await expect(executeBoundedOperation({ DB: db } as Env, {
        runId: "run-1234567890123456",
        eventId: event.id,
        operation: {
          ...operation("comment-update-operation"),
          kind: "issue.comment.update",
          commentId: "88",
          expectedCommentUpdatedAt: "2026-01-01T00:00:00.000Z",
          body: "Updated body",
        },
      })).rejects.toMatchObject({ code: "event_resource_mismatch" });
      expect(github.execute).not.toHaveBeenCalled();
    } finally { sqlite.close(); }
  });

  it("rejects operation-id reuse and event resource drift before GitHub", async () => {
    const { sqlite, db, event } = await seeded();
    try {
      github.execute.mockReset().mockResolvedValue({ status: "applied" });
      const env = { DB: db } as Env;
      const input = {
        runId: "run-1234567890123456",
        eventId: event.id,
        operation: operation(),
      };
      await executeBoundedOperation(env, input);
      await expect(executeBoundedOperation(env, {
        ...input,
        operation: {
          ...operation(),
          body: "Different exact body\n<!-- gardener-operation:comment-operation-1 -->",
        },
      })).rejects.toMatchObject({ code: "operation_id_conflict" });
      await expect(executeBoundedOperation(env, {
        ...input,
        operation: { ...operation("comment-operation-2"), issueNumber: 4 },
      })).rejects.toMatchObject({ code: "event_resource_mismatch" });
      expect(github.execute).toHaveBeenCalledOnce();
    } finally { sqlite.close(); }
  });
});
