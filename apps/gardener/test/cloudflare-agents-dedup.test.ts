import { describe, expect, it, vi } from "vitest";

vi.mock("agents", () => ({
  Agent: class {},
}));

import type { HarnessOutcome, HarnessRequest } from "../src/harness";
import { GardenerCloudflareAgentsHarness } from "../src/harness/cloudflare-agents/generic-agent";
import { expectedHarnessBinding } from "../src/harness/validation";

function request(): HarnessRequest {
  return {
    schemaVersion: "gardener.harness.request/v1",
    requestId: "request-dedup-1",
    runId: "run-dedup-1",
    snapshot: {
      agentRevisionId: "agent-revision-1",
      agentRevisionHash: "a".repeat(64),
      promptReference: "prompt:1",
      policySnapshotReference: "policy:1",
      toolCatalogVersion: "tools:1",
      harness: expectedHarnessBinding("cloudflare-agents"),
    },
    prompt: "Return one bounded result.",
    model: { id: "@cf/test/model" },
    tools: [],
    budget: {
      maxTurns: 1,
      maxToolCalls: 1,
      maxInputTokens: 1_000,
      maxOutputTokens: 500,
      maxRuntimeMs: 30_000,
    },
  };
}

function completedOutcome(value: HarnessRequest): HarnessOutcome {
  return {
    schemaVersion: "gardener.harness.outcome/v1",
    harness: value.snapshot.harness,
    runId: value.runId,
    requestId: value.requestId,
    submissionId: value.requestId,
    status: "completed",
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      model: value.model.id,
      turns: 1,
      toolCalls: 0,
    },
    events: [],
    result: { kind: "result", summary: "Done." },
  };
}

interface TestHarnessState {
  request: HarnessRequest | null;
  requests: Record<string, HarnessRequest>;
  outcomes: Record<string, HarnessOutcome>;
  cancelled: boolean;
}

interface HarnessTestDouble {
  executeHarnessRequest: GardenerCloudflareAgentsHarness["executeHarnessRequest"];
  state: TestHarnessState;
  setState: ReturnType<typeof vi.fn>;
  runBoundedLoop: ReturnType<typeof vi.fn>;
}

function testHarness(
  state: TestHarnessState,
  runOutcome?: HarnessOutcome,
): HarnessTestDouble {
  const harness = Object.create(GardenerCloudflareAgentsHarness.prototype) as unknown as HarnessTestDouble;
  Object.defineProperty(harness, "state", { configurable: true, writable: true, value: state });
  Object.defineProperty(harness, "setState", {
    configurable: true,
    value: vi.fn((next: TestHarnessState) => {
      harness.state = next;
    }),
  });
  Object.defineProperty(harness, "runBoundedLoop", {
    configurable: true,
    value: vi.fn(async (): Promise<HarnessOutcome> => {
      if (!runOutcome) throw new Error("model inference must not run");
      return runOutcome;
    }),
  });
  return harness;
}

function emptyState(): TestHarnessState {
  return { request: null, requests: {}, outcomes: {}, cancelled: false };
}

describe("Cloudflare Agents harness request deduplication", () => {
  it("returns the persisted exact outcome without rerunning inference", async () => {
    const original = request();
    const outcome = completedOutcome(original);
    const harness = testHarness(emptyState(), outcome);

    const first = await harness.executeHarnessRequest(original);
    const semanticallyIdentical: HarnessRequest = {
      budget: { ...original.budget },
      tools: [],
      model: { ...original.model },
      prompt: original.prompt,
      snapshot: {
        harness: { ...original.snapshot.harness },
        toolCatalogVersion: original.snapshot.toolCatalogVersion,
        policySnapshotReference: original.snapshot.policySnapshotReference,
        promptReference: original.snapshot.promptReference,
        agentRevisionHash: original.snapshot.agentRevisionHash,
        agentRevisionId: original.snapshot.agentRevisionId,
      },
      runId: original.runId,
      requestId: original.requestId,
      schemaVersion: original.schemaVersion,
    };
    const replay = await harness.executeHarnessRequest(semanticallyIdentical);

    expect(first.outcome).toBe(outcome);
    expect(replay.outcome).toBe(outcome);
    expect(replay.request).toBe(original);
    expect(replay.submission).toMatchObject({
      runId: original.runId,
      requestId: original.requestId,
      submissionId: original.requestId,
    });
    expect(harness.runBoundedLoop).toHaveBeenCalledTimes(1);
    expect(harness.setState).toHaveBeenCalledTimes(2);
  });

  it("rejects conflicting content for a persisted request id", async () => {
    const persisted = request();
    const harness = testHarness({
      ...emptyState(),
      request: persisted,
      requests: { [persisted.requestId]: persisted },
      outcomes: { [persisted.requestId]: completedOutcome(persisted) },
    });

    await expect(harness.executeHarnessRequest({
      ...persisted,
      prompt: "Different immutable prompt content.",
    })).rejects.toMatchObject({
      name: "HarnessContractError",
      code: "invalid-request",
    });
    expect(harness.runBoundedLoop).not.toHaveBeenCalled();
    expect(harness.setState).not.toHaveBeenCalled();
  });

  it("fails closed when an identical persisted request has no outcome", async () => {
    const persisted = request();
    const harness = testHarness({
      ...emptyState(),
      request: persisted,
      requests: { [persisted.requestId]: persisted },
    });

    await expect(harness.executeHarnessRequest({ ...persisted })).rejects.toMatchObject({
      name: "HarnessContractError",
      code: "integration-unavailable",
      message: expect.stringMatching(/ambiguous.*refusing duplicate inference/i),
    });
    expect(harness.runBoundedLoop).not.toHaveBeenCalled();
    expect(harness.setState).not.toHaveBeenCalled();
  });

  it("strictly validates a replay before consulting persisted state", async () => {
    const persisted = request();
    const harness = testHarness({
      ...emptyState(),
      request: persisted,
      requests: { [persisted.requestId]: persisted },
      outcomes: { [persisted.requestId]: completedOutcome(persisted) },
    });

    await expect(harness.executeHarnessRequest({
      ...persisted,
      credential: "must-not-cross-boundary",
    } as never)).rejects.toMatchObject({
      name: "HarnessContractError",
      code: "invalid-request",
      message: expect.stringMatching(/unknown fields/i),
    });
    expect(harness.runBoundedLoop).not.toHaveBeenCalled();
  });
});
