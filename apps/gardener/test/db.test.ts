import { compileWorkflowV2 } from "@gardener/core";
import { describe, expect, it } from "vitest";
import type { ConnectEvent } from "../src/domain";
import { repositoryPauseSetting, workflowMatchesEvent } from "../src/db";

const event: ConnectEvent = {
  schemaVersion: "v1",
  id: "event-1",
  deliveryId: "delivery-1",
  instanceId: "instance-1",
  kind: "github.issue",
  action: "opened",
  occurredAt: "2026-09-02T12:00:00.000Z",
  repository: { provider: "github", id: "repo-1", installationId: "1", owner: "acme", name: "widgets" },
  issue: {
    id: "issue-1",
    number: 1,
    title: "A bug",
    body: null,
    state: "open",
    labels: [],
    author: "octocat",
    htmlUrl: "https://github.com/acme/widgets/issues/1",
  },
};

describe("compiled workflow triggers", () => {
  it("matches an exact normalized event and action", () => {
    expect(workflowMatchesEvent('{"triggers":["github.issue.opened"]}', event)).toBe(true);
    expect(workflowMatchesEvent('{"triggers":["github.issue.edited"]}', event)).toBe(false);
  });

  it("fails closed for malformed or broad plans", () => {
    expect(workflowMatchesEvent("not json", event)).toBe(false);
    expect(workflowMatchesEvent('{"triggers":["github.issue"]}', event)).toBe(false);
  });

  it("scopes repository pause settings by provider repository id", () => {
    expect(repositoryPauseSetting("repo-1")).toBe("repository_paused:repo-1");
  });

  it("enforces v2 action, explicit repository scope, and exact three-valued conditions", async () => {
    const scopedEvent = {
      ...event,
      repository: { ...event.repository, id: "123456" },
    };
    const compiled = await compileWorkflowV2({
      name: "Author-scoped issues",
      description: "",
      triggers: [{ kind: "github.issue", actions: ["opened"] }],
      repositoryIds: ["123456"],
      condition: {
        kind: "predicate",
        capabilityId: "github.resource.author.login@v1",
        operator: "equals",
        expected: "octocat",
      },
      runtime: { kind: "workers-ai.issue-gardener", model: "deployment-default", instructions: "Classify this issue." },
      capabilities: { read: ["issue"], propose: ["issue.label.add"] },
      workspace: { enabled: false, experimental: false, network: "denied", allowedHosts: [] },
      limits: { runtimeSeconds: 300, inputTokens: 32000, outputTokens: 8000, costUsd: 1, retries: 2, operations: 4 },
    }, { workflowId: "author-scoped", revision: 1, resolvedModel: "test-model" });
    const plan = JSON.stringify(compiled.plan);

    expect(workflowMatchesEvent(plan, scopedEvent)).toBe(true);
    expect(workflowMatchesEvent(plan, {
      ...scopedEvent,
      issue: { ...scopedEvent.issue, author: "hubot" },
    })).toBe(false);
    expect(workflowMatchesEvent(plan, {
      ...scopedEvent,
      repository: { ...scopedEvent.repository, id: "654321" },
    })).toBe(false);
    expect(workflowMatchesEvent(plan, {
      ...scopedEvent,
      action: "edited",
    })).toBe(false);
  });
});
