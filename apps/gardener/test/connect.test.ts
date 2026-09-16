import { describe, expect, it, vi } from "vitest";
import { canonicalOperationHash } from "@gardener/core";
import type { Operation } from "@gardener/contracts";
import {
  beginGitHubInstallation,
  executeGitHubOperation,
  GitHubUsernameResolutionError,
  resolveGitHubUser,
} from "../src/providers/github/client";
import type { Env } from "../src/env";

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

function environment(gateway: Partial<Env["GITHUB_GATEWAY"]>): Env {
  return { GITHUB_GATEWAY: gateway } as unknown as Env;
}

describe("GitHub Gateway binding client", () => {
  it("starts owner-bound installation setup without a provider credential", async () => {
    const beginInstallation = vi.fn().mockResolvedValue({
      installationUrl: "https://github.com/apps/gardener/installations/new",
    });
    const env = environment({ beginInstallation } as Partial<Env["GITHUB_GATEWAY"]>);
    const input = {
      requestId: "installation_1234567890",
      requestedBy: { provider: "github" as const, subject: "101", login: "owner" },
    };
    await expect(beginGitHubInstallation(env, input)).resolves.toContain("github.com");
    expect(beginInstallation).toHaveBeenCalledWith(input);
  });

  it("uses stable username-resolution errors", async () => {
    const env = environment({
      resolveUsername: vi.fn().mockRejectedValue(new Error("username_lookup_rate_limited")),
    } as Partial<Env["GITHUB_GATEWAY"]>);
    await expect(resolveGitHubUser(env, "octocat")).rejects.toEqual(
      expect.objectContaining<Partial<GitHubUsernameResolutionError>>({
        message: "github_user_resolution_429",
        status: 429,
      }),
    );
  });

  it("returns a receipt bound to the exact operation", async () => {
    const operationHash = await canonicalOperationHash(operation);
    const receipt = {
      schemaVersion: "v2" as const,
      operationId: operation.id,
      operationHash,
      kind: operation.kind,
      status: "succeeded" as const,
      attempt: 1,
      attemptedAt: "2026-01-01T00:00:00Z",
      completedAt: "2026-01-01T00:00:01Z",
    };
    const executeOperation = vi.fn().mockResolvedValue({ receipt });
    const env = environment({ executeOperation } as Partial<Env["GITHUB_GATEWAY"]>);
    await expect(executeGitHubOperation(env, "run-1-1234567890", "event-1", operation))
      .resolves.toEqual(receipt);
    expect(executeOperation).toHaveBeenCalledWith({
      runId: "run-1-1234567890",
      eventId: "event-1",
      operation,
    });
  });
});
