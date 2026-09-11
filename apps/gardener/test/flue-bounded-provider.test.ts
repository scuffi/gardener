import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessBudget } from "../src/harness";

const mocks = vi.hoisted(() => ({
  baseStream: vi.fn(() => "stream-result"),
  baseStreamSimple: vi.fn(() => "simple-result"),
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

  it("passes immutable output and deadline bounds into the provider call", () => {
    installBoundedCloudflareProvider({ run: vi.fn() });
    const provider = mocks.setProvider.mock.calls.at(-1)?.[0];
    const encoded = boundedCloudflareModel("@cf/test/model", budget).slice("cloudflare/".length);

    expect(provider.stream(
      { id: encoded, name: encoded, provider: "cloudflare", api: "cloudflare-ai-binding" },
      { messages: [{ role: "user", content: "hello" }] },
      { maxTokens: 500 },
    )).toBe("stream-result");
    expect(mocks.baseStream).toHaveBeenCalledWith(
      expect.objectContaining({ id: "@cf/test/model", name: "@cf/test/model" }),
      { messages: [{ role: "user", content: "hello" }] },
      expect.objectContaining({ maxTokens: 77, signal: expect.any(AbortSignal) }),
    );
  });

  it("rejects output budgets below the AI-binding provider floor", () => {
    expect(() => boundedCloudflareModel("openai/test", { ...budget, maxOutputTokens: 15 }))
      .toThrow(/at least 16/i);
  });

  it("rejects conservatively oversized provider context before model dispatch", () => {
    installBoundedCloudflareProvider({ run: vi.fn() });
    const provider = mocks.setProvider.mock.calls.at(-1)?.[0];
    const encoded = boundedCloudflareModel("@cf/test/model", { ...budget, maxInputTokens: 8 }).slice("cloudflare/".length);

    expect(() => provider.stream(
      { id: encoded, name: encoded, provider: "cloudflare", api: "cloudflare-ai-binding" },
      { messages: [{ role: "user", content: "too large" }] },
      {},
    )).toThrow(/exceeds its immutable 8-token budget/i);
    expect(mocks.baseStream).not.toHaveBeenCalled();
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
