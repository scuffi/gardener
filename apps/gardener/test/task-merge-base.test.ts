import { canonicalJson, canonicalSha256 } from "@gardener/core";
import { describe, expect, it, vi } from "vitest";
import {
  normalizedEventV1Schema,
  taskBundleV1Schema,
  taskEffectProposalV1Schema,
  type NormalizedEventV1,
  type TaskBundleV1,
  type TaskCaptureManifestV1,
  type TaskEffectProposalV1,
  type TaskRunRequestV1,
} from "@gardener/contracts";
import type { RunnerActionResultV1 } from "@gardener/protocol";
import {
  buildTaskEffectPlan,
  captureChangesSha256,
  captureRecordFromResult,
  type CompletedTaskOutcomeV1,
  type TaskEffectPlanCaptureV1,
} from "../src/task-runtime/effect-plan";
import { createTaskHarnessRequest } from "../src/task-runtime/harness-adapter";
import { proposalAuthorityRefusal } from "../src/task-runtime/proposal-authority";
import { toolTarget } from "../src/task-runtime/run-trail";
import { actionToolAuthority, mergeBaseToolRefusal, taskDeclaresActionAuthority } from "../src/task-runtime/tool-authority";
import { taskToolInputKeys } from "../src/task-runtime/tool-input-schemas";
import { inspectRepositoryFixtureBundle } from "./fixture-bundle";

// flue-agent.ts imports the Flue runtime, which needs a Workers environment.
vi.mock("@flue/runtime", () => ({}));
vi.mock("@flue/runtime/cloudflare", () => ({ extend: vi.fn(() => ({})) }));
const { taskToolModelOutput } = await import("../src/task-runtime/flue-agent");

const sha = (character: string) => character.repeat(40);
const COMMIT = sha("b");
const HEAD = sha("d");
const BASE = sha("a");
const REPOSITORY_ID = "1374842705";
const actor = { id: "45369682", login: "scuffi" };

const pullRequest = {
  id: "555", number: 12, title: "Fix", body: null, labels: [], author: actor, draft: false, state: "open" as const, merged: false,
  base: { ref: "main", sha: sha("e"), repo: { id: REPOSITORY_ID, fullName: "scuffi/gardener" } },
  head: { ref: "feature/x", sha: HEAD, repo: { id: REPOSITORY_ID, fullName: "scuffi/gardener" } },
};

/** A maintainer's comment on #12, with the head checked out and confirmed by the bridge. */
function commentEvent(overrides: { pullRequest?: unknown; checkoutSha?: string | undefined } = {}): NormalizedEventV1 {
  const pull = "pullRequest" in overrides ? overrides.pullRequest : pullRequest;
  const checkoutSha = "checkoutSha" in overrides ? overrides.checkoutSha : HEAD;
  return normalizedEventV1Schema.parse({
    schemaVersion: "gardener.normalized-event/v1",
    eventId: "github:1:1",
    occurredAt: "2026-10-12T12:00:00.000Z",
    kind: "github.issue_comment.created",
    repository: {
      id: REPOSITORY_ID, ownerId: "45369682", owner: "scuffi", name: "gardener", fullName: "scuffi/gardener",
      visibility: "private", commitSha: COMMIT, ref: "refs/heads/main", defaultBranch: "main",
    },
    workflow: {
      runId: "1", runAttempt: 1, eventName: "issue_comment", workflowRef: "scuffi/gardener/.github/workflows/gardener.yml@refs/heads/main",
      jobWorkflowRef: `scuffi/gardener/.github/workflows/gardener-task.yml@${sha("c")}`, runnerEnvironment: "github-hosted",
    },
    actor,
    issue: { id: "555", number: 12, title: "Fix", body: null, labels: [], author: actor },
    comment: { id: "9", body: "@gardener merge main", author: actor, authorAssociation: "OWNER" },
    ...(pull === undefined ? {} : { pullRequest: pull }),
    ...(checkoutSha === undefined ? {} : { checkoutSha }),
  });
}

async function runRequest(event: NormalizedEventV1, overrides: Partial<Pick<TaskBundleV1, "tools" | "effects" | "effectOptions">> = {}): Promise<TaskRunRequestV1> {
  const bundle = taskBundleV1Schema.parse({
    ...structuredClone(inspectRepositoryFixtureBundle()),
    triggers: [{ kind: "github.issue_comment.created", labelsAll: [], mentions: [], authors: "any" }, { kind: "github.workflow_dispatch" }],
    tools: ["repository.read_file", "repository.exec", "repository.merge_base"],
    effects: ["issue.comment.create", "commit.create", "commit.merge_base"],
    effectOptions: { "commit.merge_base": { branches: ["feature/**"] }, "commit.create": { branches: ["feature/**"] } },
    ...overrides,
  });
  return {
    schemaVersion: "gardener.task-run-request/v1",
    runId: "run:fixture:1",
    bundle,
    bundleHash: await canonicalSha256(bundle),
    sourcePath: ".gardener/tasks/fixture/TASK.md",
    policySnapshotHash: "d".repeat(64),
    event,
    model: { id: "@cf/test/model" },
    admittedAt: "2026-10-12T12:00:00.000Z",
    deadlineAt: "2026-10-12T12:05:00.000Z",
  };
}

