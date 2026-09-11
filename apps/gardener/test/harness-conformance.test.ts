import { describe, expect, it, vi } from "vitest";
import {
  HARNESS_ADAPTER_VERSIONS,
  createValidatedHarness,
  expectedHarnessBinding,
  type HarnessBackend,
  type HarnessId,
  type HarnessOutcome,
  type HarnessRequest,
  type HarnessSubmission,
} from "../src/harness";

const ids: HarnessId[] = ["flue"];

function fixture(id: HarnessId): HarnessRequest {
  return {
    schemaVersion: "gardener.harness.request/v1",
    requestId: `request-${id}`,
    runId: `run-${id}`,
    snapshot: {
      agentRevisionId: "revision-7",
      agentRevisionHash: "b".repeat(64),
      promptReference: "prompt:7",
      policySnapshotReference: "policy:12",
      toolCatalogVersion: "catalog:3",
      harness: expectedHarnessBinding(id),
    },
    prompt: "Return a structured maintenance recommendation.",
    model: { id: "@cf/test/model" },
    tools: [{ name: "grep", description: "Search the isolated workspace", authority: "workspace" }],
    budget: {
      maxTurns: 2,
      maxToolCalls: 1,
      maxInputTokens: 100,
      maxOutputTokens: 50,
      maxRuntimeMs: 5_000,
      deadlineAt: "2099-01-01T00:00:00.000Z",
    },
  };
}

function submission(request: HarnessRequest): HarnessSubmission {
  return {
    schemaVersion: "gardener.harness.submission/v1",
    harness: request.snapshot.harness,
    runId: request.runId,
    requestId: request.requestId,
    submissionId: `${request.requestId}:submission`,
    acceptedAt: "2026-09-09T10:00:00.000Z",
  };
}

function completed(request: HarnessRequest, target = submission(request)): Extract<HarnessOutcome, { status: "completed" }> {
  return {
    schemaVersion: "gardener.harness.outcome/v1",
    harness: request.snapshot.harness,
    runId: request.runId,
    requestId: request.requestId,
    submissionId: target.submissionId,
    status: "completed",
    result: { kind: "result", summary: "No change is necessary.", data: { confidence: 0.9 } },
    usage: {
      inputTokens: 40,
      outputTokens: 10,
      totalTokens: 50,
      model: request.model.id,
      turns: 1,
      toolCalls: 1,
    },
    events: [{
      type: "activity",
      sequence: 0,
      at: "2026-09-09T10:00:01.000Z",
      activity: "reasoning",
      status: "completed",
      name: "turn-0",
    }],
  };
}

function backendFor(request: HarnessRequest, outcome: unknown = completed(request)): HarnessBackend {
  const target = submission(request);
  return {
    start: vi.fn(async () => target),
    submit: vi.fn(async () => target),
    read: vi.fn(async () => ({ request, outcome })),
    cancel: vi.fn(async ({ runId }) => ({ runId, cancelled: true })),
  };
}

function harness(id: HarnessId, backend: HarnessBackend) {
  return createValidatedHarness({
    id,
    adapterVersion: HARNESS_ADAPTER_VERSIONS[id],
    capabilities: ["reasoning", "structured-outcome", "cancellation"],
    preview: false,
  }, backend);
}

describe.each(ids)("%s harness conformance", (id) => {
  it("validates admission, structured outcomes, events, and cancellation", async () => {
    const request = fixture(id);
    const backend = backendFor(request);
    const adapter = harness(id, backend);
    const seen: string[] = [];

    const started = await adapter.start(request);
    expect(started).toEqual(submission(request));
    await expect(adapter.submit(request)).resolves.toEqual(started);
    await expect(adapter.read(started, { onEvent: (event) => seen.push(event.type) })).resolves.toMatchObject({
      status: "completed",
      result: { kind: "result", summary: "No change is necessary." },
    });
    await expect(adapter.cancel({ runId: request.runId, reason: "Owner cancelled" })).resolves.toEqual({
      runId: request.runId,
      cancelled: true,
    });
    expect(seen).toEqual(["activity"]);
  });

  it("converts provider usage beyond the immutable budget into a typed failure", async () => {
    const request = fixture(id);
    const outcome = completed(request);
    outcome.usage.turns = request.budget.maxTurns + 1;
    const adapter = harness(id, backendFor(request, outcome));
    const started = await adapter.start(request);

    await expect(adapter.read(started)).resolves.toMatchObject({
      status: "failed",
      error: { code: "budget-exceeded", retryable: false },
    });
  });

  it("fails closed when completed data violates the host-owned result schema", async () => {
    const request = fixture(id);
    request.tools = [];
    request.resultDataSchema = {
      type: "object",
      additionalProperties: false,
      properties: { confidence: { type: "number", maximum: 1 } },
      required: ["confidence"],
    };
    const outcome = completed(request);
    outcome.result.data = { confidence: 2 };
    outcome.usage.toolCalls = 0;
    const adapter = harness(id, backendFor(request, outcome));
    const started = await adapter.start(request);

    await expect(adapter.read(started)).resolves.toMatchObject({
      status: "failed",
      error: { code: "unsupported-model-response", retryable: false },
    });
  });

  it("rejects malformed or identity-swapped provider results", async () => {
    const request = fixture(id);
    const outcome = completed(request) as HarnessOutcome & { runId: string };
    outcome.runId = "another-run";
    const adapter = harness(id, backendFor(request, outcome));
    const started = await adapter.start(request);
    await expect(adapter.read(started)).rejects.toMatchObject({ code: "invalid-outcome" });
  });

  it("rejects authority expansion before invoking the provider", async () => {
    const request = fixture(id);
    request.tools = [{
      name: "policy_approve",
      description: "Escalate authority",
      authority: "policy",
    } as never];
    const backend = backendFor(fixture(id));
    const adapter = harness(id, backend);

    await expect(adapter.start(request)).rejects.toMatchObject({ code: "invalid-request" });
    expect(backend.start).not.toHaveBeenCalled();
  });
});
