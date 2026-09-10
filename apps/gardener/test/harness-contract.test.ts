import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_HARNESS_ID,
  HARNESS_ADAPTER_VERSIONS,
  HarnessContractError,
  HarnessRegistry,
  NarrowedHarnessToolFacade,
  createHarnessRegistry,
  assertHarnessRequest,
  expectedHarnessBinding,
  type AgentHarness,
  type HarnessId,
  type HarnessRequest,
} from "../src/harness";

function request(id: HarnessId = "flue"): HarnessRequest {
  return {
    schemaVersion: "gardener.harness.request/v1",
    requestId: "request-1",
    runId: "run-1",
    snapshot: {
      agentRevisionId: "agent-revision-1",
      agentRevisionHash: "a".repeat(64),
      promptReference: "prompt:1",
      policySnapshotReference: "policy:1",
      toolCatalogVersion: "tools:1",
      harness: expectedHarnessBinding(id),
    },
    prompt: "Inspect the repository and return a bounded result.",
    model: { id: "@cf/test/model" },
    tools: [{ name: "read_file", description: "Read one workspace file", authority: "observe" }],
    budget: {
      maxTurns: 4,
      maxToolCalls: 3,
      maxInputTokens: 1_000,
      maxOutputTokens: 500,
      maxRuntimeMs: 30_000,
    },
  };
}

function fakeHarness(id: HarnessId): AgentHarness {
  return {
    descriptor: {
      id,
      adapterVersion: HARNESS_ADAPTER_VERSIONS[id],
      capabilities: ["reasoning", "structured-outcome", "cancellation"],
      preview: false,
    },
    start: vi.fn(),
    submit: vi.fn(),
    read: vi.fn(),
    cancel: vi.fn(),
  };
}

describe("harness contract", () => {
  it("uses stable harness ids and selects Flue by default", () => {
    const flue = fakeHarness("flue");
    const think = fakeHarness("think");
    const direct = fakeHarness("cloudflare-agents");
    const registry = createHarnessRegistry({ flue, think, cloudflareAgents: direct });

    expect(DEFAULT_HARNESS_ID).toBe("flue");
    expect(registry.select(undefined)).toBe(flue);
    expect(registry.select("think")).toBe(think);
    expect(registry.select("cloudflare-agents")).toBe(direct);
    expect(() => registry.select("ai-sdk")).toThrow(/Unknown harness setting/);
  });

  it("requires snapshots to pin the selected adapter version", () => {
    const value = request("flue");
    expect(() => assertHarnessRequest(value, expectedHarnessBinding("flue"))).not.toThrow();
    value.snapshot.harness.adapterVersion = "2.0.0";
    expect(() => assertHarnessRequest(value, expectedHarnessBinding("flue"))).toThrow(/pins flue@2.0.0/);
  });

  it("accepts a bounded completed-only result schema without granting authority", () => {
    const value = request();
    value.tools = [];
    value.resultDataSchema = {
      type: "object",
      additionalProperties: false,
      properties: { body: { type: "string", maxLength: 1_000 } },
      required: ["body"],
    };
    expect(() => assertHarnessRequest(value)).not.toThrow();
    expect(() => assertHarnessRequest({ ...value, tools: request().tools })).toThrow(/completed-only.*tools/i);
    expect(() => assertHarnessRequest({ ...value, resultDataSchema: { type: "object", patternProperties: {} } as never })).toThrow(/unsupported JSON Schema keywords/i);
    expect(() => assertHarnessRequest({ ...value, resultDataSchema: { nested: () => "not JSON" } as never })).toThrow(/unsupported JSON Schema keywords/i);
  });

  it("rejects unknown request data and bounds model input by UTF-8 bytes", () => {
    expect(() => assertHarnessRequest({ ...request(), credential: "must-not-cross-boundary" })).toThrow(/unknown fields/i);
    expect(() => assertHarnessRequest({
      ...request(),
      model: { id: "@cf/test/model", apiKey: "secret" },
    })).toThrow(/unknown fields/i);
    expect(() => assertHarnessRequest({
      ...request(),
      prompt: "🙂".repeat(140_000),
    })).toThrow(/UTF-8 bytes/i);
  });

  it("makes persistent-effect authority unrepresentable and fails closed at runtime", () => {
    const value = request();
    value.tools = [{
      name: "merge_pull_request",
      description: "Attempt a persistent mutation",
      authority: "persistent-effect",
    } as never];
    expect(() => assertHarnessRequest(value)).toThrow(/observe or workspace authority/);
  });

  it("enforces the narrowed facade identity, catalog, JSON, and call budget", async () => {
    const invoke = vi.fn(async () => ({ ok: true }));
    const facade = new NarrowedHarnessToolFacade(request(), { invoke });
    const allowed = {
      runId: "run-1",
      requestId: "request-1",
      toolCallId: "call-1",
      toolName: "read_file",
      input: { path: "README.md" },
    } as const;

    await expect(facade.invoke(allowed)).resolves.toEqual({ ok: true });
    await expect(facade.invoke({ ...allowed, toolCallId: "call-2", toolName: "github_merge" })).rejects.toMatchObject({ code: "tool-denied" });
    await expect(facade.invoke({ ...allowed, toolCallId: "call-3", runId: "other" })).rejects.toMatchObject({ code: "tool-denied" });
    await facade.invoke({ ...allowed, toolCallId: "call-4" });
    await facade.invoke({ ...allowed, toolCallId: "call-5" });
    await expect(facade.invoke({ ...allowed, toolCallId: "call-6" })).rejects.toMatchObject({ code: "budget-exceeded" });
    expect(invoke).toHaveBeenCalledTimes(3);
  });

  it("rejects duplicate adapters and incorrect adapter versions", () => {
    expect(() => new HarnessRegistry([fakeHarness("flue"), fakeHarness("flue")])).toThrow(/Duplicate/);
    const wrong = fakeHarness("think");
    wrong.descriptor.adapterVersion = "old";
    expect(() => new HarnessRegistry([wrong])).toThrow(HarnessContractError);
  });
});
