import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.hoisted(() => {
  let resolveRun: ((value: unknown) => void) | undefined;
  const control = { settle: true, throwSync: false };
  const cancelRun = vi.fn(() => {
    if (control.throwSync) throw new Error("socket closed");
    if (control.settle) resolveRun?.({
      schemaVersion: "gardener.runner.terminal/v1",
      status: "cancelled",
      summary: "GitHub Actions planning job was cancelled",
      lastServerSequence: 0,
      lastCompletedSequence: 0,
    });
    return Promise.resolve();
  });
  const session = {
    resume: vi.fn(async () => ({
      schemaVersion: "gardener.runner.resume-state/v1",
      nextServerSequence: 1,
      unresolvedOperationIds: [],
    })),
    run: vi.fn(() => new Promise((resolve) => { resolveRun = resolve; })),
    cancelRun,
  };
  const root = {
    authenticate: vi.fn(() => session),
    [Symbol.dispose]: vi.fn(),
  };
  return { cancelRun, control, root, session };
});

vi.mock("capnweb", () => ({
  RpcTarget: class {},
  newWebSocketRpcSession: vi.fn(() => rpc.root),
}));
vi.mock("../src/context", () => ({
  helloFromOidcToken: vi.fn(() => ({
    schemaVersion: "gardener.runner.hello/v1",
    protocolVersion: "gardener.runner.rpc/v1",
    phase: "plan",
    repositoryId: "1",
    ownerId: "2",
    runId: "3",
    runAttempt: 1,
    workflowRef: "owner/repo/.github/workflows/gardener.yml@refs/heads/main",
    jobWorkflowRef: `owner/actions/.github/workflows/gardener.yml@${"a".repeat(40)}`,
    eventName: "issues",
    ref: "refs/heads/main",
    runnerEnvironment: "github-hosted",
    commitSha: "b".repeat(40),
    agentHash: "c".repeat(64),
  })),
  sessionSocketUrl: vi.fn(() => "wss://gardener.example/session/test"),
}));

import type { PlanningShellExecutor } from "../src/executor";
import { runPlanningSession } from "../src/session";

describe("planning session cancellation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rpc.control.settle = true;
    rpc.control.throwSync = false;
  });

  it("forwards an abort signal to the authenticated Gardener run", async () => {
    const controller = new AbortController();
    const running = runPlanningSession({
      harnessUrl: "https://gardener.example",
      agentHash: "c".repeat(64),
      maxReconnects: 0,
      signal: controller.signal,
      executor: {
        cursor: () => ({ nextClientSequence: 1, lastCompletedServerSequence: 0 }),
      } as unknown as PlanningShellExecutor,
      getOidcToken: async () => "oidc-token",
    });
    await vi.waitFor(() => expect(rpc.session.run).toHaveBeenCalledOnce());
    controller.abort();
    await expect(running).resolves.toMatchObject({ status: "cancelled" });
    expect(rpc.cancelRun).toHaveBeenCalledWith("GitHub Actions planning job was cancelled");
  });

  it("contains synchronous cancellation failure, does not reconnect, and exits after five seconds", async () => {
    const controller = new AbortController();
    const warnings: string[] = [];
    rpc.control.settle = false;
    rpc.control.throwSync = true;
    const running = runPlanningSession({
      harnessUrl: "https://gardener.example",
      agentHash: "c".repeat(64),
      maxReconnects: 5,
      signal: controller.signal,
      executor: {
        cursor: () => ({ nextClientSequence: 1, lastCompletedServerSequence: 0 }),
      } as unknown as PlanningShellExecutor,
      getOidcToken: async () => "oidc-token",
      onWarning: (warning) => warnings.push(warning),
    });
    await vi.waitFor(() => expect(rpc.session.run).toHaveBeenCalledOnce());
    vi.useFakeTimers();
    const rejected = expect(running).rejects.toThrow(/planning was cancelled/);
    controller.abort();
    await vi.advanceTimersByTimeAsync(5_000);
    await rejected;
    expect(rpc.root.authenticate).toHaveBeenCalledOnce();
    expect(warnings).toEqual([expect.stringContaining("socket closed")]);
    vi.useRealTimers();
  });
});

describe("planning session reconnects", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function failingSession(healthyConnectionMs: number, maxReconnects = 2) {
    rpc.session.run.mockImplementation(() => Promise.reject(new Error("socket closed")));
    return runPlanningSession({
      harnessUrl: "https://gardener.example",
      agentHash: "c".repeat(64),
      maxReconnects,
      healthyConnectionMs,
      executor: {
        cursor: () => ({ nextClientSequence: 1, lastCompletedServerSequence: 0 }),
      } as unknown as PlanningShellExecutor,
      getOidcToken: async () => "oidc-token",
    });
  }

  it("counts only consecutive failures against max-reconnects", async () => {
    vi.useFakeTimers();
    try {
      const running = failingSession(60_000);
      const rejected = expect(running).rejects.toThrow("Gardener session failed after 3 consecutive connection attempts");
      await vi.runAllTimersAsync();
      await rejected;
      expect(rpc.root.authenticate).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts a fresh count after a healthy connection, up to a total cap", async () => {
    vi.useFakeTimers();
    try {
      // Every connection resumes and counts as healthy, so only the total cap ends the run.
      const running = failingSession(0);
      const rejected = expect(running).rejects.toThrow("Gardener session failed after 50 reconnects");
      await vi.runAllTimersAsync();
      await rejected;
      expect(rpc.root.authenticate).toHaveBeenCalledTimes(51);
    } finally {
      vi.useRealTimers();
      rpc.session.run.mockImplementation(() => new Promise(() => undefined));
    }
  });
});
