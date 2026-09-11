import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessBudget } from "../src/harness";

const mocks = vi.hoisted(() => ({
  baseStream: vi.fn((_model: unknown, _context: unknown, _options?: { onPayload?: (payload: unknown, model: { api: string }) => Promise<unknown> }) => "stream-result"),
  baseStreamSimple: vi.fn((_model: unknown, _context: unknown, _options?: { onPayload?: (payload: unknown, model: { api: string }) => Promise<unknown> }) => "simple-result"),
  setProvider: vi.fn(),
}));

vi.mock("@flue/runtime", () => ({ setProvider: mocks.setProvider }));
vi.mock("@flue/runtime/cloudflare/workers-ai", () => ({
  cloudflareBindingProvider: vi.fn(() => ({
    id: "cloudflare",
    name: "Cloudflare Workers AI",
    auth: {},
    getModels: () => [],
    stream: mocks.baseStream,
    streamSimple: mocks.baseStreamSimple,
  })),
}));

import {
  boundedCloudflareModel,
  installBoundedCloudflareProvider,
} from "../src/harness/flue/bounded-cloudflare-provider";

const budget: HarnessBudget = {
  maxTurns: 1,
  maxToolCalls: 0,
  maxInputTokens: 1_000,
  maxOutputTokens: 77,
  maxRuntimeMs: 30_000,
  deadlineAt: "2099-01-01T00:00:00.000Z",
};

