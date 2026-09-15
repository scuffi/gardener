/// <reference types="node" />
import { DatabaseSync } from "node:sqlite";
import { calculateWorkspacePolicyHash } from "@gardener/core";
import { describe, expect, it, vi } from "vitest";
import { instancePolicySnapshot, WorkspacePolicyReadError } from "../src/instance-state";
import { d1Database, migration } from "./persistence-test-db";
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

function policyDatabase(): { sqlite: DatabaseSync; db: D1Database } {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(migration());
  sqlite.exec(migration("0005_agent_runtime_admission.sql"));
  sqlite.exec(migration("0006_flue_harness_requests.sql"));
  sqlite.exec(migration("0007_team_workspace_foundation.sql"));
  return { sqlite, db: d1Database(sqlite) };
}

async function expectPolicyCode(db: D1Database, code: string): Promise<void> {
  try {
    await instancePolicySnapshot(db);
    throw new Error("expected policy read to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(WorkspacePolicyReadError);
    expect((error as WorkspacePolicyReadError).code).toBe(code);
  }
}

describe("v7 workspace policy snapshots", () => {
  it("reads the positive real version and canonically hashes the complete constraints", async () => {
    const { sqlite, db } = policyDatabase();
    try {
      sqlite.prepare("UPDATE operation_policies SET mode='automatic' WHERE operation_kind='issue.comment.create'").run();
      const policy = await instancePolicySnapshot(db);
      expect(policy.version).toBe(Number((sqlite.prepare("SELECT value FROM settings WHERE key='policy_version'").get() as { value: string }).value));
      expect(policy.policyHash).toBe(await calculateWorkspacePolicyHash(policy));
      expect(policy).toMatchObject({
        allowedMergeMethods: ["squash"], maxCommentLength: 10_000, maxChangedFiles: 25,
        deniedPathPrefixes: [".github/workflows", ".github/dependabot.yml"],
      });
    } finally { sqlite.close(); }
  });

  it.each([null, "0", "not-a-number"])("fails closed with a stable code for policy_version %s", async (value) => {
    const { sqlite, db } = policyDatabase();
    try {
      sqlite.prepare("DELETE FROM settings WHERE key='policy_version'").run();
      if (value !== null) sqlite.prepare("INSERT INTO settings(key,value) VALUES('policy_version',?)").run(value);
      await expectPolicyCode(db, "policy_version_invalid");
    } finally { sqlite.close(); }
  });

  it("fails closed on unknown operation and capability rows", async () => {
    for (const statement of [
      "INSERT INTO operation_policies(operation_kind,mode) VALUES('future.effect','automatic')",
      "INSERT INTO instance_capability_policies(capability_kind,mode) VALUES('future.capability','automatic')",
    ]) {
      const { sqlite, db } = policyDatabase();
      try {
        sqlite.prepare(statement).run();
        await expectPolicyCode(db, statement.includes("operation_policies")
          ? "workspace_operation_policy_invalid"
          : "workspace_capability_policy_invalid");
      } finally { sqlite.close(); }
    }
  });

  it("changes transport version but not canonical hash for an identical content bump", async () => {
    const { sqlite, db } = policyDatabase();
    try {
      const before = await instancePolicySnapshot(db);
      sqlite.prepare("UPDATE settings SET value=CAST(value AS INTEGER)+1 WHERE key='policy_version'").run();
      const after = await instancePolicySnapshot(db);
      expect(after.version).toBe(before.version + 1);
      expect(after.policyHash).toBe(before.policyHash);
    } finally { sqlite.close(); }
  });
});

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