const mergePayload = { pullNumber: 12, branch: "feature/x", expectedHeadSha: HEAD, baseBranch: "main", baseSha: BASE, message: "Merge main into feature/x" };

function merge(payload: Record<string, unknown> = {}, references: Record<string, unknown> = {}): TaskEffectProposalV1 {
  return taskEffectProposalV1Schema.parse({
    stepName: "merge", kind: "commit.merge_base", payload: { ...mergePayload, ...payload }, references, rationale: "Bring main in.",
  });
}

const ordinaryCommit = taskEffectProposalV1Schema.parse({
  stepName: "commit", kind: "commit.create", payload: { branch: "feature/x", expectedHeadSha: HEAD, message: "Touch up." }, rationale: "Touch up.",
});

const written = { writtenMerge: { baseSha: BASE } };

describe("repository.merge_base tool", () => {
  it("is exposed only when the bundle declares it", async () => {
    const declared = await createTaskHarnessRequest(await runRequest(commentEvent()));
    expect(declared.tools.map((tool) => tool.name)).toContain("repository_merge_base");
    const undeclared = await createTaskHarnessRequest(await runRequest(commentEvent(), {
      tools: ["repository.read_file", "repository.exec"], effects: ["issue.comment.create"], effectOptions: undefined,
    }));
    expect(undeclared.tools.map((tool) => tool.name)).not.toContain("repository_merge_base");
  });

  it("takes no input and is recorded in the trail", () => {
    expect(taskToolInputKeys("repository_merge_base")).toEqual([]);
    expect(toolTarget("repository_merge_base", {})).toBe("base branch");
  });

  it("is authorized only by its own tool, and never authorizes a shell", () => {
    expect(actionToolAuthority("repository.merge_base")).toEqual(["repository_merge_base"]);
    expect(taskDeclaresActionAuthority(["repository.merge_base"], "repository.merge_base")).toBe(true);
    expect(taskDeclaresActionAuthority(["repository.exec"], "repository.merge_base")).toBe(false);
    expect(taskDeclaresActionAuthority(["repository.merge_base"], "shell.exec")).toBe(false);
  });

  it("is allowed only on a confirmed same-repository pull request head", () => {
    expect(mergeBaseToolRefusal(commentEvent())).toBeUndefined();
    expect(mergeBaseToolRefusal(commentEvent({ pullRequest: undefined, checkoutSha: undefined }))).toMatch(/not on one/);
    expect(mergeBaseToolRefusal(commentEvent({ checkoutSha: undefined }))).toMatch(/did not confirm checking it out/);
    // A fork the bridge let through anyway: the Worker refuses it on its own.
    const fork = { ...pullRequest, head: { ...pullRequest.head, repo: { id: "9999", fullName: "forker/gardener" } } };
    expect(mergeBaseToolRefusal(commentEvent({ pullRequest: fork }))).toMatch(/forker\/gardener.*never pushes to a fork/);
    const deleted = { ...pullRequest, head: { ...pullRequest.head, repo: null } };
    expect(mergeBaseToolRefusal(commentEvent({ pullRequest: deleted }))).toMatch(/a deleted repository/);
  });

  it("passes a refusal back to the model as the runner wrote it", () => {
    const stdout = JSON.stringify({ schemaVersion: "gardener.runner.merge-base-result/v1", status: "refused", reason: "The working tree already differs from HEAD" });
    const refused = { status: "failed", exitCode: 1, stdout, stderr: "The working tree already differs from HEAD" };
    expect(taskToolModelOutput(refused, "repository_merge_base")).toEqual({ content: stdout });
    // Other tools keep today's behaviour.
    expect(() => taskToolModelOutput(refused, "repository_exec")).toThrow(/did not complete: failed/);
    expect(taskToolModelOutput({ status: "completed", stdout: "{}", stderr: "" }, "repository_merge_base")).toEqual({ content: "{}" });
  });
});

