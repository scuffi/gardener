import { canonicalJson, canonicalSha256 } from "@gardener/core";
import { describe, expect, it } from "vitest";
import {
  taskEffectProposalV1Schema,
  type NormalizedEventV1,
  type TaskBundleV1,
  type TaskCaptureManifestV1,
  type TaskEffectProposalV1,
  type TaskRunRequestV1,
} from "@gardener/contracts";
import { runnerActionV1Schema, type RunnerActionResultV1 } from "@gardener/protocol";
import {
  buildTaskEffectPlan,
  captureAction,
  captureChangesSha256,
  captureMaterializingSteps,
  captureRecordFromResult,
  settledTaskOutcome,
  type CompletedTaskOutcomeV1,
} from "../src/task-runtime/effect-plan";
import { inspectRepositoryFixtureBundle } from "./fixture-bundle";

const COMMIT = "b".repeat(40);
const OTHER_COMMIT = "a".repeat(40);

const manifest = {
  schemaVersion: "gardener.task-capture-manifest/v1",
  captureId: `cap_${"1".repeat(64)}`,
  baseSha: COMMIT,
  files: [
    { path: "src/a.ts", status: "modified", mode: "100644", sizeBytes: 4, sha256: "e".repeat(64) },
    { path: "src/gone.ts", status: "deleted" },
  ],
  totalBytes: 4,
  truncated: false,
} satisfies TaskCaptureManifestV1;

const CHANGES_SHA256 = await captureChangesSha256(manifest);

function proposal(value: unknown): TaskEffectProposalV1 {
  return taskEffectProposalV1Schema.parse(value);
}

const comment = proposal({
  stepName: "comment",
  kind: "issue.comment.create",
  payload: {
    issueNumber: 1,
    expectedIssueState: "open",
    expectedIssueUpdatedAt: "2026-09-17T12:00:00.000Z",
    body: "Thanks.",
  },
  rationale: "Acknowledge.",
});

const commit = proposal({
  stepName: "commit",
  kind: "commit.create",
  payload: { branch: "gardener/fix-1", expectedHeadSha: COMMIT, message: "Fix it." },
  rationale: "Commit the captured change.",
});

const secondCommit = proposal({ ...commit, stepName: "commit-two", rationale: "And again." });

function event(): NormalizedEventV1 {
  return {
    schemaVersion: "gardener.normalized-event/v1",
    eventId: "event:1",
    occurredAt: "2026-09-17T12:00:00.000Z",
    kind: "github.issue.opened",
    repository: {
      id: "1374842705",
      ownerId: "45369682",
      owner: "scuffi",
      name: "demo",
      fullName: "scuffi/demo",
      visibility: "public",
      commitSha: COMMIT,
      ref: "refs/heads/main",
      defaultBranch: "main",
    },
    workflow: {
      runId: "35256179260",
      runAttempt: 1,
      eventName: "issues",
      workflowRef: "scuffi/demo/.github/workflows/gardener.yml@refs/heads/main",
      jobWorkflowRef: `scuffi/demo/.github/workflows/gardener-task.yml@${"c".repeat(40)}`,
      runnerEnvironment: "github-hosted",
    },
    actor: { id: "45369682", login: "scuffi" },
    issue: { id: "999", number: 1, title: "Bug", body: "Broken", state: "open", updatedAt: "2026-09-17T12:00:00.000Z", labels: ["gardener-test"], author: { id: "45369682", login: "scuffi" } },
  };
}

async function runRequest(overrides: { maxEffectOperations?: number } = {}): Promise<TaskRunRequestV1> {
  const bundle = structuredClone(inspectRepositoryFixtureBundle()) as TaskBundleV1;
  bundle.effects = ["issue.comment.create", "commit.create"] as TaskBundleV1["effects"];
  bundle.triggers = [{ kind: "github.issue.opened", labelsAll: [], mentions: [], authors: "any" }];
  if (overrides.maxEffectOperations !== undefined) bundle.limits.maxEffectOperations = overrides.maxEffectOperations;
  return {
    schemaVersion: "gardener.task-run-request/v1",
    runId: "run:fixture:1",
    bundle,
    bundleHash: await canonicalSha256(bundle),
    sourcePath: ".gardener/tasks/fixture.issue-triage/TASK.md",
    policySnapshotHash: "d".repeat(64),
    event: event(),
    model: { id: "@cf/test/model" },
    admittedAt: "2026-09-17T12:00:00.000Z",
    deadlineAt: "2026-09-17T12:05:00.000Z",
  };
}

