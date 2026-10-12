import { describe, expect, it } from "vitest";
import { operationCatalog, operationProposalPayloadJsonSchema, operationSchema } from "../src/operations";
import { branchWriteFields } from "../src/branches";
import {
  checksOutPullRequestHead,
  eventNameByTriggerKind,
  normalizedEventV1Schema,
  taskBundleV1Schema,
  taskCaptureChangesDigestInput,
  taskCaptureManifestText,
  taskCaptureManifestV1Schema,
  taskCaptureRefV1Schema,
  taskCheckoutSha,
  taskEffectPlanV1Schema,
  taskEffectProposalV1Schema,
  taskEventBindingFromNormalizedEvent,
  threadOpenerLogin,
  triggeringPullRequestKinds,
} from "../src/task";

const head = "d".repeat(40);
const baseSha = "e".repeat(40);
const commitSha = "b".repeat(40);
const sha256 = "c".repeat(64);
const actor = { id: "45369682", login: "scuffi" };

const repository = {
  id: "1374842705", ownerId: "45369682", owner: "scuffi", name: "gardener", fullName: "scuffi/gardener",
  visibility: "private", commitSha, ref: "refs/heads/main", defaultBranch: "main",
};

function pullRequest(number = 12) {
  return {
    id: "555", number, title: "t", body: null, labels: [], author: { id: "7", login: "opener" }, draft: false,
    state: "open", merged: false,
    base: { ref: "main", sha: "a".repeat(40), repo: { id: "1374842705", fullName: "scuffi/gardener" } },
    head: { ref: "feature", sha: head, repo: { id: "1374842705", fullName: "scuffi/gardener" } },
  };
}

function event(kind: string, payload: Record<string, unknown>): Record<string, unknown> {
  return {
    schemaVersion: "gardener.normalized-event/v1",
    eventId: "github:1:1",
    occurredAt: "2026-10-09T12:00:00.000Z",
    repository,
    workflow: {
      runId: "1", runAttempt: 1, eventName: eventNameByTriggerKind[kind as never],
      workflowRef: "scuffi/gardener/.github/workflows/gardener.yml@refs/heads/main",
      jobWorkflowRef: "scuffi/gardener/.github/workflows/gardener-task.yml@" + "c".repeat(40),
      runnerEnvironment: "github-hosted",
    },
    actor,
    kind,
    ...payload,
  };
}

const issue = { id: "999", number: 12, title: "t", body: null, labels: [], author: { id: "7", login: "opener" } };
const comment = { id: "3", body: "@gardener merge main", author: actor, authorAssociation: "MEMBER" };

function commentEvent(extra: Record<string, unknown> = {}) {
  return event("github.issue_comment.created", { issue, comment, ...extra });
}

describe("comment events that carry their pull request", () => {
  it("accept an optional pull request and keep the issue as the resource", () => {
    const parsed = normalizedEventV1Schema.parse(commentEvent({ pullRequest: pullRequest(), checkoutSha: head }));
    const plain = normalizedEventV1Schema.parse(commentEvent());
    // Binding, thread opener and resource read the issue exactly as before.
    expect(taskEventBindingFromNormalizedEvent(parsed)).toEqual(taskEventBindingFromNormalizedEvent(plain));
    expect(taskEventBindingFromNormalizedEvent(parsed).resource).toEqual({ kind: "issue", id: "999", number: 12 });
    expect(threadOpenerLogin(parsed)).toBe("opener");
  });

  it("refuses a pull request other than the commented issue", () => {
    expect(() => normalizedEventV1Schema.parse(commentEvent({ pullRequest: pullRequest(13) }))).toThrow(/issue it was written on/);
  });
});

