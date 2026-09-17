import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PlanningShellExecutor } from "../src/executor";
import type { RunnerActionV1 } from "@gardener/protocol";

const directories: string[] = [];

afterEach(async () => {
  delete process.env.GITHUB_TOKEN;
  delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("PlanningShellExecutor", () => {
  it("runs in the mapped Actions workspace with a secret-scrubbed environment", async () => {
    const workspace = await temporaryWorkspace();
    process.env.GITHUB_TOKEN = "must-not-reach-shell";
    process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = "must-not-reach-shell";
    const executor = new PlanningShellExecutor(workspace);
    const result = await executor.execute(action("printf '%s|%s|%s' \"$PWD\" \"${GITHUB_TOKEN-unset}\" \"${ACTIONS_ID_TOKEN_REQUEST_TOKEN-unset}\""));
    expect(result).toMatchObject({ status: "completed", exitCode: 0, outputTruncated: false });
    expect(result.stdout).toBe(`${workspace}|unset|unset`);
  });

  it("rejects cwd escape and conflicting operation reuse", async () => {
    const workspace = await temporaryWorkspace();
    const executor = new PlanningShellExecutor(workspace);
    await expect(executor.execute({ ...action("pwd"), cwd: "/outside" })).rejects.toThrow(/escapes/);
    await executor.execute(action("printf first"));
    await expect(executor.execute(action("printf second"))).rejects.toThrow(/different shell input/);
  });

  it("bounds combined output by UTF-8 bytes", async () => {
    const executor = new PlanningShellExecutor(await temporaryWorkspace());
    const result = await executor.execute({ ...action("printf '123456789'"), maxOutputBytes: 4 });
    expect(result.stdout).toBe("1234");
    expect(result.outputTruncated).toBe(true);
  });

  it("times out a process group", async () => {
    const executor = new PlanningShellExecutor(await temporaryWorkspace());
    const result = await executor.execute({ ...action("sleep 5"), timeoutMs: 25 });
    expect(result).toMatchObject({ status: "timed_out", exitCode: null });
  });
});

function action(command: string): RunnerActionV1 {
  return {
    schemaVersion: "gardener.runner.action/v1",
    sequence: 1,
    operationId: "operation-one",
    kind: "shell.exec",
    command,
    cwd: "/workspace",
    timeoutMs: 30_000,
    maxOutputBytes: 64 * 1024,
  };
}

async function temporaryWorkspace(): Promise<string> {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "gardener-runner-")));
  directories.push(directory);
  return directory;
}
