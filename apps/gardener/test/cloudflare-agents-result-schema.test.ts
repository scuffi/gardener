import { describe, expect, it, vi } from "vitest";

vi.mock("agents", () => ({ Agent: class {} }));

import type { HarnessOutcome, HarnessRequest } from "../src/harness";
import { GardenerCloudflareAgentsHarness } from "../src/harness/cloudflare-agents/generic-agent";
import { expectedHarnessBinding } from "../src/harness/validation";

function request(): HarnessRequest {
  return {
    schemaVersion: "gardener.harness.request/v1",
    requestId: "request-schema-1",
    runId: "run-schema-1",
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
    resultDataSchema: {
      type: "object",
      additionalProperties: false,
      properties: { body: { type: "string", minLength: 1, maxLength: 5 } },
      required: ["body"],
    },
    budget: {
      maxTurns: 1,
      maxToolCalls: 0,
      maxInputTokens: 10_000,
      maxOutputTokens: 10_000,
      maxRuntimeMs: 30_000,
    },
  };
}

function harnessWithResponse(response: unknown): {
  harness: GardenerCloudflareAgentsHarness;
  run: ReturnType<typeof vi.fn>;
} {
  const run = vi.fn(async () => response);
  const harness = Object.create(GardenerCloudflareAgentsHarness.prototype) as GardenerCloudflareAgentsHarness;
  const state = { request: null, requests: {}, outcomes: {}, cancelled: false };
  Object.defineProperty(harness, "state", { configurable: true, writable: true, value: state });
  Object.defineProperty(harness, "setState", {
    configurable: true,
    value: (next: typeof state) => Object.defineProperty(harness, "state", { configurable: true, writable: true, value: next }),
  });
  Object.defineProperty(harness, "env", {
    configurable: true,
    value: { AI: { run }, GARDENER_HARNESS_TOOLS: { invoke: vi.fn() } },
  });
  return { harness, run };
}

function completed(body: string): unknown {
  return {
    response: {
      status: "completed",
      result: { kind: "result", summary: "Done.", data: { body } },
    },
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function expectFailure(outcome: HarnessOutcome): void {
  expect(outcome).toMatchObject({
    status: "failed",
    error: { code: "unsupported-model-response", retryable: false },
  });
}

describe("Cloudflare Agents completed-only result schemas", () => {
  it("sends the host schema to Workers AI and independently accepts matching result data", async () => {
    const value = request();
    const { harness, run } = harnessWithResponse(completed("hello"));
    const execution = await harness.executeHarnessRequest(value);

    expect(execution.outcome).toMatchObject({ status: "completed", result: { data: { body: "hello" } } });
    expect(run).toHaveBeenCalledWith(value.model.id, expect.objectContaining({
      response_format: expect.objectContaining({ type: "json_schema" }),
    }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    const input = run.mock.calls[0]![1] as { response_format: { json_schema: { properties: { result: { properties: { data: unknown } } } } } };
    expect(input.response_format.json_schema.properties.result.properties.data).toEqual(value.resultDataSchema);
  });

  it("fails closed when provider result data violates the host schema", async () => {
    const { harness } = harnessWithResponse(completed("too long"));
    const execution = await harness.executeHarnessRequest(request());
    expectFailure(execution.outcome);
    expect(execution.outcome.status === "failed" ? execution.outcome.error.message : "").toMatch(/violated resultDataSchema.*maxLength/i);
  });

  it("fails closed when a provider ignores completed-only semantics", async () => {
    const interrupted = harnessWithResponse({ response: { status: "interrupted", interruption: { kind: "human-input", reason: "Question" } } });
    const interruptedExecution = await interrupted.harness.executeHarnessRequest(request());
    expectFailure(interruptedExecution.outcome);
    expect(interruptedExecution.outcome.status === "failed" ? interruptedExecution.outcome.error.message : "").toMatch(/interruption.*completed-only/i);

    const tool = harnessWithResponse({ response: { status: "tool", toolName: "read_file", input: { path: "README.md" } } });
    const toolExecution = await tool.harness.executeHarnessRequest({ ...request(), requestId: "request-schema-tool" });
    expectFailure(toolExecution.outcome);
    expect(toolExecution.outcome.status === "failed" ? toolExecution.outcome.error.message : "").toMatch(/non-completed.*completed-only/i);
  });
});
