import { beforeEach, describe, expect, it, vi } from "vitest";
import { taskEffectProposalV1Schema, taskLimitsV1Schema } from "@gardener/contracts";
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
  MAX_TASK_RUNTIME_SECONDS,
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
      repository: { id: "1", ownerId: "2", owner: "owner", name: "repo", fullName: "owner/repo", visibility: "public", commitSha: "a".repeat(40), ref: "refs/heads/main", defaultBranch: "main" },
      workflow: { runId: "3", runAttempt: 1, eventName: "issues", workflowRef: "owner/repo/.github/workflows/gardener.yml@refs/heads/main", jobWorkflowRef: `owner/repo/.github/workflows/reusable.yml@${"b".repeat(40)}`, runnerEnvironment: "github-hosted" },
      actor: { id: "2", login: "owner" },
      issue: { id: "4", number: 7, title: "Bug", body: "Broken", labels: ["gardener-test"], author: { id: "2", login: "owner" } },
    }) }],
  };
}

/** Preconditions every issue operation carries, so payloads stay contract-valid. */
const issuePreconditions = {
  issueNumber: 7,
  expectedIssueState: "open",
  expectedIssueUpdatedAt: "2026-09-17T12:00:00.000Z",
} as const;

function tool(name: string): any {
  return flue.useTool.mock.calls.map((call) => call[0]).find((candidate) => candidate.name === name);
}

