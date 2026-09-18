import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessRequest } from "../src/harness";
import { expectedHarnessBinding } from "../src/harness";

const native = vi.hoisted(() => ({
  claim: vi.fn(),
  settle: vi.fn(async () => undefined),
  submit: vi.fn(),
}));

const flue = vi.hoisted(() => ({
  useAgentFinish: vi.fn(),
  useAgentStart: vi.fn(),
  useInitialData: vi.fn(),
  useInstruction: vi.fn(),
  useModel: vi.fn(),
  useResponseFinish: vi.fn(),
  useTool: vi.fn(),
}));

vi.mock("@flue/runtime", () => ({ ...flue }));
vi.mock("@flue/runtime/cloudflare", () => ({ extend: vi.fn(() => ({})) }));
vi.mock("../src/persistence", () => ({
  claimNativeTerminalInvocation: native.claim,
  finalizeNativeRun: vi.fn(),
  getRun: vi.fn(),
  updateRunState: vi.fn(),
}));
vi.mock("../src/harness/flue/terminal-tool", () => ({
  settleRunNonterminalEffects: native.settle,
  submitGardenerOutput: native.submit,
  validateNativeBinding: vi.fn(),
}));

import {
  executeNativeTerminalInvocation,
  GardenerFlueAgent,
  installGardenerFlueToolFacade,
} from "../src/harness/flue/generic-agent";

function request(): HarnessRequest {
  return {
    schemaVersion: "gardener.harness.request/v1",
    requestId: "native-request-1",
    runId: "run-1",
    snapshot: {
      agentRevisionId: "revision-1",
      agentRevisionHash: "a".repeat(64),
      promptReference: "prompt:1",
      policySnapshotReference: "policy:1",
      toolCatalogVersion: "tools:1",
      harness: expectedHarnessBinding("flue"),
    },
    prompt: "Use the trusted terminal protocol.",
    model: { id: "@cf/test/model" },
    tools: [],
    budget: {
      maxTurns: 1,
      maxToolCalls: 1,
      maxInputTokens: 1_000,
      maxOutputTokens: 500,
      maxRuntimeMs: 30_000,
      deadlineAt: "2099-01-01T00:00:00.000Z",
    },
  };
}

describe("Gardener native Flue Agent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installGardenerFlueToolFacade(undefined);
  });

  it("keeps the stable Agent identity and an explicit recovery ceiling", () => {
    expect(GardenerFlueAgent.agentName).toBe("gardener-harness");
    expect(GardenerFlueAgent.durability).toEqual({ maxAttempts: 3, timeoutMs: 900_000 });
  });

  it("mounts exactly one trusted terminal tool and no assistant-text protocol", () => {
    const value = request();
    flue.useInitialData.mockReturnValue({ request: value });

    expect(GardenerFlueAgent()).toBe(value.prompt);
    expect(flue.useModel).toHaveBeenCalledWith(
      expect.stringMatching(/^cloudflare\/gardener-native-bounded-v2:1:8000:500:30000:\d+:%40cf%2Ftest%2Fmodel$/),
      { compaction: false },
    );
    expect(flue.useTool).toHaveBeenCalledTimes(1);
    expect(flue.useTool.mock.calls[0]![0]).toMatchObject({
      name: "submit_gardener_output_v1",
      durable: true,
    });
    expect(flue.useAgentStart).toHaveBeenCalledOnce();
    expect(flue.useAgentFinish).toHaveBeenCalledOnce();
    expect(flue.useInstruction.mock.calls.flat().join("\n")).toContain("exactly one model turn");
    expect(flue.useInstruction.mock.calls.flat().join("\n")).not.toContain("JSON assistant response");
  });

  it("terminates sanitized terminal failures instead of exposing a retryable tool error", async () => {
    const value = request();
    native.claim.mockResolvedValue(true);
    native.submit.mockRejectedValue(new Error("sensitive provider failure"));
    await expect(executeNativeTerminalInvocation(
      { DB: {} } as any,
      value,
      { outcome: "abstain", summary: "No action" },
      {} as any,
      "call-1",
    )).resolves.toEqual({
      output: { committed: false, error: "terminal_output_not_committed" },
      terminate: true,
    });
    expect(native.submit).toHaveBeenCalledOnce();
    expect(native.settle).toHaveBeenCalledWith(
      expect.objectContaining({ DB: {} }),
      value.runId,
      value.budget.deadlineAt,
    );
  });

  it("allows only one terminal invocation to enter effect work", async () => {
    const value = request();
    native.claim.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    native.submit.mockResolvedValue({ output: { outcome: "abstain" }, terminate: true });
    const first = await executeNativeTerminalInvocation(
      { DB: {} } as any, value, {}, {} as any, "call-1",
    );
    const second = await executeNativeTerminalInvocation(
      { DB: {} } as any, value, {}, {} as any, "call-2",
    );
    expect(first).toMatchObject({ terminate: true });
    expect(second).toEqual({
      output: { committed: false, error: "terminal_invocation_already_claimed" },
      terminate: true,
    });
    expect(native.submit).toHaveBeenCalledOnce();
  });
});
