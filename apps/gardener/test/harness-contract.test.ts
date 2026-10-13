import { describe, expect, it, vi } from "vitest";
import { TASK_RUNTIME_SECONDS_MAX } from "@gardener/contracts";
import {
  HARNESS_IDS,
  HarnessContractError,
  NarrowedHarnessToolFacade,
  assertHarnessRequest,
  assertHarnessSubmission,
  expectedHarnessBinding,
  type HarnessErrorCode,
  type HarnessId,
  type HarnessRequest,
} from "../src/harness";
import { assertJsonValue } from "../src/harness/validation";

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
      deadlineAt: "2099-01-01T00:00:00.000Z",
    },
  };
}

describe("harness contract", () => {
  it("exposes Flue as the only product harness", () => {
    expect(HARNESS_IDS).toEqual(["flue"]);
    expect(expectedHarnessBinding("flue")).toEqual({ id: "flue", adapterVersion: "gardener-flue-native/v1" });
  });

  it("requires snapshots to pin the selected adapter version", () => {
    const value = request("flue");
    expect(() => assertHarnessRequest(value, expectedHarnessBinding("flue"))).not.toThrow();
    value.snapshot.harness.adapterVersion = "1.0.0";
    expect(() => assertHarnessRequest(value, expectedHarnessBinding("flue"))).toThrow(/pins flue@1.0.0, not flue@gardener-flue-native\/v1/);
  });

  it("rejects the retired structured-result schema field", () => {
    expect(() => assertHarnessRequest({ ...request(), resultDataSchema: { type: "object" } } as never)).toThrow(/unknown fields/i);
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
});

/** Asserts a contract refusal by its code and message, not just that something threw. */
function expectContractError(check: () => void, code: HarnessErrorCode, message: RegExp): void {
  let caught: unknown;
  try {
    check();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(HarnessContractError);
  expect((caught as HarnessContractError).code).toBe(code);
  expect((caught as HarnessContractError).message).toMatch(message);
}

function tools(count: number): HarnessRequest["tools"] {
  return Array.from({ length: count }, (_, index) => ({
    name: `tool_${index}`,
    description: "A bounded tool",
    authority: "observe" as const,
  }));
}

function nested(depth: number): unknown {
  let value: unknown = 0;
  for (let level = 0; level < depth; level += 1) value = [value];
  return value;
}

/** A JSON value of exactly `count` nodes: a root array of arrays, each at most 2,000 entries. */
function nodes(count: number): unknown {
  const leaves = count - 1;
  const groups: number[][] = [];
  let remaining = leaves;
  while (remaining > 0) {
    const size = Math.min(2_000, remaining - 1);
    groups.push(Array.from({ length: size }, () => 0));
    remaining -= size + 1;
  }
  return groups;
}

describe("harness request bounds", () => {
  it("accepts exactly the maximum tool count and refuses one more", () => {
    expect(() => assertHarnessRequest({ ...request(), tools: tools(64) })).not.toThrow();
    expectContractError(() => assertHarnessRequest({ ...request(), tools: tools(65) }), "invalid-request", /tools must contain at most 64 entries/);
  });

  it("refuses a duplicate tool name", () => {
    const [first] = tools(1);
    expectContractError(
      () => assertHarnessRequest({ ...request(), tools: [first!, { ...first!, description: "Another" }] }),
      "invalid-request",
      /Duplicate harness tool tool_0/,
    );
  });

  it("bounds context by entry count and total UTF-8 bytes", () => {
    const entries = (count: number, content = "x") => Array.from({ length: count }, (_, index) => ({ name: `c${index}`, content }));
    expect(() => assertHarnessRequest({ ...request(), context: entries(64) })).not.toThrow();
    expectContractError(() => assertHarnessRequest({ ...request(), context: entries(65) }), "invalid-request", /context must contain at most 64 entries/);

    // Each entry is within its own bound; only the total crosses 512,000 bytes.
    const half = "x".repeat(256_000);
    expect(() => assertHarnessRequest({ ...request(), context: entries(2, half) })).not.toThrow();
    expectContractError(
      () => assertHarnessRequest({ ...request(), context: [...entries(2, half), { name: "extra", content: "x" }] }),
      "invalid-request",
      /context exceeds 512000 UTF-8 bytes/,
    );
    // Multi-byte content is measured in bytes, not characters.
    expectContractError(
      () => assertHarnessRequest({ ...request(), context: entries(2, "\u00e9".repeat(128_001)) }),
      "invalid-request",
      /context exceeds 512000 UTF-8 bytes/,
    );
  });

  it("requires a lowercase hexadecimal agent revision hash of 32 to 128 characters", () => {
    const withHash = (agentRevisionHash: string) => {
      const value = request();
      value.snapshot.agentRevisionHash = agentRevisionHash;
      return value;
    };
    expect(() => assertHarnessRequest(withHash("a".repeat(32)))).not.toThrow();
    expect(() => assertHarnessRequest(withHash("a".repeat(128)))).not.toThrow();
    expectContractError(() => assertHarnessRequest(withHash("A".repeat(64))), "invalid-request", /lowercase hexadecimal hash/);
    expectContractError(() => assertHarnessRequest(withHash("g".repeat(64))), "invalid-request", /lowercase hexadecimal hash/);
    expectContractError(() => assertHarnessRequest(withHash("a".repeat(31))), "invalid-request", /agentRevisionHash must contain 32-128 characters/);
    expectContractError(() => assertHarnessRequest(withHash("a".repeat(129))), "invalid-request", /agentRevisionHash must contain 32-128 characters/);
  });

  it("requires identifiers to match the identifier format", () => {
    for (const requestId of ["-leading-dash", "has space", "semi;colon", "x".repeat(257), ""]) {
      expectContractError(() => assertHarnessRequest({ ...request(), requestId }), "invalid-request", /requestId (has an invalid format|must contain 1-256 characters)/);
    }
    expect(() => assertHarnessRequest({ ...request(), requestId: `A${"x".repeat(255)}` })).not.toThrow();
    expect(() => assertHarnessRequest({ ...request(), requestId: "run:1/a.b_c-d" })).not.toThrow();
  });

  it("bounds maxRuntimeMs between one second and the task runtime ceiling", () => {
    const withRuntime = (maxRuntimeMs: number) => ({ ...request(), budget: { ...request().budget, maxRuntimeMs } });
    expect(() => assertHarnessRequest(withRuntime(1_000))).not.toThrow();
    expect(() => assertHarnessRequest(withRuntime(TASK_RUNTIME_SECONDS_MAX * 1_000))).not.toThrow();
    expectContractError(() => assertHarnessRequest(withRuntime(999)), "invalid-request", /budget\.maxRuntimeMs must be an integer between 1000 and 21600000/);
    expectContractError(
      () => assertHarnessRequest(withRuntime(TASK_RUNTIME_SECONDS_MAX * 1_000 + 1)),
      "invalid-request",
      /budget\.maxRuntimeMs must be an integer between 1000 and 21600000/,
    );
    expectContractError(() => assertHarnessRequest(withRuntime(1_000.5)), "invalid-request", /budget\.maxRuntimeMs/);
  });
});

describe("harness JSON bounds", () => {
  it("accepts depth 32 and refuses depth 33", () => {
    expect(() => assertJsonValue(nested(32))).not.toThrow();
    expectContractError(() => assertJsonValue(nested(33)), "invalid-outcome", /value has excessive JSON complexity/);
  });

  it("accepts 20,000 nodes and refuses 20,001", () => {
    expect(() => assertJsonValue(nodes(20_000))).not.toThrow();
    expectContractError(() => assertJsonValue(nodes(20_001)), "invalid-outcome", /excessive JSON complexity/);
  });

  it("accepts 2,000 entries in one container and refuses 2,001", () => {
    expect(() => assertJsonValue(Array.from({ length: 2_000 }, () => 0))).not.toThrow();
    expectContractError(() => assertJsonValue(Array.from({ length: 2_001 }, () => 0)), "invalid-outcome", /too many JSON entries/);
    const keys = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, index) => [`k${index}`, 0]));
    expect(() => assertJsonValue(keys(2_000))).not.toThrow();
    expectContractError(() => assertJsonValue(keys(2_001)), "invalid-outcome", /too many JSON entries/);
  });

  it("refuses non-finite numbers, which JSON.stringify would silently turn into null", () => {
    for (const number of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expectContractError(() => assertJsonValue({ nested: [number] }, "outcome"), "invalid-outcome", /outcome contains a non-finite number/);
    }
  });

  it("refuses cyclic, unserializable, non-JSON and oversized values", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expectContractError(() => assertJsonValue(cyclic), "invalid-outcome", /value must be JSON serializable/);
    expectContractError(() => assertJsonValue({ big: 1n }), "invalid-outcome", /must be JSON serializable/);
    expectContractError(() => assertJsonValue(undefined), "invalid-outcome", /value must be bounded JSON/);
    expectContractError(() => assertJsonValue({ call: () => 1 }), "invalid-outcome", /contains a non-JSON value/);
    // 1,000,000 bytes of encoded JSON is the ceiling; the quotes count.
    expect(() => assertJsonValue("x".repeat(999_998))).not.toThrow();
    expectContractError(() => assertJsonValue("x".repeat(999_999)), "invalid-outcome", /value must be bounded JSON/);
  });
});