describe("commit.merge_base proposal authority", () => {
  it("accepts exactly the values the tool returns", async () => {
    expect(proposalAuthorityRefusal(await runRequest(commentEvent()), merge(), [], written)).toBeUndefined();
  });

  it("refuses each value that does not match the checked-out pull request", async () => {
    const request = await runRequest(commentEvent());
    expect(proposalAuthorityRefusal(request, merge({ pullNumber: 13 }), [], written)).toMatch(/only on #12/);
    expect(proposalAuthorityRefusal(request, merge({ branch: "feature/y" }), [], written)).toBe("commit.merge_base branch must be the pull request's branch feature/x");
    expect(proposalAuthorityRefusal(request, merge({ expectedHeadSha: COMMIT }), [], written)).toBe(`commit.merge_base expectedHeadSha must be the checked-out head ${HEAD}`);
    expect(proposalAuthorityRefusal(request, merge({ baseBranch: "develop" }), [], written)).toBe("commit.merge_base baseBranch must be the pull request's base branch main");
    expect(proposalAuthorityRefusal(request, merge({}, { "/branch": { step: "x", output: "branch" } }), [], written)).toMatch(/must name|written directly/);
  });

  it("uses commit.create's branch patterns and never the default branch", async () => {
    // The default, gardener/**, does not cover a pull request's own branch.
    const defaults = await runRequest(commentEvent(), { effectOptions: undefined });
    expect(proposalAuthorityRefusal(defaults, merge(), [], written)).toMatch(/outside this task's branches \(allowed: gardener\/\*\*\)/);
    const onMain = { ...pullRequest, head: { ...pullRequest.head, ref: "main" } };
    const request = await runRequest(commentEvent({ pullRequest: onMain }), { effectOptions: { "commit.merge_base": { branches: ["**"] } } });
    expect(proposalAuthorityRefusal(request, merge({ branch: "main" }), [], written)).toMatch(/is the default branch/);
  });

  it("needs a run on a pull request head", async () => {
    const request = await runRequest(commentEvent({ pullRequest: undefined, checkoutSha: undefined }));
    expect(proposalAuthorityRefusal(request, merge(), [], written)).toMatch(/not on one/);
  });

  it("checks the merge the session saw written", async () => {
    const request = await runRequest(commentEvent());
    expect(proposalAuthorityRefusal(request, merge(), [], { writtenMerge: undefined })).toMatch(/call repository.merge_base first/);
    expect(proposalAuthorityRefusal(request, merge({ baseSha: sha("f") }), [], written)).toBe(`commit.merge_base baseSha must be ${BASE}, the base commit repository.merge_base merged`);
    expect(proposalAuthorityRefusal(request, ordinaryCommit, [], written)).toMatch(/only commit.merge_base can commit/);
    expect(proposalAuthorityRefusal(request, ordinaryCommit, [], { writtenMerge: undefined })).toBeUndefined();
  });

  it("never mixes a merge with ordinary commits", async () => {
    const request = await runRequest(commentEvent());
    expect(proposalAuthorityRefusal(request, merge(), [ordinaryCommit], written)).toMatch(/not both; step commit already proposed commit.create/);
    expect(proposalAuthorityRefusal(request, ordinaryCommit, [merge()])).toMatch(/not both; step merge already proposed commit.merge_base/);
  });

  it("keeps files and conflictedPaths for the capture", () => {
    expect(() => merge({ files: [] })).toThrow(/\/files is materialized from the trusted repository capture/);
    expect(() => merge({ conflictedPaths: [] })).toThrow(/\/conflictedPaths is materialized from the trusted repository capture/);
  });
});

const mergeManifest = {
  schemaVersion: "gardener.task-capture-manifest/v1",
  captureId: `cap_${"1".repeat(64)}`,
  baseSha: HEAD,
  files: [
    { path: "src/a.ts", status: "modified", mode: "100644", sizeBytes: 4, sha256: "e".repeat(64) },
    { path: "src/b.ts", status: "added", mode: "100644", sizeBytes: 2, sha256: "f".repeat(64) },
  ],
  totalBytes: 6,
  truncated: false,
  merge: { baseSha: BASE, conflictedPaths: ["src/a.ts"] },
} satisfies TaskCaptureManifestV1;
const { merge: _merge, ...plainManifest } = mergeManifest;

async function capture(manifest: TaskCaptureManifestV1): Promise<TaskEffectPlanCaptureV1> {
  return { manifest, changesSha256: await captureChangesSha256(manifest) };
}

function outcome(request: TaskRunRequestV1, proposedEffects: readonly TaskEffectProposalV1[]): CompletedTaskOutcomeV1 {
  return {
    schemaVersion: "gardener.task-outcome/v1", runId: request.runId, taskId: request.bundle.taskId, bundleHash: request.bundleHash,
    status: "completed", summary: "Done.", observations: [], proposedEffects: [...proposedEffects],
  };
}

describe("commit.merge_base effect-plan binding", () => {
  it("binds the merge capture, leaving files and conflictedPaths to it", async () => {
    const request = await runRequest(commentEvent());
    const plan = await buildTaskEffectPlan({ request, outcome: outcome(request, [merge()]), capture: await capture(mergeManifest) });
    expect(plan.capture?.merge).toEqual({ baseSha: BASE, conflictedPaths: ["src/a.ts"] });
    expect(plan.provenance.checkoutSha).toBe(HEAD);
    expect(plan.operations[0]?.payload).not.toHaveProperty("files");
    expect(plan.operations[0]?.payload).not.toHaveProperty("conflictedPaths");
  });

  it("refuses a baseSha other than the one the capture merged", async () => {
    const request = await runRequest(commentEvent());
    await expect(buildTaskEffectPlan({ request, outcome: outcome(request, [merge({ baseSha: sha("f") })]), capture: await capture(mergeManifest) }))
      .rejects.toThrow(`commit.merge_base baseSha must be ${BASE}, the base commit the captured merge merged`);
  });

  it("refuses to mix merge and plain captures with the other commit kind", async () => {
    const request = await runRequest(commentEvent());
    await expect(buildTaskEffectPlan({ request, outcome: outcome(request, [ordinaryCommit]), capture: await capture(mergeManifest) }))
      .rejects.toThrow(/commit.create cannot commit a merge capture/);
    await expect(buildTaskEffectPlan({ request, outcome: outcome(request, [merge()]), capture: await capture(plainManifest) }))
      .rejects.toThrow(/commit.merge_base needs a merge capture/);
  });

  it("rechecks the event rules when the plan is built", async () => {
    const request = await runRequest(commentEvent());
    await expect(buildTaskEffectPlan({ request, outcome: outcome(request, [merge({ baseBranch: "develop" })]), capture: await capture(mergeManifest) }))
      .rejects.toThrow(/baseBranch must be the pull request's base branch main/);
  });

  it("refuses a capture ref whose merge disagrees with its manifest", async () => {
    const manifestJson = canonicalJson(mergeManifest);
    const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(manifestJson)))]
      .map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const result = (ref: Record<string, unknown>): RunnerActionResultV1 => ({
      schemaVersion: "gardener.runner.action-result/v1", sequence: 1, operationId: "op_capture", status: "completed", exitCode: 0, stderr: "", outputTruncated: false,
      stdout: JSON.stringify({
        schemaVersion: "gardener.runner.capture-result/v1",
        status: "captured",
        ref: {
          schemaVersion: "gardener.task-capture-ref/v1", captureId: mergeManifest.captureId, baseSha: HEAD, manifestSha256: digest,
          fileCount: 2, sizeBytes: 6, ...ref,
        },
        manifestJson,
      }),
    });
    const changesSha256 = await captureChangesSha256(mergeManifest);
    await expect(captureRecordFromResult(result({ changesSha256, merge: mergeManifest.merge }), HEAD)).resolves.toMatchObject({ manifest: mergeManifest });
    await expect(captureRecordFromResult(result({ changesSha256, merge: { baseSha: sha("f"), conflictedPaths: ["src/a.ts"] } }), HEAD))
      .rejects.toThrow(/Capture merge mismatch/);
    await expect(captureRecordFromResult(result({ changesSha256 }), HEAD)).rejects.toThrow(/Capture merge mismatch/);
  });
});

