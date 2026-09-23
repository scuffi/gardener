import { describe, expect, it } from "vitest";
import {
  isInstallationBackedRepository,
  operationRepositoryRefSchema,
  operationSchema,
  repositoryEventV2Schema,
  repositoryRefSchema,
  runGrantV2Schema,
} from "../src";

const sha = "a".repeat(40);
const now = "2026-09-22T10:00:00.000Z";
const actionsRepository = {
  provider: "github", id: "1318443351", owner: "scuffi", name: "gardener", defaultBranch: "main",
} as const;
const installationRepository = { ...actionsRepository, installationId: "158557952" } as const;

describe("repository identity", () => {
  it("lets an operation omit the installation a GitHub Actions run does not have", () => {
    expect(operationRepositoryRefSchema.parse(actionsRepository)).toEqual(actionsRepository);
    expect(operationRepositoryRefSchema.parse(installationRepository)).toEqual(installationRepository);
    expect(operationSchema.parse({
      schemaVersion: "v2", id: "op:1", repository: actionsRepository,
      kind: "issue.comment.create", issueNumber: 2,
      expectedIssueState: "open", expectedIssueUpdatedAt: now, body: "Hello.",
    }).repository.installationId).toBeUndefined();
  });

  it("never invents an installation id", () => {
    expect(() => operationRepositoryRefSchema.parse({ ...actionsRepository, installationId: null })).toThrow();
    expect(() => operationRepositoryRefSchema.parse({ ...actionsRepository, installationId: "0" })).toThrow();
    expect(isInstallationBackedRepository(operationRepositoryRefSchema.parse(actionsRepository))).toBe(false);
    expect(isInstallationBackedRepository(operationRepositoryRefSchema.parse(installationRepository))).toBe(true);
  });

  it("still requires an installation at every installation-backed boundary", () => {
    expect(() => repositoryRefSchema.parse(actionsRepository)).toThrow();
    expect(repositoryRefSchema.parse(installationRepository)).toEqual(installationRepository);

    const event = {
      schemaVersion: "v2", id: "event:1", instanceId: "instance:1", occurredAt: now,
      deliveryId: "delivery:1", kind: "github.push", action: "pushed",
      actor: { id: "100", login: "actor", accountType: "User" }, resourceAuthor: null,
      push: { ref: "refs/heads/main", before: sha, after: sha, forced: false, created: false, deleted: false, commitCount: 1 },
    };
    expect(repositoryEventV2Schema.parse({ ...event, repository: installationRepository }).repository.installationId)
      .toBe("158557952");
    expect(() => repositoryEventV2Schema.parse({ ...event, repository: actionsRepository })).toThrow();

    const grant = {
      schemaVersion: "v2", id: "grant:1", instanceId: "instance:1", runId: "run:1", eventId: "event:1",
      agentId: "agent:1", agentRevisionId: "revision:1", assignmentId: "assignment:1",
      capabilities: { schemaVersion: "v2", effects: [], reads: [] },
      issuedAt: now, expiresAt: "2026-09-22T11:00:00.000Z",
    };
    expect(() => runGrantV2Schema.parse({ ...grant, repository: actionsRepository })).toThrow();

    // `connectedGitHubRepositorySchema` in @gardener/provider-github extends
    // `repositoryRefSchema`, so it inherits the requirement above. Contracts
    // deliberately has no dependency on the provider package, so that
    // inheritance is asserted in the provider package's own suite.
  });
});
