import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessBudget } from "../src/harness";

const mocks = vi.hoisted(() => ({
  baseStream: vi.fn((_model: unknown, _context: unknown, _options?: any) => "stream-result"),
  baseStreamSimple: vi.fn((_model: unknown, _context: unknown, _options?: any) => "simple-result"),
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
  maxToolCalls: 1,
  maxInputTokens: 1_000,
  maxOutputTokens: 77,
  maxRuntimeMs: 30_000,
  deadlineAt: "2099-01-01T00:00:00.000Z",
};

function installedProvider() {
  installBoundedCloudflareProvider({ run: vi.fn() });
  return mocks.setProvider.mock.calls.at(-1)![0];
}

function encoded(input: HarnessBudget = budget): string {
  return boundedCloudflareModel("@cf/test/model", input).slice("cloudflare/".length);
}

describe("bounded native Flue Cloudflare provider", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses a new native protocol id and rejects the provider output-token floor", () => {
    expect(boundedCloudflareModel("@cf/test/model", budget))
      .toMatch(/^cloudflare\/gardener-native-bounded-v2:1:8000:77:30000:\d+:%40cf%2Ftest%2Fmodel$/);
    expect(() => boundedCloudflareModel("@cf/test/model", { ...budget, maxOutputTokens: 15 }))
      .toThrow(/at least 16/i);
  });

  it("preserves Flue tools, removes legacy response_format, and caps output", async () => {
    const provider = installedProvider();
    expect(provider.stream(
      { id: encoded(), name: "bounded", provider: "cloudflare", api: "cloudflare-ai-binding" },
      { messages: [] },
      { maxTokens: 500 },
    )).toBe("stream-result");

    const [model, , options] = mocks.baseStream.mock.calls.at(-1)!;
    expect(model).toMatchObject({ id: "@cf/test/model", name: "@cf/test/model" });
    expect(options.maxTokens).toBe(77);
    await expect(options.onPayload(
      { messages: [], tools: [{ name: "submit_gardener_output_v1" }], response_format: { type: "json_schema" } },
      { api: "cloudflare-ai-binding" },
    )).resolves.toEqual({ messages: [], tools: [{ name: "submit_gardener_output_v1" }] });
  });

  it("leaves tool selection to the model while preserving Flue's canonical transcript", async () => {
    const provider = installedProvider();
    provider.stream(
      { id: encoded(), name: "bounded", provider: "cloudflare", api: "cloudflare-ai-binding" },
      { messages: [] },
      {},
    );
    const options = mocks.baseStream.mock.calls.at(-1)![2];
    const payload = {
      messages: [{ role: "tool", content: "files" }],
      tools: [
        { type: "function", function: { name: "repository_list_files" } },
        { type: "function", function: { name: "finish_task" } },
      ],
    };
    const result = await options.onPayload(payload, { api: "cloudflare-ai-binding" });
    expect(result).toEqual(payload);
    expect(result).not.toHaveProperty("tool_choice");
  });

  it("applies the same native bounds through streamSimple", async () => {
    const provider = installedProvider();
    expect(provider.streamSimple(
      { id: encoded(), name: "bounded", provider: "cloudflare", api: "cloudflare-ai-binding" },
      { messages: [] },
      {},
    )).toBe("simple-result");
    const options = mocks.baseStreamSimple.mock.calls.at(-1)![2];
    await expect(options.onPayload(
      { messages: [], tools: [{ name: "submit_gardener_output_v1" }] },
      { api: "cloudflare-ai-binding" },
    )).resolves.toMatchObject({ tools: [{ name: "submit_gardener_output_v1" }] });
  });

  it("measures a trusted prior payload transformation as the final transmitted body", async () => {
    const provider = installedProvider();
    provider.stream(
      { id: encoded({ ...budget, maxInputTokens: 80 }), name: "bounded", provider: "cloudflare", api: "cloudflare-ai-binding" },
      { messages: [] },
      { onPayload: async () => ({ messages: [], tools: [{ description: "x".repeat(1_000) }] }) },
    );
    const options = mocks.baseStream.mock.calls.at(-1)![2];
    await expect(options.onPayload({ messages: [] }, { api: "cloudflare-ai-binding" }))
      .rejects.toThrow(/immutable 640-byte safety limit/);
  });

  it("rejects oversized context before invoking the provider", () => {
    const provider = installedProvider();
    expect(() => provider.stream(
      { id: encoded({ ...budget, maxInputTokens: 8 }), name: "bounded", provider: "cloudflare", api: "cloudflare-ai-binding" },
      { messages: [{ role: "user", content: "x".repeat(200) }] },
      {},
    )).toThrow(/immutable 64-byte safety limit/);
    expect(mocks.baseStream).not.toHaveBeenCalled();
  });

  it("allows representative input whose UTF-8 bytes exceed the numeric token budget", () => {
    const provider = installedProvider();
    const content = "ordinary English input ".repeat(75);
    expect(new TextEncoder().encode(content).byteLength).toBeGreaterThan(budget.maxInputTokens);
    expect(provider.stream(
      { id: encoded(), name: "bounded", provider: "cloudflare", api: "cloudflare-ai-binding" },
      { messages: [{ role: "user", content }] },
      {},
    )).toBe("stream-result");
  });

  it("rejects a model turn beyond the immutable turn limit", () => {
    const provider = installedProvider();
    expect(() => provider.stream(
      { id: encoded(), name: "bounded", provider: "cloudflare", api: "cloudflare-ai-binding" },
      { messages: [
        { role: "user", content: "run" },
        { role: "assistant", content: [] },
        { role: "toolResult", toolCallId: "call-1", toolName: "bad", content: [], isError: true },
      ] },
      {},
    )).toThrow(/at most 1 model turn/i);
    expect(mocks.baseStream).not.toHaveBeenCalled();
  });

  it("permits bounded tool follow-up turns and divides the total output ceiling", () => {
    const provider = installedProvider();
    const multiTurn = { ...budget, maxTurns: 4, maxOutputTokens: 80 };
    expect(provider.stream(
      { id: encoded(multiTurn), name: "bounded", provider: "cloudflare", api: "cloudflare-ai-binding" },
      { messages: [{ role: "user" }, { role: "assistant" }, { role: "toolResult" }] },
      {},
    )).toBe("stream-result");
    expect(mocks.baseStream.mock.calls.at(-1)![2].maxTokens).toBe(20);
    expect(() => provider.stream(
      { id: encoded(multiTurn), name: "bounded", provider: "cloudflare", api: "cloudflare-ai-binding" },
      { messages: Array.from({ length: 4 }, () => ({ role: "assistant" })) },
      {},
    )).toThrow(/at most 4 model turns/i);
  });

  it("rejects an expired absolute deadline before provider dispatch", () => {
    const provider = installedProvider();
    expect(() => provider.stream(
      { id: encoded({ ...budget, deadlineAt: "2020-01-01T00:00:00.000Z" }), name: "bounded", provider: "cloudflare", api: "cloudflare-ai-binding" },
      { messages: [] },
      {},
    )).toThrow(/runtime budget expired/i);
    expect(mocks.baseStream).not.toHaveBeenCalled();
  });
});
