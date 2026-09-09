import { describe, expect, it, vi } from "vitest";
import { ComputerExecutionWorkspace } from "../src/workspace/adapter";
import { executionWorkspaceId } from "../src/workspace/ids";
import { selectExecutionBackend } from "../src/workspace/policy";
import type { ComputerWorkspaceRpc } from "../src/workspace/rpc";
import type { ExecutionAuthorization, WorkspaceExecutionRequest, WorkspaceIdentity } from "../src/workspace/types";

const identity: WorkspaceIdentity = {
  instanceId: "instance-1",
  runId: "run-42",
  taskId: "review",
  principalId: "agent-security",
};

const shellRequest: WorkspaceExecutionRequest = {
  executionId: "exec-1",
  backend: "shell",
  source: "grep -R TODO .",
};

const shellAuthorization: ExecutionAuthorization = {
  allowedBackends: ["shell", "javascript"],
  containerAuthorized: false,
  maxOutputBytes: 4096,
  maxRuntimeMs: 5000,
};

describe("execution workspace IDs", () => {
  it("isolates parallel principals and tasks", () => {
    const first = executionWorkspaceId(identity);
    expect(executionWorkspaceId({ ...identity })).toBe(first);
    expect(executionWorkspaceId({ ...identity, principalId: "agent-tests" })).not.toBe(first);
    expect(executionWorkspaceId({ ...identity, taskId: "tests" })).not.toBe(first);
    expect(first).not.toContain(identity.runId);
    expect(executionWorkspaceId({ ...identity, runId: "a:b", taskId: "c" })).not.toBe(
      executionWorkspaceId({ ...identity, runId: "a", taskId: "b:c" }),
    );
  });

  it("rejects ambiguous traversal-like identity components", () => {
    expect(() => executionWorkspaceId({ ...identity, taskId: "../shared" })).toThrow(/task ID/);
  });
});

describe("backend capability selection", () => {
  it("allows only an explicitly listed backend", () => {
    expect(selectExecutionBackend(shellRequest, shellAuthorization)).toBe("shell");
    expect(() =>
      selectExecutionBackend({ ...shellRequest, backend: "javascript" }, { ...shellAuthorization, allowedBackends: ["shell"] }),
    ).toThrow(/outside the run capability/);
  });

  it("requires a separate positive container authorization", () => {
    const request = { ...shellRequest, backend: "container" as const };
    const listed = { ...shellAuthorization, allowedBackends: ["container"] as const };
    expect(() => selectExecutionBackend(request, listed)).toThrow(/separate caller authorization/);
    expect(selectExecutionBackend(request, { ...listed, containerAuthorized: true })).toBe("container");
  });

  it("rejects network-bearing shell, container, and JavaScript source", () => {
    expect(() => selectExecutionBackend({ ...shellRequest, source: "git fetch origin" }, shellAuthorization)).toThrow(
      /Network-bearing/,
    );
    expect(() =>
      selectExecutionBackend(
        { ...shellRequest, backend: "container", source: "curl https://example.test" },
        { ...shellAuthorization, allowedBackends: ["container"], containerAuthorized: true },
      ),
    ).toThrow(/Network-bearing/);
    expect(() =>
      selectExecutionBackend(
        { ...shellRequest, backend: "javascript", source: "export default async () => fetch('https://example.test')" },
        shellAuthorization,
      ),
    ).toThrow(/network access is disabled/);
  });

  it("enforces caller limits before invoking RPC", async () => {
    const executeAuthorized = vi.fn();
    const rpc = { executeAuthorized } as unknown as ComputerWorkspaceRpc;
    const adapter = new ComputerExecutionWorkspace(rpc, identity);
    await expect(
      adapter.execute(
        { ...shellRequest, backend: "container" },
        { ...shellAuthorization, allowedBackends: ["container"] },
      ),
    ).rejects.toThrow(/separate caller authorization/);
    expect(executeAuthorized).not.toHaveBeenCalled();
  });
});
