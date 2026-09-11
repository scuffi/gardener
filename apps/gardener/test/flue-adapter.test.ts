import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessRequest, HarnessRequestStore, HarnessSubmission } from "../src/harness";
import { expectedHarnessBinding } from "../src/harness";

const flue = vi.hoisted(() => ({
  abort: vi.fn(async () => undefined),
  dispatch: vi.fn(async (_input: { message: string; initialData?: unknown; idempotencyKey: string }) => ({ submissionId: "submission-1", acceptedAt: "2026-09-11T10:00:00.000Z" })),
  getAgentInstance: vi.fn(async () => ({ id: "run-1" })),
  setProvider: vi.fn(),
  read: vi.fn(async (): Promise<{ text: string; metadata?: Record<string, unknown> }> => ({
    text: JSON.stringify({ status: "completed", result: { kind: "result", summary: "Bounded proposal", data: { body: "Hello" } } }),
    metadata: { gardenerHarnessUsage: { uncachedInputTokens: 10, cacheReadTokens: 2, cacheWriteTokens: 0, outputTokens: 8, totalTokens: 20, turns: 1, toolCalls: 0 } },
  })),
  init: vi.fn(),
  useInitialData: vi.fn(),
  useInstruction: vi.fn(),
  useModel: vi.fn(),
  useResponseFinish: vi.fn(),
  useTool: vi.fn(),
}));

vi.mock("@flue/runtime", () => ({
  AgentRunError: class AgentRunError extends Error { outcome = "failed"; },
  getAgentInstance: flue.getAgentInstance,
  init: flue.init,
  setProvider: flue.setProvider,
  useInitialData: flue.useInitialData,
  useInstruction: flue.useInstruction,
  useModel: flue.useModel,
  useResponseFinish: flue.useResponseFinish,
  useTool: flue.useTool,
}));
vi.mock("@flue/runtime/cloudflare", () => ({ extend: vi.fn(() => ({})) }));

import { createFlueHarness } from "../src/harness/flue/adapter";
import { GardenerFlueAgent, installGardenerFlueToolFacade } from "../src/harness/flue/generic-agent";

function request(): HarnessRequest {
  return {
    schemaVersion: "gardener.harness.request/v1",
    requestId: "request-1",
    runId: "run-1",
    snapshot: {
      agentRevisionId: "revision-1",
      agentRevisionHash: "a".repeat(64),
      promptReference: "prompt:1",
      policySnapshotReference: "policy:1",
      toolCatalogVersion: "tools:1",
      harness: expectedHarnessBinding("flue"),
    },
    prompt: "Return one bounded proposal.",
    model: { id: "@cf/test/model" },
    tools: [],
    resultDataSchema: {
      type: "object",
      additionalProperties: false,
      properties: { body: { type: "string" } },
      required: ["body"],
    },
    budget: { maxTurns: 1, maxToolCalls: 0, maxInputTokens: 1_000, maxOutputTokens: 500, maxRuntimeMs: 30_000, deadlineAt: "2099-01-01T00:00:00.000Z" },
  };
}

class MemoryRequestStore implements HarnessRequestStore {
  value: HarnessRequest | null = null;
  submission: HarnessSubmission | null = null;
  async put(value: HarnessRequest) { this.value = structuredClone(value); }
  async get(runId: string, requestId: string) {
    return this.value?.runId === runId && this.value.requestId === requestId ? structuredClone(this.value) : null;
  }
  async putSubmission(value: NonNullable<MemoryRequestStore["submission"]>) { this.submission = structuredClone(value); }
  async getSubmission(runId: string, requestId: string) {
    return this.submission?.runId === runId && this.submission.requestId === requestId ? structuredClone(this.submission) : null;
  }
}