describe("merge guidance in the prompt", () => {
  it("explains the merge procedure on a pull request head", async () => {
    const { prompt } = await createTaskHarnessRequest(await runRequest(commentEvent()));
    expect(prompt).toContain("call repository.merge_base first, before changing anything");
    expect(prompt).toContain("Edit only the files it lists as conflictedFiles");
    expect(prompt).toContain("propose commit.merge_base with exactly the values the tool returned (pullNumber, branch, expectedHeadSha, baseBranch, baseSha)");
    expect(prompt).toContain("Never run git merge, rebase, commit, reset, checkout or push, and never stage files");
    expect(prompt).toContain("A run either merges or makes ordinary commits");
    expect(prompt).toContain("do not start the pull request's checks");
    expect(prompt).toContain("commit.merge_base files and conflictedPaths");
    expect(prompt).not.toContain("A merge of the base branch is not possible");
  });

  it("says why a merge is impossible when the run is not on a pull request head", async () => {
    const { prompt } = await createTaskHarnessRequest(await runRequest(commentEvent({ pullRequest: undefined, checkoutSha: undefined })));
    expect(prompt).toContain("A merge of the base branch is not possible in this run");
    expect(prompt).toMatch(/closed or comes from a fork/);
    expect(prompt).not.toContain("call repository.merge_base first");
  });

  it("says nothing about merging when the task does not declare the tool", async () => {
    const { prompt } = await createTaskHarnessRequest(await runRequest(commentEvent(), {
      tools: ["repository.read_file", "repository.exec"], effects: ["issue.comment.create"], effectOptions: undefined,
    }));
    expect(prompt).not.toContain("repository.merge_base");
  });
});