describe("bounded Flue Cloudflare provider", () => {
  beforeEach(() => vi.clearAllMocks());

  it("adapts a real non-streaming Workers AI Response envelope into Flue events", async () => {
    const responseBody = {
      response: { status: "completed", result: { kind: "result", summary: "Done", data: { body: "Hello" } } },
      response_id: "response-1",
      usage: { prompt_tokens: 9, completion_tokens: 6, total_tokens: 15 },
    };
    const run = vi.fn(async () => new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { "cf-aig-log-id": "gateway-log-1" },
    }));
    const onResponse = vi.fn();
    installBoundedCloudflareProvider({ run });
    const provider = mocks.setProvider.mock.calls.at(-1)?.[0];
    const resultDataSchema = { type: "object", additionalProperties: false, properties: { body: { type: "string" } }, required: ["body"] };
    const encoded = boundedCloudflareModel("@cf/test/model", budget, resultDataSchema).slice("cloudflare/".length);

    const events = [];
    for await (const event of provider.stream(
      { id: encoded, name: encoded, provider: "cloudflare", api: "cloudflare-ai-binding", input: ["text"], reasoning: true },
      { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
      {
        maxTokens: 500,
        temperature: 0.2,
        sessionId: "run-1",
        headers: { "x-custom": "yes" },
        reasoning: "high",
        onResponse,
      },
    )) events.push(event);

    expect(mocks.baseStream).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledWith(
      "@cf/test/model",
      expect.objectContaining({
        stream: false,
        max_tokens: 77,
        temperature: 0.2,
        reasoning_effort: "high",
        response_format: {
          type: "json_schema",
          json_schema: expect.objectContaining({
            properties: expect.objectContaining({
              result: expect.objectContaining({
                properties: expect.objectContaining({ data: resultDataSchema }),
              }),
            }),
          }),
        },
      }),
      expect.objectContaining({
        returnRawResponse: true,
        signal: expect.objectContaining({ aborted: false }),
        extraHeaders: { "x-session-affinity": "run-1", "x-custom": "yes" },
        gateway: { id: "default" },
      }),
    );
    expect(onResponse).toHaveBeenCalledWith(
      { status: 200, headers: expect.objectContaining({ "cf-aig-log-id": "gateway-log-1" }) },
      expect.objectContaining({ id: "@cf/test/model" }),
    );
    expect(events.map((event) => event.type)).toEqual(["start", "text_start", "text_delta", "text_end", "done"]);
    expect(events.at(-1)).toMatchObject({
      type: "done",
      message: {
        content: [{ type: "text", text: JSON.stringify({ status: "completed", result: { kind: "result", summary: "Done", data: { body: "Hello" } } }) }],
        responseId: "response-1",
        usage: { input: 9, output: 6, totalTokens: 15 },
      },
    });
  });

  it("uses the OpenAI Chat Completions structured-output payload shape", async () => {
    installBoundedCloudflareProvider({ run: vi.fn() });
    const provider = mocks.setProvider.mock.calls.at(-1)?.[0];
    const encoded = boundedCloudflareModel("openai/test", budget, { type: "object" }).slice("cloudflare/".length);
    provider.stream(
      { id: encoded, name: encoded, provider: "cloudflare", api: "openai-completions" },
      { messages: [] },
      {},
    );
    const options = mocks.baseStream.mock.calls.at(-1)![2]!;
    await expect(options.onPayload!(
      { messages: [], stream: true },
      { api: "openai-completions" },
    )).resolves.toMatchObject({
      response_format: {
        type: "json_schema",
        json_schema: { name: "gardener_harness_decision", strict: true, schema: expect.any(Object) },
      },
    });
  });

  it("uses the OpenAI Responses structured-output payload shape", async () => {
    installBoundedCloudflareProvider({ run: vi.fn() });
    const provider = mocks.setProvider.mock.calls.at(-1)?.[0];
    const encoded = boundedCloudflareModel("openai/test", budget, { type: "object" }).slice("cloudflare/".length);
    provider.stream(
      { id: encoded, name: encoded, provider: "cloudflare", api: "openai-responses" },
      { messages: [] },
      {},
    );
    const options = mocks.baseStream.mock.calls.at(-1)![2]!;
    await expect(options.onPayload!(
      { input: [], stream: true },
      { api: "openai-responses" },
    )).resolves.toMatchObject({
      text: { format: { type: "json_schema", name: "gardener_harness_decision", strict: true } },
    });
  });

  it("remeasures the final provider payload after injecting the result schema", async () => {
    const run = vi.fn();
    installBoundedCloudflareProvider({ run });
    const provider = mocks.setProvider.mock.calls.at(-1)?.[0];
    const limited = { ...budget, maxInputTokens: 100 };
    const encoded = boundedCloudflareModel("@cf/test/model", limited, {
      type: "object",
      description: "x".repeat(300),
    }).slice("cloudflare/".length);
    const events = [];
    for await (const event of provider.stream(
      { id: encoded, name: encoded, provider: "cloudflare", api: "cloudflare-ai-binding", input: ["text"], reasoning: false },
      { messages: [] },
      {},
    )) events.push(event);

    expect(run).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error", error: { stopReason: "error" } });
  });

  it("normalizes a string-valued Workers AI response without exposing a second provider call", async () => {
    const decision = '{"status":"completed","result":{"kind":"abstain","summary":"No action","data":null}}';
    const run = vi.fn(async () => ({
      response: decision,
      usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
    }));
    installBoundedCloudflareProvider({ run });
    const provider = mocks.setProvider.mock.calls.at(-1)?.[0];
    const encoded = boundedCloudflareModel("@cf/test/model", budget).slice("cloudflare/".length);
    const events = [];
    for await (const event of provider.stream(
      { id: encoded, name: encoded, provider: "cloudflare", api: "cloudflare-ai-binding", input: ["text"], reasoning: false },
      { messages: [] },
      {},
    )) events.push(event);

    expect(run).toHaveBeenCalledOnce();
    expect(events.at(-1)).toMatchObject({ type: "done", message: { content: [{ type: "text", text: decision }] } });
  });

  it("omits framework-owned tools without charging their schemas to the model-only input budget", async () => {
    const run = vi.fn(async (_model: string, _payload: Record<string, unknown>) => ({
      response: { status: "completed", result: { kind: "abstain", summary: "No action", data: null } },
      usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
    }));
    installBoundedCloudflareProvider({ run });
    const provider = mocks.setProvider.mock.calls.at(-1)?.[0];
    const boundedInput = { ...budget, maxInputTokens: 4_000 };
    const encoded = boundedCloudflareModel("@cf/test/model", boundedInput).slice("cloudflare/".length);
    const frameworkTool = {
      name: "task",
      description: `Framework-owned delegation seam ${"x".repeat(12_000)}`,
      parameters: { type: "object" },
    };
    const events = [];
    for await (const event of provider.stream(
      { id: encoded, name: encoded, provider: "cloudflare", api: "cloudflare-ai-binding", input: ["text"], reasoning: false },
      { messages: [], tools: [frameworkTool] },
      {},
    )) events.push(event);

    expect(new TextEncoder().encode(JSON.stringify({ messages: [], tools: [frameworkTool] })).byteLength)
      .toBeGreaterThan(boundedInput.maxInputTokens);
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]![1]).not.toHaveProperty("tools");
    expect(new TextEncoder().encode(JSON.stringify(run.mock.calls[0]![1])).byteLength)
      .toBeLessThanOrEqual(boundedInput.maxInputTokens);
    expect(events.at(-1)).toMatchObject({ type: "done" });
  });

  it("applies the same omitted-tool budget rule through streamSimple", async () => {
    const run = vi.fn(async (_model: string, _payload: Record<string, unknown>) => ({
      response: { status: "completed", result: { kind: "abstain", summary: "No action", data: null } },
      usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
    }));
    installBoundedCloudflareProvider({ run });
    const provider = mocks.setProvider.mock.calls.at(-1)?.[0];
    const boundedInput = { ...budget, maxInputTokens: 4_000 };
    const encoded = boundedCloudflareModel("@cf/test/model", boundedInput).slice("cloudflare/".length);
    const events = [];
    for await (const event of provider.streamSimple(
      { id: encoded, name: encoded, provider: "cloudflare", api: "cloudflare-ai-binding", input: ["text"], reasoning: false },
      {
        messages: [],
        tools: [{ name: "task", description: "x".repeat(12_000), parameters: { type: "object" } }],
      },
      {},
    )) events.push(event);

    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]![1]).not.toHaveProperty("tools");
    expect(new TextEncoder().encode(JSON.stringify(run.mock.calls[0]![1])).byteLength)
      .toBeLessThanOrEqual(boundedInput.maxInputTokens);
    expect(events.at(-1)).toMatchObject({ type: "done" });
  });

  it("fails the Flue stream when Workers AI omits structured response data", async () => {
    const run = vi.fn(async () => ({ usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 } }));
    installBoundedCloudflareProvider({ run });
    const provider = mocks.setProvider.mock.calls.at(-1)?.[0];
    const encoded = boundedCloudflareModel("@cf/test/model", budget).slice("cloudflare/".length);
    const events = [];
    for await (const event of provider.stream(
      { id: encoded, name: encoded, provider: "cloudflare", api: "cloudflare-ai-binding", input: ["text"], reasoning: false },
      { messages: [] },
      {},
    )) events.push(event);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "error",
      error: { stopReason: "error", errorMessage: "Workers AI structured response is missing response data" },
    });
  });

  it("leaves malformed Workers AI usage at zero for the adapter to reject", async () => {
    const run = vi.fn(async () => ({
      response: { status: "completed", result: { kind: "abstain", summary: "No action", data: null } },
      usage: { prompt_tokens: "unknown", completion_tokens: null, total_tokens: -1 },
    }));
    installBoundedCloudflareProvider({ run });
    const provider = mocks.setProvider.mock.calls.at(-1)?.[0];
    const encoded = boundedCloudflareModel("@cf/test/model", budget).slice("cloudflare/".length);
    const events = [];
    for await (const event of provider.stream(
      { id: encoded, name: encoded, provider: "cloudflare", api: "cloudflare-ai-binding", input: ["text"], reasoning: false },
      { messages: [] },
      {},
    )) events.push(event);

    expect(events.at(-1)).toMatchObject({
      type: "done",
      message: { usage: { input: 0, output: 0, totalTokens: 0 } },
    });
  });

  it("marks thrown binding failures retryable without exposing their message", async () => {
    const leaked = "socket reset while sending secret-output";
    const run = vi.fn(async () => { throw new Error(leaked); });
    installBoundedCloudflareProvider({ run });
    const provider = mocks.setProvider.mock.calls.at(-1)?.[0];
    const encoded = boundedCloudflareModel("@cf/test/model", budget).slice("cloudflare/".length);
    const events = [];
    for await (const event of provider.stream(
      { id: encoded, name: encoded, provider: "cloudflare", api: "cloudflare-ai-binding", input: ["text"], reasoning: false },
      { messages: [] },
      {},
    )) events.push(event);

    expect(events[0]).toMatchObject({
      type: "error",
      error: { errorMessage: "Workers AI transient binding failure (retryable_interruption)" },
    });
    expect(JSON.stringify(events)).not.toContain(leaked);
  });

  it.each([429, 503])("marks HTTP %i retryable without reading its body", async (status) => {
    const run = vi.fn(async () => new Response("sensitive upstream body", { status }));
    installBoundedCloudflareProvider({ run });
    const provider = mocks.setProvider.mock.calls.at(-1)?.[0];
    const encoded = boundedCloudflareModel("@cf/test/model", budget).slice("cloudflare/".length);
    const events = [];
    for await (const event of provider.stream(
      { id: encoded, name: encoded, provider: "cloudflare", api: "cloudflare-ai-binding", input: ["text"], reasoning: false },
      { messages: [] },
      {},
    )) events.push(event);

    expect(events[0]).toMatchObject({
      type: "error",
      error: { errorMessage: `Workers AI transient HTTP ${status} (retryable_interruption)` },
    });
    expect(JSON.stringify(events)).not.toContain("sensitive upstream body");
  });

  it("keeps a non-retryable HTTP rejection content-free", async () => {
    const run = vi.fn(async () => new Response("sensitive validation detail", { status: 400 }));
    installBoundedCloudflareProvider({ run });
    const provider = mocks.setProvider.mock.calls.at(-1)?.[0];
    const encoded = boundedCloudflareModel("@cf/test/model", budget).slice("cloudflare/".length);
    const events = [];
    for await (const event of provider.stream(
      { id: encoded, name: encoded, provider: "cloudflare", api: "cloudflare-ai-binding", input: ["text"], reasoning: false },
      { messages: [] },
      {},
    )) events.push(event);

    expect(events[0]).toMatchObject({
      type: "error",
      error: { errorMessage: "Workers AI rejected request with HTTP 400" },
    });
    expect(JSON.stringify(events)).not.toContain("sensitive validation detail");
    expect(JSON.stringify(events)).not.toContain("retryable_interruption");
  });

  it("propagates an already-aborted signal and emits an aborted Flue event", async () => {
    const controller = new AbortController();
    controller.abort();
    const run = vi.fn(async (_model: string, _payload: unknown, options?: Record<string, unknown>) => {
      expect((options?.signal as AbortSignal).aborted).toBe(true);
      throw new DOMException("aborted", "AbortError");
    });
    installBoundedCloudflareProvider({ run });
    const provider = mocks.setProvider.mock.calls.at(-1)?.[0];
    const encoded = boundedCloudflareModel("@cf/test/model", budget).slice("cloudflare/".length);
    const events = [];
    for await (const event of provider.stream(
      { id: encoded, name: encoded, provider: "cloudflare", api: "cloudflare-ai-binding", input: ["text"], reasoning: false },
      { messages: [] },
      { signal: controller.signal },
    )) events.push(event);

    expect(run).toHaveBeenCalledOnce();
    expect(events[0]).toMatchObject({
      type: "error",
      reason: "aborted",
      error: { errorMessage: "Gardener structured Workers AI call was aborted" },
    });
  });

  it("rejects output budgets below the AI-binding provider floor", () => {
    expect(() => boundedCloudflareModel("openai/test", { ...budget, maxOutputTokens: 15 }))
      .toThrow(/at least 16/i);
  });

  it("rejects an oversized final native payload before model dispatch", async () => {
    const run = vi.fn();
    installBoundedCloudflareProvider({ run });
    const provider = mocks.setProvider.mock.calls.at(-1)?.[0];
    const encoded = boundedCloudflareModel("@cf/test/model", { ...budget, maxInputTokens: 8 }).slice("cloudflare/".length);
    const events = [];

    for await (const event of provider.stream(
      { id: encoded, name: encoded, provider: "cloudflare", api: "cloudflare-ai-binding" },
      { messages: [{ role: "user", content: "too large" }] },
      {},
    )) events.push(event);

    expect(run).not.toHaveBeenCalled();
    expect(mocks.baseStream).not.toHaveBeenCalled();
    expect(events).toEqual([
      expect.objectContaining({ type: "error", error: expect.objectContaining({ stopReason: "error" }) }),
    ]);
  });

  it("rejects an expired model deadline before model dispatch", () => {
    installBoundedCloudflareProvider({ run: vi.fn() });
    const provider = mocks.setProvider.mock.calls.at(-1)?.[0];
    const encoded = boundedCloudflareModel("@cf/test/model", { ...budget, deadlineAt: "2020-01-01T00:00:00.000Z" }).slice("cloudflare/".length);

    expect(() => provider.stream(
      { id: encoded, name: encoded, provider: "cloudflare", api: "cloudflare-ai-binding" },
      { messages: [] },
      {},
    )).toThrow(/runtime budget expired/i);
    expect(mocks.baseStream).not.toHaveBeenCalled();
  });
});
