import { describe, expect, it } from "vitest";
import type { ConnectEvent } from "../src/domain";
import { workflowMatchesEvent } from "../src/db";

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
});
