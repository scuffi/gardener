import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessRequest } from "../src/harness";

const flue = vi.hoisted(() => ({
  useAgentFinish: vi.fn(),
  useDataWriter: vi.fn(),
  useInitialData: vi.fn(),
  useInstruction: vi.fn(),
  useModel: vi.fn(),
  usePersistentState: vi.fn(),
  useResponseFinish: vi.fn(),
  useTool: vi.fn(),
}));

vi.mock("@flue/runtime", () => ({ ...flue }));
vi.mock("@flue/runtime/cloudflare", () => ({ extend: vi.fn(() => ({})) }));

import {
  GardenerTaskFlueAgent,
  installGardenerTaskToolFacade,
} from "../src/task-runtime/flue-agent";

function request(): HarnessRequest {
  return {
    schemaVersion: "gardener.harness.request/v1",
    requestId: "task_request_1",
    runId: "repo-1-run-2-attempt-1-plan",
    snapshot: {
      agentRevisionId: "task:fixture.issue-triage",
      agentRevisionHash: "a".repeat(64),
      promptReference: `event:${"b".repeat(64)}`,
      policySnapshotReference: `policy:${"c".repeat(64)}`,
      toolCatalogVersion: "gardener.task-tools/v1",
      harness: { id: "flue", adapterVersion: "gardener-flue-native/v1" },
    },
    prompt: "Inspect the repository.",
    model: { id: "@cf/test/model" },
    tools: [{ name: "repository_read_file", description: "Read a file", authority: "observe" }],
    budget: {
      maxTurns: 8,
      maxToolCalls: 24,
      maxInputTokens: 64_000,
      maxOutputTokens: 8_000,
      maxRuntimeMs: 300_000,
      deadlineAt: "2099-01-01T00:00:00.000Z",
    },
    context: [{ name: "normalized-event-v1", content: JSON.stringify({
      schemaVersion: "gardener.normalized-event/v1",
      eventId: "event:1",
      occurredAt: "2026-09-17T12:00:00.000Z",
      kind: "github.issue.opened",
      repository: { id: "1", ownerId: "2", owner: "owner", name: "repo", fullName: "owner/repo", visibility: "public", commitSha: "a".repeat(40), ref: "refs/heads/main" },
      workflow: { runId: "3", runAttempt: 1, eventName: "issues", workflowRef: "owner/repo/.github/workflows/gardener.yml@refs/heads/main", jobWorkflowRef: `owner/repo/.github/workflows/reusable.yml@${"b".repeat(40)}`, runnerEnvironment: "github-hosted" },
      actor: { id: "2", login: "owner" },
      issue: { id: "4", number: 7, title: "Bug", body: "Broken", labels: ["gardener-test"], author: { id: "2", login: "owner" } },
    }) }],
  };
}

describe("canonical task Flue agent", () => {
  const writeTaskOutcome = vi.fn();
  const invoke = vi.fn(async () => ({ status: "completed", stdout: "README", stderr: "", outputTruncated: false }));

  beforeEach(() => {
    vi.clearAllMocks();
    flue.useDataWriter.mockReturnValue(writeTaskOutcome);
    installGardenerTaskToolFacade({ invoke });
  });

  it("mounts an inspect-only terminal plus durable runner tools", async () => {
    const value = request();
    flue.useInitialData.mockReturnValue({ request: value });

    const rendered = GardenerTaskFlueAgent();
    expect(rendered).toContain(value.prompt);
    expect(rendered).toContain("Execution protocol");
    expect(GardenerTaskFlueAgent.agentName).toBe("gardener-task-harness");
    expect(GardenerTaskFlueAgent.durability).toEqual({ maxAttempts: 3, timeoutMs: 300_000 });
    expect(flue.useTool).toHaveBeenCalledTimes(2);

    const terminal = flue.useTool.mock.calls.map((call) => call[0]).find((tool) => tool.name === "finish_task");
    const repositoryTool = flue.useTool.mock.calls.map((call) => call[0]).find((tool) => tool.name === "repository_read_file");
    expect(terminal).toBeDefined();
    expect(repositoryTool).toMatchObject({ durable: true });

    await expect(repositoryTool.run({
      data: { path: "README.md" },
      toolCallId: "call-1",
    })).resolves.toEqual({ output: { content: "README" } });
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({
      runId: value.runId,
      requestId: value.requestId,
      toolCallId: "call-1",
      toolName: "repository_read_file",
      input: { path: "README.md" },
    }));
  });

  it("derives immutable comment-effect bindings in trusted host code", async () => {
    const value = request();
    flue.useInitialData.mockReturnValue({ request: value });
    GardenerTaskFlueAgent();
    const terminal = flue.useTool.mock.calls.map((call) => call[0]).find((tool) => tool.name === "finish_task");

    await expect(terminal.run({
      data: {
        inspectionComplete: true,
        summary: "README inspected.",
        commentBody: "Thanks. The likely next step is to add a regression test.",
      },
    })).resolves.toEqual({ output: { accepted: true }, terminate: true });
    expect(writeTaskOutcome).toHaveBeenCalledWith({
      schemaVersion: "gardener.task-outcome/v1",
      runId: value.runId,
      taskId: "fixture.issue-triage",
      bundleHash: value.snapshot.agentRevisionHash,
      status: "completed",
      summary: "README inspected.",
      observations: [{ kind: "repository", summary: "Canonical repository inspection completed before terminal settlement", paths: [] }],
      proposedEffects: [{
        operationId: expect.stringMatching(/^op_[a-f0-9]{64}$/),
        kind: "issue.comment.create",
        issueNumber: 7,
        body: "Thanks. The likely next step is to add a regression test.",
        rationale: "Model-proposed comment based on canonical repository tool results.",
      }],
    });
  });

  it("rejects settlement without successful list and read evidence", () => {
    const value = request();
    flue.useInitialData.mockReturnValue({ request: value });
    GardenerTaskFlueAgent();
    const finish = flue.useAgentFinish.mock.calls.at(-1)![0];
    expect(() => finish({
      response: {
        toolCalls: [{ tool: "finish_task", isError: false }],
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
      },
    })).toThrow(/canonical_repository_evidence/);
  });

  it("fails closed when a tool-bearing task has no trusted runner facade", () => {
    flue.useInitialData.mockReturnValue({ request: request() });
    installGardenerTaskToolFacade(undefined);
    expect(() => GardenerTaskFlueAgent()).toThrow(/runner tool facade is unavailable/);
  });
});
