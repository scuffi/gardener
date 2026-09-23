import { execFile } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { EFFECT_TRANSPORT_MAX_BYTES as PROTOCOL_EFFECT_TRANSPORT_MAX_BYTES, runnerCaptureResultV1Schema, type RunnerActionV1 } from "@gardener/protocol";
import { EFFECT_TRANSPORT_MAX_BYTES as CONTRACT_EFFECT_TRANSPORT_MAX_BYTES, taskCaptureManifestV1Schema } from "@gardener/contracts";
import { PlanningShellExecutor, createPlanningExecutor } from "../src/executor";

/** Every case shells out to real Git several times, which is slow on macOS. */
const GIT_TEST_TIMEOUT = 60_000;
const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("trusted capture admission in the planning runner", () => {
  it("keeps the contracts and protocol transport ceilings identical", () => {
    expect(PROTOCOL_EFFECT_TRANSPORT_MAX_BYTES).toBe(CONTRACT_EFFECT_TRANSPORT_MAX_BYTES);
  });
  it("takes the baseline before any task command can run", async () => {
    const { executor, baseSha } = await planningFixture();

    // Rewriting Git's configuration is the sharpest probe available: capture
    // digests the effective configuration *before* execution and refuses if it
    // moved. This only fails if the baseline genuinely preceded the shell, so
    // it is a direct test of ordering rather than of the refusal itself.
    const shell = await executor.execute(shellAction(1, "op_config", "git config user.name mallory"));
    expect(shell.status).toBe("completed");

    const result = await executor.execute(captureAction(2, "op_capture", baseSha));
    expect(result.status).toBe("failed");
    expect(result.stderr).toMatch(/Git configuration changed during execution/);
    expect(executor.captureArtifact()).toBeUndefined();
  }, GIT_TEST_TIMEOUT);

  it("captures what the shell actually changed, as metadata only", async () => {
    const { executor, workspace, baseSha } = await planningFixture();
    await executor.execute(shellAction(1, "op_edit", "printf 'two\\n' > one.txt && printf 'new\\n' > added.txt"));

    const result = await executor.execute(captureAction(2, "op_capture", baseSha));
    expect(result.status).toBe("completed");
    const envelope = runnerCaptureResultV1Schema.parse(JSON.parse(result.stdout));
    if (envelope.status !== "captured") throw new Error("expected a capture");

    const manifest = taskCaptureManifestV1Schema.parse(JSON.parse(envelope.manifestJson));
    expect(manifest.files.map((file) => file.path)).toEqual(["added.txt", "one.txt"]);
    expect(envelope.ref).toMatchObject({ baseSha, fileCount: 2, sizeBytes: manifest.totalBytes });

    // Nothing that crosses the boundary names a local path or carries a byte
    // of the files it describes.
    expect(result.stdout).not.toContain("new\n");
    expect(result.stdout).not.toContain(tmpdir());
    expect(result.stdout).not.toContain(workspace);
    expect(Object.keys(envelope).sort()).toEqual(["manifestJson", "ref", "schemaVersion", "status"]);

    // The local artifact stays in the runner process for the bridge to upload.
    const artifact = executor.captureArtifact();
    expect(artifact?.directory.startsWith(workspace)).toBe(false);
    expect(artifact?.ref).toEqual(envelope.ref);
  }, GIT_TEST_TIMEOUT);

  it("captures once and replays the same bytes for a second request", async () => {
    const { executor, baseSha } = await planningFixture();
    await executor.execute(shellAction(1, "op_edit", "printf 'two\\n' > one.txt"));

    const first = await executor.execute(captureAction(2, "op_capture", baseSha));
    const lateShell = await executor.execute(shellAction(3, "op_late", "printf 'late\\n' > late.txt"));
    expect(lateShell).toMatchObject({ status: "failed", exitCode: 1 });
    expect(lateShell.stderr).toMatch(/capture has started/);
    const replayed = await executor.execute(captureAction(2, "op_capture", baseSha));
    expect(replayed).toEqual(first);

    // Even a distinct operation id must not photograph the tree twice: the
    // second capture would otherwise disagree with the plan built from the
    // first.
    const again = await executor.execute(captureAction(3, "op_capture_again", baseSha));
    expect(again.status).toBe("completed");
    expect(JSON.parse(again.stdout)).toEqual(JSON.parse(first.stdout));
  }, GIT_TEST_TIMEOUT);

  it("rejects a reused operation id that carries different capture input", async () => {
    const { executor, baseSha } = await planningFixture();
    await executor.execute(captureAction(1, "op_capture", baseSha));
    await expect(executor.execute(captureAction(1, "op_capture", "f".repeat(40))))
      .rejects.toThrow(/Operation ID was reused/);
  }, GIT_TEST_TIMEOUT);

  it("reports an unchanged tree rather than inventing a change set", async () => {
    const { executor, baseSha } = await planningFixture();
    const result = await executor.execute(captureAction(1, "op_capture", baseSha));
    expect(result.status).toBe("completed");
    expect(JSON.parse(result.stdout)).toEqual({
      schemaVersion: "gardener.runner.capture-result/v1",
      status: "unchanged",
    });
    expect(executor.captureArtifact()).toBeUndefined();
  }, GIT_TEST_TIMEOUT);

  it("can capture a repaired tree after an unchanged attempt", async () => {
    const { executor, baseSha } = await planningFixture();
    const unchanged = await executor.execute(captureAction(1, "op_capture_0", baseSha));
    expect(JSON.parse(unchanged.stdout)).toMatchObject({ status: "unchanged" });

    expect((await executor.execute(shellAction(2, "op_repair", "printf 'two\\n' > one.txt"))).status)
      .toBe("completed");
    const retried = await executor.execute(captureAction(3, "op_capture_1", baseSha));
    expect(runnerCaptureResultV1Schema.parse(JSON.parse(retried.stdout)).status).toBe("captured");
  }, GIT_TEST_TIMEOUT);

  it("can retry with a larger transport budget after a bounded capture failure", async () => {
    const { executor, baseSha } = await planningFixture();
    await executor.execute(shellAction(1, "op_edit", "printf 'two\\n' > one.txt"));
    const narrow = { ...captureAction(2, "op_capture_0", baseSha), maxOutputBytes: 64 } as RunnerActionV1;
    expect((await executor.execute(narrow)).status).toBe("failed");

    const retried = await executor.execute(captureAction(3, "op_capture_1", baseSha));
    expect(runnerCaptureResultV1Schema.parse(JSON.parse(retried.stdout)).status).toBe("captured");
  }, GIT_TEST_TIMEOUT);

  it("terminates background shell children before the action becomes terminal", async () => {
    const { executor, workspace } = await planningFixture();
    const shell = await executor.execute(shellAction(
      1,
      "op_background",
      "(sleep 0.2; printf 'late\\n' > late.txt) >/dev/null 2>&1 &",
    ));
    expect(shell.status).toBe("completed");
    await new Promise((resolve) => setTimeout(resolve, 350));
    await expect(stat(path.join(workspace, "late.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  }, GIT_TEST_TIMEOUT);

  it("fails closed when the run took no baseline, and never fabricates one", async () => {
    const workspace = await temporaryDirectory();
    const executor = new PlanningShellExecutor(workspace);

    const result = await executor.execute(captureAction(1, "op_capture", "a".repeat(40)));
    expect(result.status).toBe("failed");
    expect(result.stderr).toMatch(/took no pre-execution capture baseline/);
    expect(executor.captureArtifact()).toBeUndefined();
  });

  it("records why a capture-incapable runner cannot capture, without failing the run", async () => {
    const workspace = await temporaryDirectory();
    await initializeRepository(workspace);

    // A checkout with no RUNNER_TEMP can still run an inspect-only task. The
    // reason is kept and surfaces only if something later needs a capture.
    const executor = await createPlanningExecutor({ workspace, baseSha: await headSha(workspace) });
    expect((await executor.execute(shellAction(1, "op_read", "cat one.txt"))).status).toBe("completed");

    const result = await executor.execute(captureAction(2, "op_capture", await headSha(workspace)));
    expect(result.status).toBe("failed");
    expect(result.stderr).toMatch(/RUNNER_TEMP is required/);
  }, GIT_TEST_TIMEOUT);

  it("refuses a capture bound to a commit other than the baseline's", async () => {
    const { executor } = await planningFixture();
    const result = await executor.execute(captureAction(1, "op_capture", "b".repeat(40)));
    expect(result.status).toBe("failed");
    expect(result.stderr).toMatch(/baseline is bound to .* but the runtime asked for/);
  }, GIT_TEST_TIMEOUT);

  it("publishes the local artifact only for the capture the plan actually binds", async () => {
    const { executor, baseSha } = await planningFixture();
    await executor.execute(shellAction(1, "op_edit", "printf 'two\\n' > one.txt"));
    const result = await executor.execute(captureAction(2, "op_capture", baseSha));
    const envelope = runnerCaptureResultV1Schema.parse(JSON.parse(result.stdout));
    if (envelope.status !== "captured") throw new Error("expected a capture");

    await expect(executor.verifiedCaptureArtifact("0".repeat(64)))
      .rejects.toThrow(/binds a different repository capture/);
    const verified = await executor.verifiedCaptureArtifact(envelope.ref.changesSha256);
    expect(verified.ref.captureId).toBe(envelope.ref.captureId);

    // The artifact lives where the model can write, so a rewrite between the
    // terminal and the upload has to be caught at publication time.
    await writeFile(path.join(verified.directory, "manifest.json"), "{}");
    await expect(executor.verifiedCaptureArtifact(envelope.ref.changesSha256))
      .rejects.toThrow(/Capture manifest digest mismatch/);
  }, GIT_TEST_TIMEOUT);

  it("has no artifact to publish when nothing was captured", async () => {
    const { executor } = await planningFixture();
    await expect(executor.verifiedCaptureArtifact("0".repeat(64)))
      .rejects.toThrow(/did not produce/);
  }, GIT_TEST_TIMEOUT);

  it("keeps the manifest inside the action's transport budget", async () => {
    const { executor, baseSha } = await planningFixture();
    await executor.execute(shellAction(1, "op_edit", "printf 'two\\n' > one.txt"));

    const narrow = { ...captureAction(2, "op_capture", baseSha), maxOutputBytes: 64 } as RunnerActionV1;
    const result = await executor.execute(narrow);
    expect(result.status).toBe("failed");
    expect(result.stdout).toBe("");
    // The diagnostic obeys the same budget it is reporting on, so it arrives
    // truncated rather than blowing past the limit to explain itself.
    expect(result.stderr).toMatch(/^The capture manifest is larger than the runtime/);
    expect(Buffer.byteLength(result.stderr, "utf8")).toBeLessThanOrEqual(64);
  }, GIT_TEST_TIMEOUT);
});

function shellAction(sequence: number, operationId: string, command: string): RunnerActionV1 {
  return {
    schemaVersion: "gardener.runner.action/v1",
    sequence,
    operationId,
    kind: "shell.exec",
    command,
    cwd: "/workspace",
    timeoutMs: 30_000,
    maxOutputBytes: 64 * 1_024,
  };
}

function captureAction(sequence: number, operationId: string, baseSha: string): RunnerActionV1 {
  return {
    schemaVersion: "gardener.runner.action/v1",
    sequence,
    operationId,
    kind: "repository.capture",
    baseSha,
    timeoutMs: 300_000,
    maxOutputBytes: 4 * 1_024 * 1_024,
  };
}

async function planningFixture(): Promise<{
  executor: PlanningShellExecutor;
  workspace: string;
  runnerTemp: string;
  baseSha: string;
}> {
  const workspace = await temporaryDirectory();
  const runnerTemp = await temporaryDirectory();
  await initializeRepository(workspace);
  const baseSha = await headSha(workspace);
  return { executor: await createPlanningExecutor({ workspace, runnerTemp, baseSha }), workspace, runnerTemp, baseSha };
}

async function initializeRepository(workspace: string): Promise<void> {
  await writeFile(path.join(workspace, "one.txt"), "one\n");
  await git(workspace, ["init", "--quiet", "--initial-branch=main"]);
  await git(workspace, ["config", "user.email", "gardener@example.test"]);
  await git(workspace, ["config", "user.name", "Gardener"]);
  await git(workspace, ["config", "commit.gpgsign", "false"]);
  await git(workspace, ["add", "--all"]);
  await git(workspace, ["commit", "--quiet", "--message", "base"]);
}

async function headSha(workspace: string): Promise<string> {
  return (await git(workspace, ["rev-parse", "HEAD"])).trim();
}

async function git(cwd: string, argv: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...argv], {
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  });
  return stdout;
}

async function temporaryDirectory(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "gardener-capture-action-"));
  roots.push(root);
  return root;
}