describe("Flue harness adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installGardenerFlueToolFacade(undefined);
    flue.init.mockReturnValue({ dispatch: flue.dispatch, read: flue.read, abort: flue.abort });
  });

  it("allows model-only Agents without provisioning a tool facade", () => {
    const value = request();
    flue.useInitialData.mockReturnValue({ request: value });

    expect(GardenerFlueAgent()).toBe(value.prompt);
    expect(flue.useModel).toHaveBeenCalledWith(
      expect.stringMatching(/^cloudflare\/gardener-bounded-v1:1000:500:30000:\d+:%40cf%2Ftest%2Fmodel:[A-Za-z0-9_-]+$/),
      { compaction: false },
    );
    expect(flue.useTool).not.toHaveBeenCalled();
  });

  it("rejects an output budget below Flue's provider floor before persistence or dispatch", async () => {
    const value = request();
    value.budget.maxOutputTokens = 15;
    const store = new MemoryRequestStore();
    const harness = createFlueHarness(store);

    await expect(harness.start(value)).rejects.toMatchObject({ code: "invalid-request" });
    expect(store.value).toBeNull();
    expect(flue.dispatch).not.toHaveBeenCalled();
  });

  it("rejects tool-bearing requests before persistence or Flue dispatch", async () => {
    const value = request();
    delete value.resultDataSchema;
    value.tools = [{ name: "read_file", description: "Read a workspace file", authority: "workspace" }];
    value.budget.maxToolCalls = 1;
    const store = new MemoryRequestStore();
    const harness = createFlueHarness(store);

    await expect(harness.start(value)).rejects.toMatchObject({ code: "integration-unavailable" });
    expect(store.value).toBeNull();
    expect(flue.dispatch).not.toHaveBeenCalled();
  });

  it("persists the immutable request and uses its id as Flue's idempotency key", async () => {
    const store = new MemoryRequestStore();
    const harness = createFlueHarness(store);
    const value = request();

    const submission = await harness.start(value);
    expect(store.value).toEqual(value);
    expect(flue.init).toHaveBeenCalledWith(expect.any(Function), { id: value.runId, uid: null });
    expect(flue.dispatch).toHaveBeenCalledWith({
      message: value.prompt,
      initialData: { request: value },
      idempotencyKey: value.requestId,
    });
    expect(submission).toMatchObject({ harness: expectedHarnessBinding("flue"), submissionId: "submission-1" });
    await expect(harness.start({ ...value, model: { id: "@cf/changed-after-deploy" } })).resolves.toEqual(submission);
    expect(store.value).toEqual(value);
    expect(flue.dispatch).toHaveBeenCalledTimes(1);
    await expect(harness.read(submission)).resolves.toMatchObject({
      status: "completed",
      result: { data: { body: "Hello" } },
      usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20, turns: 1, toolCalls: 0 },
    });
  });

  it("reuses the same idempotency key if receipt persistence fails after dispatch", async () => {
    class FailingOnceStore extends MemoryRequestStore {
      private fail = true;
      override async putSubmission(value: HarnessSubmission) {
        if (this.fail) {
          this.fail = false;
          throw new Error("simulated D1 loss after dispatch");
        }
        await super.putSubmission(value);
      }
    }
    const store = new FailingOnceStore();
    const harness = createFlueHarness(store);
    const value = request();

    await expect(harness.start(value)).rejects.toThrow(/simulated D1 loss/);
    await expect(harness.start(value)).resolves.toMatchObject({ submissionId: "submission-1" });
    expect(flue.dispatch).toHaveBeenCalledTimes(2);
    expect(flue.dispatch.mock.calls.map(([input]) => input.idempotencyKey)).toEqual([value.requestId, value.requestId]);
  });

  it("binds reads to the immutable accepted submission receipt", async () => {
    const harness = createFlueHarness(new MemoryRequestStore());
    const submission = await harness.start(request());
    flue.read.mockClear();

    await expect(harness.read({ ...submission, submissionId: "different-submission" }))
      .rejects.toMatchObject({ code: "invalid-request" });
    expect(flue.read).not.toHaveBeenCalled();
  });

  it("fails closed when Flue normalizes missing provider usage to zero", async () => {
    flue.read.mockResolvedValueOnce({
      text: JSON.stringify({ status: "completed", result: { kind: "abstain", summary: "No action", data: null } }),
      metadata: { gardenerHarnessUsage: { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, totalTokens: 0, turns: 1, toolCalls: 0 } },
    });
    const harness = createFlueHarness(new MemoryRequestStore());
    const submission = await harness.start(request());

    await expect(harness.read(submission)).resolves.toMatchObject({
      status: "failed",
      error: { code: "invalid-outcome", retryable: false },
    });
  });

  it("fails closed when provider usage totals are inconsistent", async () => {
    flue.read.mockResolvedValueOnce({
      text: JSON.stringify({ status: "completed", result: { kind: "abstain", summary: "No action", data: null } }),
      metadata: { gardenerHarnessUsage: { uncachedInputTokens: 3, cacheReadTokens: 2, cacheWriteTokens: 0, outputTokens: 4, totalTokens: 8, turns: 1, toolCalls: 0 } },
    });
    const harness = createFlueHarness(new MemoryRequestStore());
    const submission = await harness.start(request());

    await expect(harness.read(submission)).resolves.toMatchObject({
      status: "failed",
      error: { code: "invalid-outcome", retryable: false },
    });
  });

  it("fails closed when Flue omits usage metadata", async () => {
    flue.read.mockResolvedValueOnce({ text: JSON.stringify({ status: "completed", result: { kind: "abstain", summary: "No action", data: null } }) });
    const harness = createFlueHarness(new MemoryRequestStore());
    const submission = await harness.start(request());

    await expect(harness.read(submission)).resolves.toMatchObject({
      status: "failed",
      error: { code: "invalid-outcome", retryable: false },
    });
  });

  it("durably aborts a submission whose immutable runtime deadline expired", async () => {
    const value = request();
    value.budget.deadlineAt = "2020-01-01T00:00:00.000Z";
    const harness = createFlueHarness(new MemoryRequestStore());
    const submission = await harness.start(value);
    flue.read.mockClear();

    await expect(harness.read(submission)).resolves.toMatchObject({
      status: "failed",
      error: { code: "budget-exceeded", retryable: false },
    });
    expect(flue.abort).toHaveBeenCalledOnce();
    expect(flue.read).not.toHaveBeenCalled();
  });

  it("normalizes one schema-valid JSON object wrapped by streaming-model prose", async () => {
    flue.read.mockResolvedValueOnce({
      text: 'Here is the result:\n```json\n{"status":"completed","result":{"kind":"result","summary":"Proposal","data":{"body":"Hello"}}}\n```',
      metadata: { gardenerHarnessUsage: { uncachedInputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 6, totalTokens: 10, turns: 1, toolCalls: 0 } },
    });
    const harness = createFlueHarness(new MemoryRequestStore());
    const submission = await harness.start(request());

    await expect(harness.read(submission)).resolves.toMatchObject({
      status: "completed",
      result: { data: { body: "Hello" } },
    });
  });

  it("fails closed when wrapping contains more than one JSON object", async () => {
    flue.read.mockResolvedValueOnce({
      text: '{"status":"completed"}\n{"status":"completed"}',
      metadata: { gardenerHarnessUsage: { uncachedInputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 6, totalTokens: 10, turns: 1, toolCalls: 0 } },
    });
    const harness = createFlueHarness(new MemoryRequestStore());
    const submission = await harness.start(request());

    await expect(harness.read(submission)).resolves.toMatchObject({
      status: "failed",
      error: { code: "unsupported-model-response", retryable: false },
    });
  });

  it("fails closed when Flue returns non-JSON output", async () => {
    flue.read.mockResolvedValueOnce({
      text: "not json",
      metadata: { gardenerHarnessUsage: { uncachedInputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1, totalTokens: 2, turns: 1, toolCalls: 0 } },
    });
    const harness = createFlueHarness(new MemoryRequestStore());
    const submission = await harness.start(request());

    await expect(harness.read(submission)).resolves.toMatchObject({
      status: "failed",
      error: { code: "unsupported-model-response", retryable: false },
    });
  });
});