function outcome(request: TaskRunRequestV1, proposedEffects: readonly TaskEffectProposalV1[]): CompletedTaskOutcomeV1 {
  return {
    schemaVersion: "gardener.task-outcome/v1",
    runId: request.runId,
    taskId: request.bundle.taskId,
    bundleHash: request.bundleHash,
    status: "completed",
    summary: "Done.",
    observations: [],
    proposedEffects: [...proposedEffects],
  };
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Builds the exact envelope a healthy runner returns, then lets a case bend it. */
async function captureResult(overrides: {
  manifestJson?: string;
  ref?: Record<string, unknown>;
  status?: RunnerActionResultV1["status"];
  stdout?: string;
  stderr?: string;
} = {}): Promise<RunnerActionResultV1> {
  const manifestJson = overrides.manifestJson ?? canonicalJson(manifest);
  const stdout = overrides.stdout ?? JSON.stringify({
    schemaVersion: "gardener.runner.capture-result/v1",
    status: "captured",
    ref: {
      schemaVersion: "gardener.task-capture-ref/v1",
      captureId: manifest.captureId,
      baseSha: manifest.baseSha,
      manifestSha256: await sha256Hex(manifestJson),
      changesSha256: CHANGES_SHA256,
      fileCount: manifest.files.length,
      sizeBytes: manifest.totalBytes,
      ...overrides.ref,
    },
    manifestJson,
  });
  const status = overrides.status ?? "completed";
  return {
    schemaVersion: "gardener.runner.action-result/v1",
    sequence: 1,
    operationId: "op_capture",
    status,
    exitCode: status === "completed" ? 0 : status === "failed" ? 1 : null,
    stdout,
    stderr: overrides.stderr ?? "",
    outputTruncated: false,
  };
}

describe("trusted capture action", () => {
  it("leaves the model no field to fill and pins the run's commit", () => {
    const action = captureAction(4, "op_capture", COMMIT);
    expect(action).toEqual({
      schemaVersion: "gardener.runner.action/v1",
      sequence: 4,
      operationId: "op_capture",
      kind: "repository.capture",
      baseSha: COMMIT,
      timeoutMs: 5 * 60_000,
      maxOutputBytes: 4 * 1_024 * 1_024,
    });
    expect(() => runnerActionV1Schema.parse(action)).not.toThrow();
  });

  it("clamps trusted capture to the remaining runtime and manifest budget", () => {
    expect(captureAction(5, "op_capture", COMMIT, 1_234, 56_789)).toMatchObject({
      timeoutMs: 1_234,
      maxOutputBytes: 56_789,
    });
  });

  it("names exactly the steps whose contents the capture owns", () => {
    expect(captureMaterializingSteps([comment]).map((step) => step.stepName)).toEqual([]);
    expect(captureMaterializingSteps([comment, commit]).map((step) => step.stepName)).toEqual(["commit"]);
  });
});

describe("capture admission into the runtime", () => {
  it("admits a coherent capture as metadata, with no bytes and no local path", async () => {
    const record = await captureRecordFromResult(await captureResult(), COMMIT);
    expect(record.manifest).toEqual(manifest);
    expect(record.changesSha256).toBe(CHANGES_SHA256);
    expect(record.ack).toEqual({ captureId: manifest.captureId, fileCount: 2, sizeBytes: 4 });

    // The whole record is paths, modes, sizes, and digests. There is nowhere
    // for a file byte or a runner directory to be, and this asserts it of the
    // value the run actually stores rather than of the schema alone.
    const stored = canonicalJson(record);
    expect(stored).not.toContain("/tmp");
    expect(stored).not.toContain("gardener-capture");
    expect(stored).not.toContain("content");
  });

  it("is a pure function of the runner's answer, so an exact replay is identical", async () => {
    const result = await captureResult();
    expect(canonicalJson(await captureRecordFromResult(result, COMMIT)))
      .toBe(canonicalJson(await captureRecordFromResult(result, COMMIT)));
  });

  it("independently derives and refuses a forged changes digest", async () => {
    await expect(captureRecordFromResult(
      await captureResult({ ref: { changesSha256: "0".repeat(64) } }),
      COMMIT,
    )).rejects.toThrow(/changes digest does not match/);
  });

  it("redacts runner-local absolute paths from durable capture failures", async () => {
    await expect(captureRecordFromResult(await captureResult({
      status: "failed",
      stderr: "fatal: /home/runner/work/private/repo/.git/config is unreadable",
    }), COMMIT)).rejects.not.toThrow(/\/home\/runner|private\/repo/);
  });

  it("refuses a manifest the reference's digest does not cover", async () => {
    await expect(captureRecordFromResult(
      await captureResult({ ref: { manifestSha256: "0".repeat(64) } }),
      COMMIT,
    )).rejects.toThrow(/digest does not cover the manifest/);
  });

  it("refuses a manifest that is not in canonical form", async () => {
    // Same value, different bytes. Accepting it would mean two manifests with
    // the same meaning digest differently, and the plan binds the bytes.
    const pretty = JSON.stringify(manifest, null, 2);
    await expect(captureRecordFromResult(await captureResult({ manifestJson: pretty }), COMMIT))
      .rejects.toThrow(/not canonical/);
  });

  it("refuses a reference that disagrees with its own manifest", async () => {
    for (const [override, pattern] of [
      [{ captureId: `cap_${"9".repeat(64)}` }, /identity mismatch/],
      [{ fileCount: 7 }, /file count mismatch/],
      [{ sizeBytes: 999 }, /size mismatch/],
      [{ baseSha: OTHER_COMMIT }, /base commit mismatch/],
    ] as const) {
      await expect(captureRecordFromResult(await captureResult({ ref: override }), COMMIT))
        .rejects.toThrow(pattern);
    }
  });

  it("refuses a capture taken against a commit this run is not bound to", async () => {
    // Both sides have to move together for this to be reachable at all, which
    // is the point: the run's commit comes from the verified OIDC hello.
    await expect(captureRecordFromResult(await captureResult(), OTHER_COMMIT))
      .rejects.toThrow(/run base commit mismatch/);
  });

  it("refuses an unchanged tree rather than planning an empty commit", async () => {
    const stdout = JSON.stringify({ schemaVersion: "gardener.runner.capture-result/v1", status: "unchanged" });
    await expect(captureRecordFromResult(await captureResult({ stdout }), COMMIT))
      .rejects.toThrow(/working tree is unchanged/);
  });

  it("surfaces a failed capture instead of inventing commit contents", async () => {
    await expect(captureRecordFromResult(
      await captureResult({ status: "failed", stdout: "", stderr: "Git index changed during execution" }),
      COMMIT,
    )).rejects.toThrow(/Repository capture failed: Git index changed/);
    await expect(captureRecordFromResult(await captureResult({ status: "cancelled", stdout: "" }), COMMIT))
      .rejects.toThrow(/Repository capture cancelled/);
  });

  it("refuses output that is not a capture envelope at all", async () => {
    await expect(captureRecordFromResult(await captureResult({ stdout: "not json" }), COMMIT))
      .rejects.toThrow(/malformed result/);
    await expect(captureRecordFromResult(await captureResult({ stdout: "{}" }), COMMIT))
      .rejects.toThrow();
  });

  it("refuses an envelope carrying file bytes or a runner path", async () => {
    const honest = JSON.parse((await captureResult()).stdout) as Record<string, unknown>;
    for (const smuggled of [{ directory: "/home/runner/work/_temp/x" }, { content: { "src/a.ts": "AA==" } }]) {
      await expect(captureRecordFromResult(
        await captureResult({ stdout: JSON.stringify({ ...honest, ...smuggled }) }),
        COMMIT,
      )).rejects.toThrow();
    }
  });
});

describe("settling a finished run", () => {
  it("keeps a completed run completed when its plan builds", async () => {
    const request = await runRequest();
    const value = outcome(request, [comment]);
    expect(await settledTaskOutcome({ request, outcome: value })).toEqual(value);
  });

  it("makes a capture-backed commit reachable end to end", async () => {
    const request = await runRequest();
    const record = await captureRecordFromResult(await captureResult(), COMMIT);
    const settled = await settledTaskOutcome({ request, outcome: outcome(request, [commit]), capture: record });
    expect(settled.status).toBe("completed");

    const plan = await buildTaskEffectPlan({ request, outcome: outcome(request, [commit]), capture: record });
    expect(plan.capture).toEqual(manifest);
    expect(plan.changesSha256).toBe(CHANGES_SHA256);
    expect(plan.operations.map((operation) => operation.kind)).toEqual(["commit.create"]);
    // The plan binds the capture's metadata and nothing the model could have
    // written into it.
    expect(plan.operations[0]?.payload).not.toHaveProperty("files");
  });

  it("fails the run, rather than wedging it, when the plan exceeds the task's ceiling", async () => {
    const request = await runRequest({ maxEffectOperations: 1 });
    const value = outcome(request, [comment, proposal({ ...comment, stepName: "second" })]);

    // The D1 row this produces says `failed`, not `completed`: a plan that
    // cannot be built is a failed run, and persisting success would leave a
    // run whose terminal throws on every reconnect.
    const settled = await settledTaskOutcome({ request, outcome: value });
    expect(settled.status).toBe("failed");
    if (settled.status !== "failed") throw new Error("unreachable");
    expect(settled.error).toMatchObject({ code: "effect.plan_rejected", retryable: false });
    expect(settled.error.message).toMatch(/maxEffectOperations|operations/);
  });

  it("fails the run when a step references one that does not precede it", async () => {
    const request = await runRequest();
    const forward = proposal({
      ...comment,
      stepName: "forward",
      references: { "/body": { step: "later", output: "commentUrl" } },
    });
    const settled = await settledTaskOutcome({ request, outcome: outcome(request, [forward]) });
    expect(settled.status).toBe("failed");
    if (settled.status !== "failed") throw new Error("unreachable");
    expect(settled.error.code).toBe("effect.plan_rejected");
  });

  it("fails the run when a commit has no capture behind it", async () => {
    const request = await runRequest();
    const settled = await settledTaskOutcome({ request, outcome: outcome(request, [commit]) });
    expect(settled.status).toBe("failed");
    if (settled.status !== "failed") throw new Error("unreachable");
    expect(settled.error.message).toMatch(/admitted no capture/);
  });

  it("fails the run when two steps each claim the one capture", async () => {
    // A run photographs the working tree once, so two commits would both
    // claim the same change set and the second would re-apply the first.
    const request = await runRequest();
    const record = await captureRecordFromResult(await captureResult(), COMMIT);
    const settled = await settledTaskOutcome({
      request,
      outcome: outcome(request, [commit, secondCommit]),
      capture: record,
    });
    expect(settled.status).toBe("failed");
    if (settled.status !== "failed") throw new Error("unreachable");
    expect(settled.error.message).toMatch(/commit, commit-two each materialize repository changes/);
  });

  it("settles identically on every reconnect, so a retry is never a new answer", async () => {
    const request = await runRequest({ maxEffectOperations: 1 });
    const value = outcome(request, [comment, proposal({ ...comment, stepName: "second" })]);
    expect(canonicalJson(await settledTaskOutcome({ request, outcome: value })))
      .toBe(canonicalJson(await settledTaskOutcome({ request, outcome: value })));
  });
});