describe("harness submission", () => {
  const submission = () => ({
    schemaVersion: "gardener.harness.submission/v1",
    harness: expectedHarnessBinding("flue"),
    runId: "run-1",
    requestId: "request-1",
    submissionId: "submission-1",
    acceptedAt: "2026-10-13T00:00:00.000Z",
  });

  it("accepts a submission bound to the expected adapter", () => {
    expect(() => assertHarnessSubmission(submission(), expectedHarnessBinding("flue"))).not.toThrow();
  });

  it("refuses a submission from another adapter version", () => {
    expectContractError(
      () => assertHarnessSubmission({ ...submission(), harness: { id: "flue", adapterVersion: "1.0.0" } }, expectedHarnessBinding("flue")),
      "invalid-request",
      /Harness submission binding does not match its adapter/,
    );
  });

  it("refuses unknown fields and malformed identity", () => {
    expectContractError(
      () => assertHarnessSubmission({ ...submission(), credential: "x" }, expectedHarnessBinding("flue")),
      "invalid-request",
      /Harness submission contains unknown fields: credential/,
    );
    expectContractError(
      () => assertHarnessSubmission({ ...submission(), submissionId: "bad id" }, expectedHarnessBinding("flue")),
      "invalid-request",
      /submission\.submissionId has an invalid format/,
    );
    expectContractError(
      () => assertHarnessSubmission({ ...submission(), acceptedAt: "not a date" }, expectedHarnessBinding("flue")),
      "invalid-request",
      /submission\.acceptedAt must be an ISO timestamp/,
    );
  });
});
