import { describe, expect, it } from "vitest";
import type { ConnectEvent } from "../src/domain";
import { parseAiClassification, runIssueGardener } from "../src/runtime";

const event: ConnectEvent = {
  schemaVersion: "v1",
  id: "event-1",
  deliveryId: "delivery-1",
  instanceId: "instance-1",
  kind: "github.issue",
  action: "opened",
  occurredAt: "2026-09-02T12:00:00.000Z",
  repository: { provider: "github", id: "repo-1", installationId: "99", owner: "acme", name: "widgets" },
  issue: {
    id: "issue-7",
    number: 7,
    title: "Crash on launch",
    body: "The app exits immediately.",
    state: "open",
    labels: ["bug"],
    author: "octocat",
    htmlUrl: "https://github.com/acme/widgets/issues/7",
  },
};

describe("issue gardener runtime", () => {
  it("parses Workers AI responses and fenced JSON", () => {
    expect(parseAiClassification({ response: "```json\n{\"summary\":\"A bug\",\"labels\":[\"bug\"],\"comment\":null,\"rationale\":\"Crash report\"}\n```" }).summary).toBe("A bug");
  });

  it("creates bounded typed proposals and skips existing labels", async () => {
    const result = await runIssueGardener({
      ai: {
        run: async () => ({
          response: JSON.stringify({
            summary: "Likely a bug with missing reproduction details.",
            labels: ["bug", "question"],
            comment: "Thanks. Could you share the runtime version?",
            rationale: "The report describes a crash but lacks environment details.",
          }),
          usage: { prompt_tokens: 100, completion_tokens: 40 },
        }),
      },
      model: "test-model",
      runId: "run-1",
      event,
      instructions: "Classify the issue.",
    });

    expect(result.proposals).toHaveLength(2);
    expect(result.proposals.map((item) => item.operation.kind)).toEqual([
      "issue.label.add",
      "issue.comment.create",
    ]);
    expect(result.proposals[0]?.operation.id).toBe("run-1:operation:0");
    expect(result.usage).toMatchObject({ model: "test-model", inputTokens: 100, outputTokens: 40 });
  });

  it("rejects labels outside the v1 allowlist", () => {
    expect(() => parseAiClassification({ summary: "x", labels: ["pwned"], comment: null, rationale: "x" })).toThrow();
  });
});
