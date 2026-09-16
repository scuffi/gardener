import { describe, expect, it } from "vitest";
import { operationKindValues } from "@gardener/contracts";
import {
  GITHUB_GATEWAY_CONTRACT_VERSION,
  availableGitHubOperationKinds,
  completeGitHubLoginSchema,
  executeGitHubOperationRequestSchema,
  githubGatewayCapabilitiesSchema,
  unavailableGitHubOperationKinds,
} from "../src";

const repository = {
  provider: "github" as const,
  id: "9",
  installationId: "7",
  owner: "acme",
  name: "widgets",
  defaultBranch: "main",
};

const issueComment = {
  schemaVersion: "v2" as const,
  id: "op_comment_1",
  kind: "issue.comment.create" as const,
  repository,
  issueNumber: 3,
  expectedIssueState: "open" as const,
  expectedIssueUpdatedAt: "2026-01-01T00:00:00.000Z",
  body: "A bounded response\n<!-- gardener-operation:op_comment_1 -->",
};

describe("GitHub Gateway V1 contracts", () => {
  it("advertises every operation exactly once with an honest availability state", () => {
    const capabilities = githubGatewayCapabilitiesSchema.parse({
      contractVersion: GITHUB_GATEWAY_CONTRACT_VERSION,
      operations: operationKindValues.map((kind) => ({
        kind,
        available: availableGitHubOperationKinds.includes(
          kind as (typeof availableGitHubOperationKinds)[number],
        ),
      })),
    });

    expect(capabilities.operations).toHaveLength(29);
    expect(availableGitHubOperationKinds).toHaveLength(12);
    expect(unavailableGitHubOperationKinds).toHaveLength(17);
    expect(new Set(capabilities.operations.map((item) => item.kind)).size).toBe(29);
  });

  it("rejects a 29-row capability response that duplicates and omits a kind", () => {
    const operations = operationKindValues.map((kind) => ({ kind, available: false }));
    operations[1] = operations[0]!;
    expect(githubGatewayCapabilitiesSchema.safeParse({
      contractVersion: GITHUB_GATEWAY_CONTRACT_VERSION,
      operations,
    }).success).toBe(false);
  });

  it("accepts the current exact issue-comment operation envelope", () => {
    expect(executeGitHubOperationRequestSchema.parse({
      runId: "run_1234567890abcdef",
      eventId: "github:delivery-1",
      operation: issueComment,
    })).toEqual({
      runId: "run_1234567890abcdef",
      eventId: "github:delivery-1",
      operation: issueComment,
    });
  });

  it("rejects an unmarked issue comment at the Gateway contract", () => {
    expect(executeGitHubOperationRequestSchema.safeParse({
      runId: "run_1234567890abcdef",
      eventId: "github:delivery-1",
      operation: { ...issueComment, body: "A bounded response" },
    }).success).toBe(false);
  });

  it("rejects identity handoffs that do not use immutable numeric subjects", () => {
    expect(completeGitHubLoginSchema.safeParse({
      handoffId: "handoff_1234567890abcdef",
      identity: { provider: "github", subject: "octocat", login: "octocat" },
      expiresAt: 2_000_000_000,
    }).success).toBe(false);
  });
});