describe("checkoutSha", () => {
  it("is allowed only with a pull request, and only as its head", () => {
    expect(() => normalizedEventV1Schema.parse(commentEvent({ checkoutSha: head }))).toThrow(/only with the pull request/);
    expect(() => normalizedEventV1Schema.parse(commentEvent({ pullRequest: pullRequest(), checkoutSha: baseSha })))
      .toThrow(/must equal the pull request's head/);
    expect(() => normalizedEventV1Schema.parse(event("github.workflow_dispatch", { checkoutSha: head }))).toThrow(/only with the pull request/);
    expect(normalizedEventV1Schema.parse(event("github.workflow_dispatch", { pullRequest: pullRequest(), checkoutSha: head })).checkoutSha).toBe(head);
    expect(normalizedEventV1Schema.parse(event("github.pull_request.opened", { pullRequest: pullRequest(), checkoutSha: head })).checkoutSha).toBe(head);
    expect(() => normalizedEventV1Schema.parse(event("github.pull_request.opened", { pullRequest: pullRequest(), checkoutSha: "A".repeat(40) }))).toThrow();
  });

  it("decides the checkout for head-checkout bundles only", () => {
    const opted = { checkout: "pull-request-head" as const };
    const merging = { effects: ["commit.merge_base"] };
    const withSha = normalizedEventV1Schema.parse(commentEvent({ pullRequest: pullRequest(), checkoutSha: head }));
    const manual = normalizedEventV1Schema.parse(event("github.workflow_dispatch", { pullRequest: pullRequest(), checkoutSha: head }));
    expect(taskCheckoutSha(opted, withSha)).toBe(head);
    expect(taskCheckoutSha(merging, withSha)).toBe(head);
    expect(taskCheckoutSha(opted, manual)).toBe(head);
    expect(taskCheckoutSha({}, withSha)).toBe(commitSha);
    // Without checkoutSha (an older bridge), a comment keeps the default
    // checkout even if it carries a pull request; pull request events keep
    // today's rule.
    const withoutSha = normalizedEventV1Schema.parse(commentEvent({ pullRequest: pullRequest() }));
    expect(taskCheckoutSha(opted, withoutSha)).toBe(commitSha);
    expect(taskCheckoutSha(opted, normalizedEventV1Schema.parse(event("github.workflow_dispatch", { pullRequest: pullRequest() })))).toBe(commitSha);
    expect(taskCheckoutSha(opted, normalizedEventV1Schema.parse(event("github.pull_request.opened", { pullRequest: pullRequest() })))).toBe(head);
    expect(checksOutPullRequestHead(merging)).toBe(true);
    expect(checksOutPullRequestHead({ effects: ["commit.create"] })).toBe(false);
  });
});

describe("commit.merge_base contract", () => {
  it("is a git-family kind, a branch write, confined to the triggering pull request", () => {
    expect(operationCatalog.find((entry) => entry.kind === "commit.merge_base")?.family).toBe("git");
    expect(branchWriteFields["commit.merge_base"]).toBe("branch");
    expect(triggeringPullRequestKinds).toContain("commit.merge_base");
  });

  it("keeps capture-owned fields out of the model's payload schema", () => {
    const schema = JSON.parse(operationProposalPayloadJsonSchema("commit.merge_base")) as { properties: Record<string, unknown>; required: string[] };
    expect(Object.keys(schema.properties).sort()).toEqual(["baseBranch", "baseSha", "branch", "expectedHeadSha", "message", "pullNumber"]);
    expect(schema.required).not.toContain("files");
    expect(schema.required).not.toContain("conflictedPaths");
    const proposal = { stepName: "merge", kind: "commit.merge_base", rationale: "Merge main.", payload: { pullNumber: 12, branch: "feature", expectedHeadSha: head, baseBranch: "main", baseSha, message: "Merge main" } };
    expect(() => taskEffectProposalV1Schema.parse(proposal)).not.toThrow();
    expect(() => taskEffectProposalV1Schema.parse({ ...proposal, payload: { ...proposal.payload, conflictedPaths: [] } })).toThrow(/materialized from the trusted repository capture/);
  });

  it("parses as an exact operation with an empty conflicted set", () => {
    expect(() => operationSchema.parse({
      schemaVersion: "v2", id: "op", repository: { provider: "github", id: "1", owner: "scuffi", name: "gardener", defaultBranch: "main" },
      kind: "commit.merge_base", pullNumber: 12, branch: "feature", expectedHeadSha: head, baseBranch: "main", baseSha, message: "Merge main",
      files: [{ path: "src/a.ts", captured: { status: "deleted" } }], conflictedPaths: [],
    })).not.toThrow();
  });
});

describe("bundle rules", () => {
  const bundle = (overrides: Record<string, unknown>) => ({
    schemaVersion: "gardener.task-bundle/v1", taskId: "merge", name: "Merge", description: "Merge.", instructions: "Merge.",
    model: "@cf/moonshotai/kimi-k2.6", triggers: [{ kind: "github.workflow_dispatch" }], tools: [], effects: [],
    network: { default: "deny", allow: [], deny: [] },
    limits: { runtimeSeconds: 300, maxTurns: 8, maxToolCalls: 8, inputTokens: 60_000, outputTokens: 16_000 },
    ...overrides,
  });
  const commentTrigger = [{ kind: "github.issue_comment.created", labelsAll: [], mentions: [], authors: "maintainers" }, { kind: "github.workflow_dispatch" }];

  it("lets head checkout and merge commits use an issue comment trigger", () => {
    expect(() => taskBundleV1Schema.parse(bundle({ checkout: "pull-request-head" }))).toThrow(/pull request or issue comment trigger/);
    expect(() => taskBundleV1Schema.parse(bundle({ checkout: "pull-request-head", triggers: commentTrigger }))).not.toThrow();
    expect(() => taskBundleV1Schema.parse(bundle({ effects: ["commit.merge_base"], tools: ["repository.merge_base"] })))
      .toThrow(/commit.merge_base needs a pull request or issue comment trigger/);
    expect(() => taskBundleV1Schema.parse(bundle({ effects: ["commit.merge_base"], tools: ["repository.merge_base"], triggers: commentTrigger }))).not.toThrow();
  });

  it("requires the repository.merge_base tool for commit.merge_base", () => {
    expect(() => taskBundleV1Schema.parse(bundle({ effects: ["commit.merge_base"], triggers: commentTrigger }))).toThrow(/needs the repository.merge_base tool/);
  });
});

const plainManifest = {
  schemaVersion: "gardener.task-capture-manifest/v1" as const,
  captureId: "run:1:capture:1",
  baseSha: head,
  files: [
    { path: "src/a.ts", status: "modified" as const, mode: "100644" as const, sizeBytes: 12, sha256 },
    { path: "src/c.ts", status: "deleted" as const },
  ],
  totalBytes: 12,
  truncated: false as const,
};
const merge = { baseSha, conflictedPaths: ["src/a.ts"] };

describe("merge captures", () => {
  it("leave a plain capture's identity unchanged", () => {
    // Pinned bytes: the stream a plain capture produced before merge captures existed.
    const expected = `6:upsert8:src/a.ts6:1006442:1264:${sha256}6:delete8:src/c.ts`;
    expect(new TextDecoder().decode(taskCaptureChangesDigestInput(taskCaptureManifestV1Schema.parse(plainManifest)))).toBe(expected);
    expect(taskCaptureManifestText(plainManifest)).not.toContain("merge");
    expect(taskCaptureManifestText(plainManifest)).not.toContain("baseIdentical");
  });

  it("bind the merge, and base identity, into the capture identity", () => {
    const plain = new TextDecoder().decode(taskCaptureChangesDigestInput(plainManifest));
    const merged = new TextDecoder().decode(taskCaptureChangesDigestInput({ ...plainManifest, merge }));
    expect(merged).toBe(`${plain}5:merge40:${baseSha}1:18:src/a.ts`);
    const other = new TextDecoder().decode(taskCaptureChangesDigestInput({ ...plainManifest, merge: { ...merge, conflictedPaths: [] } }));
    expect(other).not.toBe(merged);
    const protectedFile = { path: ".github/workflows/ci.yml", status: "deleted" as const, baseIdentical: true as const };
    const withProtected = new TextDecoder().decode(taskCaptureChangesDigestInput({ ...plainManifest, files: [...plainManifest.files, protectedFile], merge }));
    expect(withProtected).toContain("14:base-identical");
  });

  it("require sorted, unique conflicted paths", () => {
    expect(() => taskCaptureManifestV1Schema.parse({ ...plainManifest, merge: { baseSha, conflictedPaths: ["b", "a"] } })).toThrow(/sorted and unique/);
    expect(() => taskCaptureManifestV1Schema.parse({ ...plainManifest, merge: { baseSha, conflictedPaths: ["a", "a"] } })).toThrow(/sorted and unique/);
    expect(taskCaptureRefV1Schema.parse({
      schemaVersion: "gardener.task-capture-ref/v1", captureId: "run:1:capture:1", baseSha: head, manifestSha256: sha256,
      changesSha256: sha256, fileCount: 2, sizeBytes: 12, merge,
    }).merge).toEqual(merge);
  });

  it("admit a protected path only in a merge capture that proved it equals the base", () => {
    const workflow = { path: ".github/workflows/ci.yml", status: "modified" as const, mode: "100644" as const, sizeBytes: 3, sha256 };
    const manifest = (file: Record<string, unknown>, withMerge: boolean) => ({
      ...plainManifest, files: [plainManifest.files[0], file], totalBytes: 15, ...(withMerge ? { merge } : {}),
    });
    expect(() => taskCaptureManifestV1Schema.parse(manifest({ ...workflow, baseIdentical: true }, true))).not.toThrow();
    expect(() => taskCaptureManifestV1Schema.parse(manifest(workflow, true))).toThrow(/may not write the protected path/);
    expect(() => taskCaptureManifestV1Schema.parse(manifest(workflow, false))).toThrow(/may not write the protected path/);
    expect(() => taskCaptureManifestV1Schema.parse(manifest({ ...workflow, baseIdentical: true }, false))).toThrow(/only for a protected path in a merge capture/);
    // The exemption itself, not only the baseIdentical rule, needs the merge.
    expect(() => taskCaptureManifestV1Schema.parse(manifest({ ...workflow, baseIdentical: true }, false))).toThrow(/may not write the protected path/);
    expect(() => taskCaptureManifestV1Schema.parse(manifest({ ...workflow, path: "src/x.ts", baseIdentical: true }, true))).toThrow(/only for a protected path/);
  });
});

describe("plans with merge commits", () => {
  const binding = {
    kind: "github.issue_comment.created", eventName: "issue_comment", action: "created",
    resource: { kind: "issue", id: "999", number: 12 }, commentId: "3",
  };
  const payload = { pullNumber: 12, branch: "feature", expectedHeadSha: head, baseBranch: "main", baseSha, message: "Merge main into feature" };
  const step = (kind: string, stepName: string, order: number, stepPayload: Record<string, unknown>, references: Record<string, unknown> = {}) => ({
    stepName, operationId: `run:1:${order}:${stepName}`, kind, payload: stepPayload, references, rationale: `Apply ${kind}.`,
  });
  const plan = (operations: unknown[], capture: Record<string, unknown> = { ...plainManifest, merge }) => ({
    schemaVersion: "gardener.task-effect-plan/v1", runId: "run:1", taskId: "merge", taskName: "Merge", bundleHash: sha256,
    repository: { id: "1374842705", fullName: "scuffi/gardener", defaultBranch: "main" },
    provenance: { sourcePath: ".gardener/tasks/merge/TASK.md", commitSha, checkoutSha: head, workflowRunId: "1", workflowRunAttempt: 1 },
    event: binding, limits: {}, branchPatterns: { "commit.merge_base": ["**"] },
    capture, changesSha256: sha256, operations,
  });

  it("accepts one merge commit on a merge capture", () => {
    expect(() => taskEffectPlanV1Schema.parse(plan([step("commit.merge_base", "merge", 1, payload)]))).not.toThrow();
  });

  it("refuses a merge commit on a plain capture and a plain commit on a merge capture", () => {
    expect(() => taskEffectPlanV1Schema.parse(plan([step("commit.merge_base", "merge", 1, payload)], plainManifest))).toThrow(/needs a merge capture/);
    const commit = step("commit.create", "commit", 1, { branch: "gardener/x", expectedHeadSha: head, message: "Fix" });
    expect(() => taskEffectPlanV1Schema.parse({ ...plan([commit]), branchPatterns: undefined })).toThrow(/cannot commit a merge capture/);
  });

  it("binds the base and head to the capture", () => {
    expect(() => taskEffectPlanV1Schema.parse(plan([step("commit.merge_base", "merge", 1, { ...payload, baseSha: "f".repeat(40) })]))).toThrow(/merged base commit/);
    expect(() => taskEffectPlanV1Schema.parse(plan([step("commit.merge_base", "merge", 1, { ...payload, expectedHeadSha: "f".repeat(40) })]))).toThrow(/build on the captured commit/);
    expect(() => taskEffectPlanV1Schema.parse(plan([step("commit.merge_base", "merge", 1, payload, { "/baseSha": { step: "x", output: "commitSha" } })]))).toThrow(/written directly/);
    expect(() => taskEffectPlanV1Schema.parse(plan([step("commit.merge_base", "merge", 1, { ...payload, conflictedPaths: ["src/a.ts"] })]))).toThrow(/may not be supplied/);
  });

  it("confines the merge commit to the triggering pull request and the branch patterns", () => {
    expect(() => taskEffectPlanV1Schema.parse(plan([step("commit.merge_base", "merge", 1, { ...payload, pullNumber: 13 })]))).toThrow(/may act only on #12/);
    expect(() => taskEffectPlanV1Schema.parse({ ...plan([step("commit.merge_base", "merge", 1, payload)]), branchPatterns: undefined })).toThrow(/outside this task's branches/);
    expect(() => taskEffectPlanV1Schema.parse(plan([step("commit.merge_base", "merge", 1, { ...payload, branch: "main" })]))).toThrow(/default branch/);
  });

  it("allows at most one merge commit and never with commit.create", () => {
    expect(() => taskEffectPlanV1Schema.parse(plan([
      step("commit.merge_base", "merge", 1, payload),
      step("commit.merge_base", "again", 2, payload),
    ]))).toThrow(/at most one commit.merge_base/);
    expect(() => taskEffectPlanV1Schema.parse(plan([
      step("commit.merge_base", "merge", 1, payload),
      step("commit.create", "commit", 2, { branch: "feature", expectedHeadSha: head, message: "Fix" }),
    ]))).toThrow(/both commit.create and commit.merge_base/);
  });
});