describe("canonical task Flue agent", () => {
  const writeTaskOutcome = vi.fn();
  const invoke = vi.fn(async () => ({ status: "completed", stdout: "README", stderr: "", outputTruncated: false }));
  let proposals: { stepName: string; kind: string; payload: unknown; references: unknown; rationale: string }[] = [];

  /** Stands in for the durable session: ordered, digest-idempotent, name-conflicting. */
  const proposeEffect = vi.fn(async ({ proposal }: { proposal: any }) => {
    const existing = proposals.findIndex((candidate) => JSON.stringify(candidate) === JSON.stringify(proposal));
    if (existing >= 0) return { stepName: proposal.stepName, index: existing, duplicate: true, totalProposed: proposals.length };
    if (proposals.some((candidate) => candidate.stepName === proposal.stepName)) {
      throw new Error(`Step name ${proposal.stepName} was already proposed with different content`);
    }
    proposals.push(proposal);
    return { stepName: proposal.stepName, index: proposals.length - 1, duplicate: false, totalProposed: proposals.length };
  });
  const listProposals = vi.fn(async () => proposals);

  /** Stands in for the session's durable capture writer. */
  const captureRepository = vi.fn(async () => ({
    captureId: `cap_${"1".repeat(64)}`,
    fileCount: 2,
    sizeBytes: 31,
    duplicate: false,
  }));

  beforeEach(() => {
    vi.clearAllMocks();
    proposals = [];
    flue.useDataWriter.mockReturnValue(writeTaskOutcome);
    installGardenerTaskToolFacade({ invoke, proposeEffect, listProposals, captureRepository } as never);
  });

  it("mounts propose_effect, finish_task, and the durable runner tools", async () => {
    const value = request();
    flue.useInitialData.mockReturnValue({ request: value });

    const rendered = GardenerTaskFlueAgent();
    expect(rendered).toContain(value.prompt);
    expect(rendered).toContain("Execution protocol");
    expect(GardenerTaskFlueAgent.agentName).toBe("gardener-task-harness");
    expect(GardenerTaskFlueAgent.durability).toEqual({ maxAttempts: 3, timeoutMs: (MAX_TASK_RUNTIME_SECONDS + 60) * 1_000 });
    expect(flue.useTool).toHaveBeenCalledTimes(3);

    expect(tool("propose_effect")).toMatchObject({ durable: true });
    expect(tool("finish_task")).toBeDefined();
    expect(tool("repository_read_file")).toMatchObject({ durable: true });

    await expect(tool("repository_read_file").run({
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

  it("serializes model-emitted parallel tool calls before terminal capture", async () => {
    flue.useInitialData.mockReturnValue({ request: request() });
    let release!: () => void;
    invoke.mockImplementationOnce(() => new Promise((resolve) => {
      release = () => resolve({ status: "completed", stdout: "README", stderr: "", outputTruncated: false });
    }));
    GardenerTaskFlueAgent();

    const repositoryCall = tool("repository_read_file").run({ data: { path: "README.md" }, toolCallId: "read" });
    const finishCall = tool("finish_task").run({ data: { summary: "Done." }, toolCallId: "finish" });
    await Promise.resolve();
    await Promise.resolve();
    expect(listProposals).not.toHaveBeenCalled();

    release();
    await expect(repositoryCall).resolves.toMatchObject({ output: { content: "README" } });
    await expect(finishCall).resolves.toMatchObject({ terminate: true });
    expect(listProposals).toHaveBeenCalledTimes(1);
  });

  it("accepts repeated flat proposals without terminating, in the order given", async () => {
    flue.useInitialData.mockReturnValue({ request: request() });
    GardenerTaskFlueAgent();
    const propose = tool("propose_effect");

    // A flat all-string input: no 29-arm union, no forced tool choice.
    expect(Object.keys(propose.input.entries)).toEqual(["stepName", "kind", "payloadJson", "referencesJson", "rationale"]);

    const first = await propose.run({
      data: {
        stepName: "branch",
        kind: "branch.create",
        payloadJson: JSON.stringify({ branch: "gardener/fix", fromSha: "a".repeat(40), expectedAbsent: true }),
        rationale: "Work needs a branch.",
      },
      toolCallId: "call-1",
    });
    expect(first).toEqual({
      output: { accepted: true, stepName: "branch", position: 1, totalProposed: 1, alreadyProposed: false },
    });
    expect(first.terminate).toBeUndefined();

    await propose.run({
      data: {
        stepName: "comment",
        kind: "issue.comment.create",
        payloadJson: JSON.stringify({ ...issuePreconditions, body: "Opened a branch." }),
        referencesJson: JSON.stringify({ "/body": { step: "branch", output: "branch" } }),
        rationale: "Tell the reporter.",
      },
      toolCallId: "call-2",
    });

    expect(proposals.map((proposal) => proposal.stepName)).toEqual(["branch", "comment"]);
    expect(proposals[1]?.references).toEqual({ "/body": { step: "branch", output: "branch" } });
    // The model never names the operation; Gardener derives that later.
    expect(proposals.every((proposal) => !("operationId" in proposal))).toBe(true);
  });

  it("is idempotent on an identical replayed proposal and rejects a conflicting step name", async () => {
    flue.useInitialData.mockReturnValue({ request: request() });
    GardenerTaskFlueAgent();
    const propose = tool("propose_effect");
    const data = {
      stepName: "comment",
      kind: "issue.comment.create",
      payloadJson: JSON.stringify({ ...issuePreconditions, body: "Once." }),
      rationale: "Say it once.",
    };

    await propose.run({ data, toolCallId: "call-1" });
    const replay = await propose.run({ data, toolCallId: "call-1-replay" });
    expect(replay.output).toMatchObject({ position: 1, totalProposed: 1, alreadyProposed: true });
    expect(proposals).toHaveLength(1);

    await expect(propose.run({
      data: { ...data, payloadJson: JSON.stringify({ ...issuePreconditions, body: "Twice." }) },
      toolCallId: "call-2",
    })).rejects.toThrow(/already proposed with different content/);
  });

  it("refuses payload and reference text that is not a JSON object", async () => {
    flue.useInitialData.mockReturnValue({ request: request() });
    GardenerTaskFlueAgent();
    const propose = tool("propose_effect");
    const base = { stepName: "comment", kind: "issue.comment.create", rationale: "why" };

    await expect(propose.run({ data: { ...base, payloadJson: "{oops" }, toolCallId: "c" }))
      .rejects.toThrow(/payloadJson is not valid JSON/);
    await expect(propose.run({ data: { ...base, payloadJson: "[1,2]" }, toolCallId: "c" }))
      .rejects.toThrow(/payloadJson must be a JSON object/);
    await expect(propose.run({ data: { ...base, payloadJson: "{}", referencesJson: "null" }, toolCallId: "c" }))
      .rejects.toThrow(/referencesJson must be a JSON object/);
  });

  it("cannot smuggle repository file bytes through the payload text", async () => {
    // The agent layer parses `payloadJson` but must not launder it: whatever
    // the model wrote arrives at the session verbatim, where the contract
    // refuses capture-owned pointers. If the agent ever reshaped a payload
    // into something acceptable, this is where that would show up.
    flue.useInitialData.mockReturnValue({ request: request() });
    GardenerTaskFlueAgent();

    await tool("propose_effect").run({
      data: {
        stepName: "commit",
        kind: "commit.create",
        payloadJson: JSON.stringify({
          branch: "gardener/fix",
          expectedHeadSha: "a".repeat(40),
          message: "Fix it.",
          files: [{ path: "src/a.ts", contentBase64: "AA==" }],
        }),
        rationale: "Commit bytes the model made up.",
      },
      toolCallId: "c",
    });

    const [{ proposal }] = proposeEffect.mock.calls[0] as [{ proposal: Record<string, unknown> }];
    expect((proposal.payload as Record<string, unknown>).files).toBeDefined();
    expect(() => taskEffectProposalV1Schema.parse(proposal))
      .toThrow(/\/files is materialized from the trusted repository capture/);
  });

  it("settles from the durable proposal list rather than anything the model repeats", async () => {
    const value = request();
    flue.useInitialData.mockReturnValue({ request: value });
    GardenerTaskFlueAgent();

    await tool("propose_effect").run({
      data: {
        stepName: "comment",
        kind: "issue.comment.create",
        payloadJson: JSON.stringify({ ...issuePreconditions, body: "Thanks." }),
        rationale: "Acknowledge the report.",
      },
      toolCallId: "call-1",
    });

    await expect(tool("finish_task").run({
      data: {
        summary: "README inspected.",
        observationsJson: JSON.stringify([{ kind: "repository", summary: "README.md was read.", paths: ["README.md"] }]),
      },
    })).resolves.toEqual({ output: { accepted: true, proposedEffects: 1, capturedFiles: 0 }, terminate: true });

    expect(writeTaskOutcome).toHaveBeenCalledWith({
      schemaVersion: "gardener.task-outcome/v1",
      runId: value.runId,
      taskId: "fixture.issue-triage",
      bundleHash: value.snapshot.agentRevisionHash,
      status: "completed",
      summary: "README inspected.",
      observations: [{ kind: "repository", summary: "README.md was read.", paths: ["README.md"] }],
      proposedEffects: [{
        stepName: "comment",
        kind: "issue.comment.create",
        payload: { ...issuePreconditions, body: "Thanks." },
        references: {},
        rationale: "Acknowledge the report.",
      }],
    });
  });

  it("settles a run that proposes nothing without inventing an effect", async () => {
    const value = request();
    flue.useInitialData.mockReturnValue({ request: value });
    GardenerTaskFlueAgent();

    await expect(tool("finish_task").run({ data: { summary: "Nothing to do." } }))
      .resolves.toEqual({ output: { accepted: true, proposedEffects: 0, capturedFiles: 0 }, terminate: true });
    expect(writeTaskOutcome.mock.calls[0]?.[0]).toMatchObject({ status: "completed", observations: [], proposedEffects: [] });
  });

  it("captures the working tree only when a proposed step commits it", async () => {
    const value = request();
    flue.useInitialData.mockReturnValue({ request: value });
    GardenerTaskFlueAgent();

    // An inspect-only run must not photograph the repository at all.
    await tool("propose_effect").run({
      data: {
        stepName: "comment",
        kind: "issue.comment.create",
        payloadJson: JSON.stringify({ ...issuePreconditions, body: "Thanks." }),
        rationale: "Acknowledge the report.",
      },
      toolCallId: "call-1",
    });
    await tool("finish_task").run({ data: { summary: "Nothing to commit." } });
    expect(captureRepository).not.toHaveBeenCalled();
  });

  it("captures exactly once, from the durable ledger, when a commit is proposed", async () => {
    const value = request();
    flue.useInitialData.mockReturnValue({ request: value });
    GardenerTaskFlueAgent();

    await tool("propose_effect").run({
      data: {
        stepName: "commit",
        kind: "commit.create",
        payloadJson: JSON.stringify({
          branch: "gardener/fix-1",
          expectedHeadSha: "a".repeat(40),
          message: "Fix it.",
        }),
        rationale: "Commit the change I made.",
      },
      toolCallId: "call-1",
    });

    await expect(tool("finish_task").run({ data: { summary: "Fixed." }, toolCallId: "call-2" }))
      .resolves.toEqual({
        output: { accepted: true, proposedEffects: 1, capturedFiles: 2 },
        terminate: true,
      });

    // Bound to this run and this terminal call, and carrying nothing the
    // model chose: the session decides what is captured and against which
    // commit.
    expect(captureRepository).toHaveBeenCalledTimes(1);
    expect(captureRepository).toHaveBeenCalledWith({
      runId: value.runId,
      requestId: value.requestId,
      toolCallId: "call-2",
    });
  });

  it("never mounts capture as a tool the model can call", async () => {
    flue.useInitialData.mockReturnValue({ request: request() });
    GardenerTaskFlueAgent();

    // The model's whole surface is the three mounted tools. A capture tool
    // would let it choose when the working tree is photographed, and keep
    // editing afterwards.
    const mounted = flue.useTool.mock.calls.map((call) => (call[0] as { name: string }).name);
    expect(mounted).toEqual(["propose_effect", "finish_task", "repository_read_file"]);
    expect(mounted.some((name) => /capture/.test(name))).toBe(false);
  });

  it("fails the terminal rather than settling a commit with no capture behind it", async () => {
    const value = request();
    flue.useInitialData.mockReturnValue({ request: value });
    GardenerTaskFlueAgent();
    captureRepository.mockRejectedValueOnce(new Error("working tree is unchanged"));

    await tool("propose_effect").run({
      data: {
        stepName: "commit",
        kind: "commit.create",
        payloadJson: JSON.stringify({
          branch: "gardener/fix-1",
          expectedHeadSha: "a".repeat(40),
          message: "Fix it.",
        }),
        rationale: "Commit the change I made.",
      },
      toolCallId: "call-1",
    });

    await expect(tool("finish_task").run({ data: { summary: "Fixed." }, toolCallId: "call-2" }))
      .rejects.toThrow(/working tree is unchanged/);
    // No outcome is written, so the run cannot settle as a success whose
    // commit has no contents.
    expect(writeTaskOutcome).not.toHaveBeenCalled();
  });

  it("requires exactly one terminal and no longer demands a particular repository call", () => {
    const value = request();
    flue.useInitialData.mockReturnValue({ request: value });
    GardenerTaskFlueAgent();
    const finish = flue.useAgentFinish.mock.calls.at(-1)![0];
    const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 };

    expect(() => finish({ response: { toolCalls: [{ tool: "finish_task", isError: false }], usage } })).not.toThrow();
    expect(() => finish({ response: { toolCalls: [{ tool: "propose_effect", isError: false }], usage } }))
      .toThrow(/task_completed_without_terminal_outcome/);
    expect(() => finish({
      response: { toolCalls: [{ tool: "finish_task", isError: false }, { tool: "finish_task", isError: false }], usage },
    })).toThrow(/task_has_multiple_terminal_outcomes/);
  });

  it("bounds input per request, not summed across turns, and output per run", () => {
    const value = request();
    flue.useInitialData.mockReturnValue({ request: value });
    GardenerTaskFlueAgent();
    const finish = flue.useAgentFinish.mock.calls.at(-1)![0];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const toolCalls = [{ tool: "finish_task", isError: false }];
    const { maxInputTokens, maxOutputTokens } = value.budget;
    // Every turn resends the conversation, so the run's summed input may exceed the per-request limit.
    expect(() => finish({ response: { toolCalls, usage: { input: maxInputTokens * 3, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 0 } } }))
      .not.toThrow();
    expect(() => finish({ response: { toolCalls, usage: { input: 1, output: maxOutputTokens + 1, cacheRead: 0, cacheWrite: 0, totalTokens: 0 } } }))
      .toThrow(/task_model_token_budget_exceeded/);
    expect(warn).toHaveBeenCalledWith("gardener task finish refused", { taskId: expect.any(String), reason: "task_model_token_budget_exceeded" });
    warn.mockRestore();
  });

  it("sets Flue's durability timeout past the longest runtime a bundle may declare", () => {
    const limits = { runtimeSeconds: MAX_TASK_RUNTIME_SECONDS, maxTurns: 3, maxToolCalls: 3, inputTokens: 1_000, outputTokens: 100 };
    expect(taskLimitsV1Schema.safeParse(limits).success).toBe(true);
    expect(taskLimitsV1Schema.safeParse({ ...limits, runtimeSeconds: MAX_TASK_RUNTIME_SECONDS + 1 }).success).toBe(false);
    expect((GardenerTaskFlueAgent as unknown as { durability: { timeoutMs: number } }).durability.timeoutMs)
      .toBeGreaterThan(MAX_TASK_RUNTIME_SECONDS * 1_000);
  });

  it("fails closed when a tool-bearing task has no trusted runner facade", () => {
    flue.useInitialData.mockReturnValue({ request: request() });
    installGardenerTaskToolFacade(undefined);
    expect(() => GardenerTaskFlueAgent()).toThrow(/runner tool facade is unavailable/);
  });
});
