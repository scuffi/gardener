import { describe, expect, it } from "vitest";
import {
  operationKindValues,
  operationOutputCatalog,
  operationOutputNames,
  operationOutputSentinel,
  operationOutputType,
  operationOutputTypeValues,
  operationProposalPayloadJsonSchema,
  operationSchema,
} from "../src/operations";
import {
  canonicalJsonByteLength,
  captureDeferredPointers,
  captureMaterializedPointers,
  decodeJsonPointer,
  encodeJsonPointer,
  probeOperationShape,
  taskCaptureManifestV1Schema,
  taskCaptureRefV1Schema,
  taskEffectPayloadV1Schema,
  taskEffectPlanV1Schema,
  taskEffectProposalV1Schema,
  taskStepReferencesV1Schema,
  taskEventBindingFromNormalizedEvent,
  taskEventBindingV1Schema,
  taskOutcomeV1Schema,
  taskStepNameV1Schema,
  type NormalizedEventV1,
  type TaskEffectPlanV1,
} from "../src/task";

const sha1 = "a".repeat(40);
const sha256 = "b".repeat(64);
const changesSha256 = "c".repeat(64);

/** Payload for each kind with every plan-owned field removed. */
function payloadFor(kind: typeof operationKindValues[number]): Record<string, unknown> {
  const now = "2026-09-22T10:00:00.000Z";
  const issue = { issueNumber: 2, expectedIssueState: "open", expectedIssueUpdatedAt: now };
  const pull = {
    pullNumber: 3,
    expectedHeadSha: sha1,
    expectedBaseRef: "main",
    expectedBaseSha: sha1,
    expectedState: "open",
    expectedDraft: false,
    expectedPullUpdatedAt: now,
  };
  const discussion = { discussionNumber: 4, expectedDiscussionState: "open", expectedDiscussionUpdatedAt: now };
  switch (kind) {
    case "issue.label.add": case "issue.label.remove": return { ...issue, label: "bug" };
    case "issue.comment.create": return { ...issue, body: "Reproduction steps, please." };
    case "issue.comment.update": return { ...issue, commentId: "44", expectedCommentUpdatedAt: now, body: "Updated" };
    case "issue.close": return { ...issue };
    case "issue.reopen": return { ...issue, expectedIssueState: "closed" };
    case "issue.assignee.add": case "issue.assignee.remove": return { ...issue, assigneeId: "42" };
    case "pull_request.comment.create": return { ...pull, body: "Looks good." };
    case "pull_request.comment.update": return { ...pull, commentId: "44", expectedCommentUpdatedAt: now, body: "Updated" };
    case "pull_request.review.submit": return { ...pull, event: "approve", body: "", comments: [] };
    case "pull_request.reviewer.request": case "pull_request.reviewer.remove": return { ...pull, reviewerIds: ["42"] };
    case "pull_request.update": return { ...pull, title: "New title" };
    case "branch.create": return { branch: "gardener/fix-2", fromSha: sha1, expectedAbsent: true };
    case "commit.create": return {
      branch: "gardener/fix-2",
      expectedHeadSha: sha1,
      message: "Fix issue",
      files: [{ path: "src/a.ts", captured: { status: "modified", mode: "100644", sizeBytes: 5, sha256: "c".repeat(64) } }],
    };
    case "pull_request.open_draft": return {
      head: "gardener/fix-2", base: "main", expectedHeadSha: sha1, expectedBaseSha: sha1,
      title: "Fix", body: "", draft: true,
    };
    case "pull_request.merge": return {
      ...pull, method: "squash", requiredChecks: [{ context: "test", appId: 1 }], expectedBranchProtectionHash: sha256,
    };
    case "discussion.comment.create": return { ...discussion, body: "Thanks." };
    case "discussion.comment.update": return { ...discussion, commentId: "44", expectedCommentUpdatedAt: now, body: "Updated" };
    case "discussion.answer.mark": return { ...discussion, answerCommentId: "44", expectedAnswerCommentId: null };
    case "discussion.answer.unmark": return { ...discussion, expectedAnswerCommentId: "44" };
    case "discussion.close": return { ...discussion };
    case "discussion.reopen": return { ...discussion, expectedDiscussionState: "closed" };
    case "check.rerun": return { checkRunId: "44", expectedHeadSha: sha1, expectedStatus: "completed", expectedConclusion: "failure" };
    case "release.create": return {
      tagName: "v1.0.0", targetCommitSha: sha1, expectedTagAbsent: true, name: "v1", body: "Notes", draft: true, prerelease: false,
    };
    case "release.update": return {
      releaseId: "44", expectedTagName: "v1.0.0", expectedTargetCommitSha: sha1,
      expectedDraft: true, expectedPrerelease: false, expectedReleaseUpdatedAt: now, body: "New notes",
    };
    case "release.publish": return {
      releaseId: "44", expectedTagName: "v1.0.0", expectedTargetCommitSha: sha1, expectedDraft: true,
      expectedPrerelease: false, expectedPublished: false, expectedReleaseUpdatedAt: now,
    };
    case "release.delete": return {
      releaseId: "44", expectedTagName: "v1.0.0", expectedTargetCommitSha: sha1,
      expectedDraft: true, expectedPublished: false, expectedReleaseUpdatedAt: now,
    };
  }
}

/**
 * The payload a task is allowed to propose: the operation payload minus every
 * pointer the trusted capture owns.
 *
 * `payloadFor` stays complete because the probe tests assert against the real
 * `operationSchema`, which does require `/files`. A proposal is a different
 * thing: the model never supplies repository file bytes, so the field is
 * absent there and the apply job fills it from the capture.
 */
function proposablePayloadFor(kind: typeof operationKindValues[number]): Record<string, unknown> {
  const payload = payloadFor(kind);
  for (const pointer of captureDeferredPointers(kind)) {
    const [head] = decodeJsonPointer(pointer);
    if (head !== undefined) delete payload[head];
  }
  return payload;
}

function proposalFor(kind: typeof operationKindValues[number], stepName = "step"): Record<string, unknown> {
  return { stepName, kind, payload: proposablePayloadFor(kind), rationale: `Apply ${kind}.` };
}

function planOperation(
  kind: typeof operationKindValues[number],
  stepName: string,
  order: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    stepName,
    operationId: `run:1:${order}:${stepName}`,
    kind,
    payload: proposablePayloadFor(kind),
    references: {},
    rationale: `Apply ${kind}.`,
    ...overrides,
  };
}

function plan(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    schemaVersion: "gardener.task-effect-plan/v1",
    runId: "run:1",
    taskId: "fixture.triage",
    taskName: "Fixture triage",
    bundleHash: sha256,
    repository: { id: "1374842705", fullName: "scuffi/gardener", defaultBranch: "main" },
    provenance: {
      sourcePath: ".gardener/tasks/fixture.triage/TASK.md",
      commitSha: sha1,
      workflowRunId: "35256179260",
      workflowRunAttempt: 1,
    },
    event: {
      kind: "github.issue.opened",
      eventName: "issues",
      action: "opened",
      resource: { kind: "issue", id: "301", number: 2 },
      commentId: null,
    },
    limits: {},
    operations: [planOperation("issue.comment.create", "comment", 1)],
    ...overrides,
  };
}

describe("scalar operation output catalog", () => {
  it("covers every operation kind and publishes only scalars", () => {
    expect(Object.keys(operationOutputCatalog).sort()).toEqual([...operationKindValues].sort());
    for (const kind of operationKindValues) {
      const outputs = operationOutputCatalog[kind];
      expect(Object.keys(outputs).length).toBeGreaterThan(0);
      for (const [name, type] of Object.entries(outputs)) {
        expect(operationOutputTypeValues).toContain(type);
        expect(["string", "number", "boolean"]).toContain(typeof operationOutputSentinel(type));
        expect(operationOutputType(kind, name)).toBe(type);
      }
    }
  });

  it("excludes the collection outputs a plan can never splice into a typed field", () => {
    expect(operationOutputNames("issue.label.add")).not.toContain("labels");
    expect(operationOutputNames("issue.assignee.add")).not.toContain("assigneeIds");
    expect(operationOutputNames("pull_request.reviewer.request")).not.toContain("reviewerIds");
    expect(operationOutputNames("pull_request.reviewer.request")).not.toContain("reviewerLogins");
    expect(operationOutputType("issue.comment.create", "kind")).toBeUndefined();
    expect(operationOutputType("issue.comment.create", "nonexistent")).toBeUndefined();
  });

  it("produces sentinels that satisfy the validators the outputs feed", () => {
    expect(operationOutputSentinel("commitSha")).toMatch(/^[a-f0-9]{40}$/);
    expect(operationOutputSentinel("githubId")).toMatch(/^[1-9][0-9]{0,19}$/);
    expect(operationOutputSentinel("gardenerBranch")).toMatch(/^gardener\//);
    expect(operationOutputSentinel("gitRef")).toMatch(/^refs\/heads\//);
  });
});

describe("JSON pointers", () => {
  it("round-trips escaped segments", () => {
    expect(decodeJsonPointer("/files/0/path")).toEqual(["files", "0", "path"]);
    expect(decodeJsonPointer("/a~1b/c~0d")).toEqual(["a/b", "c~d"]);
    expect(encodeJsonPointer(["files", 0, "path"])).toBe("/files/0/path");
    expect(encodeJsonPointer(["a/b", "c~d"])).toBe("/a~1b/c~0d");
    expect(encodeJsonPointer([])).toBe("");
  });
});

describe("effect proposals", () => {
  it("renders compact exact payload guidance for every operation kind", () => {
    for (const kind of operationKindValues) {
      const schema = JSON.parse(operationProposalPayloadJsonSchema(kind)) as {
        properties: Record<string, unknown>;
        required: string[];
      };
      expect(Object.keys(schema.properties).length).toBeGreaterThan(0);
      expect(schema.properties).not.toHaveProperty("schemaVersion");
      expect(schema.properties).not.toHaveProperty("id");
      expect(schema.properties).not.toHaveProperty("repository");
      expect(schema.properties).not.toHaveProperty("kind");
      expect(schema.required).not.toContain("schemaVersion");
    }
    const issueComment = JSON.parse(operationProposalPayloadJsonSchema("issue.comment.create")) as {
      properties: Record<string, { type?: string; enum?: string[]; format?: string }>;
    };
    expect(issueComment.properties.issueNumber?.type).toBe("integer");
    expect(issueComment.properties.expectedIssueState?.enum).toEqual(["open", "closed"]);
    expect(issueComment.properties.expectedIssueUpdatedAt?.format).toBe("date-time");

    const pullUpdate = JSON.parse(operationProposalPayloadJsonSchema("pull_request.update")) as {
      properties: Record<string, unknown>;
    };
    expect(pullUpdate.properties).toHaveProperty("title");
    expect(pullUpdate.properties).toHaveProperty("draft");

    const commit = JSON.parse(operationProposalPayloadJsonSchema("commit.create")) as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(commit.properties).not.toHaveProperty("files");
    expect(commit.required).not.toContain("files");
  });

  it("accepts a proposal for every operation kind", () => {
    for (const kind of operationKindValues) {
      expect(taskEffectProposalV1Schema.parse(proposalFor(kind)).kind).toBe(kind);
    }
  });

  it("refuses model-supplied commit contents through the payload", () => {
    // The write boundary: repository file bytes reach GitHub only from the
    // trusted capture the unprivileged job produced. A proposal that carries
    // them would let the model commit content no capture ever proved was in
    // the repository, so it is rejected rather than treated as an inline,
    // capture-free commit.
    expect(() => taskEffectProposalV1Schema.parse({
      ...proposalFor("commit.create"),
      payload: payloadFor("commit.create"),
    })).toThrow(/\/files is materialized from the trusted repository capture/);

    // Including when the bytes are the only thing supplied.
    expect(() => taskEffectProposalV1Schema.parse({
      ...proposalFor("commit.create"),
      payload: { files: [{ path: "src/a.ts", contentBase64: "aGVsbG8=" }] },
    })).toThrow(/may not be supplied by the task/);

    // And when the file entry is empty, so the rejection cannot be mistaken
    // for the nested `contentBase64` format check.
    expect(() => taskEffectProposalV1Schema.parse({
      ...proposalFor("commit.create"),
      payload: { ...proposablePayloadFor("commit.create"), files: [] },
    })).toThrow(/may not be supplied by the task/);
  });

  it("refuses model-supplied commit contents through a step reference", () => {
    // The probe suppresses issues beneath a referenced pointer, so a
    // reference is the one route that could smuggle a value into a
    // capture-owned location without tripping payload validation.
    expect(() => taskEffectProposalV1Schema.parse({
      ...proposalFor("commit.create"),
      references: { "/files": { step: "earlier", output: "commentUrl" } },
    })).toThrow(/may not be referenced/);
    expect(() => taskEffectProposalV1Schema.parse({
      ...proposalFor("commit.create"),
      references: { "/files/0/contentBase64": { step: "earlier", output: "commentUrl" } },
    })).toThrow(/may not be referenced/);
  });

  it("accepts a commit proposal that leaves its contents to the capture", () => {
    const parsed = taskEffectProposalV1Schema.parse(proposalFor("commit.create"));
    expect("files" in parsed.payload).toBe(false);
    expect(parsed.payload).toMatchObject({ branch: "gardener/fix-2", message: "Fix issue" });
  });

  it("defers capture-owned pointers unconditionally", () => {
    // Deferral is a property of the kind, not of what the payload happens to
    // contain. An earlier shape made it conditional on omission, which turned
    // an inlined file set into a legitimate capture-free commit.
    expect(captureDeferredPointers("commit.create")).toEqual(["/files"]);
    expect(captureDeferredPointers("issue.comment.create")).toEqual([]);
    expect(Object.keys(captureMaterializedPointers)).toEqual(["commit.create"]);
  });

  it("never lets the model choose an operation ID", () => {
    expect(() => taskEffectProposalV1Schema.parse({
      ...proposalFor("issue.comment.create"),
      operationId: "run:1:1:comment",
    })).toThrow();
  });

  it("rejects plan-owned fields inside the payload", () => {
    for (const key of ["schemaVersion", "id", "repository", "kind"]) {
      expect(() => taskEffectProposalV1Schema.parse({
        ...proposalFor("issue.comment.create"),
        payload: { ...payloadFor("issue.comment.create"), [key]: "x" },
      })).toThrow(/plan-owned field/);
    }
    expect(() => taskEffectProposalV1Schema.parse({
      ...proposalFor("issue.comment.create"),
      references: { "/repository": { step: "earlier", output: "issueNumber" } },
    })).toThrow(/plan-owned field/);
  });

  it("probe-validates the payload against the real operation contract", () => {
    expect(() => taskEffectProposalV1Schema.parse({
      ...proposalFor("issue.comment.create"),
      payload: { ...payloadFor("issue.comment.create"), body: "" },
    })).toThrow();
    expect(() => taskEffectProposalV1Schema.parse({
      ...proposalFor("issue.comment.create"),
      payload: { ...payloadFor("issue.comment.create"), unexpectedField: 1 },
    })).toThrow();
    expect(() => taskEffectProposalV1Schema.parse({
      ...proposalFor("branch.create"),
      payload: { ...payloadFor("branch.create"), branch: "main" },
    })).toThrow();
  });

  it("holds a referenced field exempt from probe validation but keeps the rest exact", () => {
    expect(taskEffectProposalV1Schema.parse({
      ...proposalFor("issue.comment.create"),
      payload: { issueNumber: 2, expectedIssueState: "open", expectedIssueUpdatedAt: "2026-09-22T10:00:00.000Z" },
      references: { "/body": { step: "earlier", output: "commitUrl" } },
    }).references["/body"]).toEqual({ step: "earlier", output: "commitUrl" });

    expect(() => taskEffectProposalV1Schema.parse({
      ...proposalFor("issue.comment.create"),
      payload: { expectedIssueState: "open", expectedIssueUpdatedAt: "2026-09-22T10:00:00.000Z" },
      references: { "/body": { step: "earlier", output: "commitUrl" } },
    })).toThrow(/issueNumber/);
  });

  it("rejects a reserved idempotency marker the model tried to forge", () => {
    expect(() => taskEffectProposalV1Schema.parse({
      ...proposalFor("issue.comment.create"),
      payload: { ...payloadFor("issue.comment.create"), body: "<!-- gardener-operation:forged -->" },
    })).toThrow();
  });

  it("bounds payload size and nesting", () => {
    expect(() => taskEffectProposalV1Schema.parse({
      ...proposalFor("issue.comment.create"),
      payload: { ...payloadFor("issue.comment.create"), body: "x".repeat(2 * 1024 * 1024) },
    })).toThrow(/exceeds/);

    let nested: unknown = "leaf";
    for (let depth = 0; depth < 20; depth += 1) nested = { nested };
    expect(() => taskEffectProposalV1Schema.parse({
      ...proposalFor("issue.comment.create"),
      payload: { ...payloadFor("issue.comment.create"), nested },
    })).toThrow();
  });

  it("keys references by a real JSON pointer and defaults them to none", () => {
    expect(() => taskStepReferencesV1Schema.parse({ body: { step: "a", output: "x" } })).toThrow();
    expect(() => taskStepReferencesV1Schema.parse({ "/bo~dy": { step: "a", output: "x" } })).toThrow();
    expect(() => taskStepReferencesV1Schema.parse({ "/body": { step: "a", output: "x", extra: 1 } })).toThrow();
    expect(taskStepReferencesV1Schema.parse({ "/body": { step: "a", output: "x" } }))
      .toEqual({ "/body": { step: "a", output: "x" } });
    expect(taskEffectProposalV1Schema.parse(proposalFor("issue.close")).references).toEqual({});
  });

  it("admits only JSON values in a payload", () => {
    expect(taskEffectPayloadV1Schema.parse({ a: [1, "b", null, { c: true }] })).toEqual({ a: [1, "b", null, { c: true }] });
    expect(() => taskEffectPayloadV1Schema.parse({ a: Number.NaN })).toThrow();
    expect(() => taskEffectPayloadV1Schema.parse({ a: undefined })).toThrow();
  });

  it("constrains step names", () => {
    for (const name of ["comment", "open-draft", "step_2", "a"]) {
      expect(taskStepNameV1Schema.parse(name)).toBe(name);
    }
    for (const name of ["Comment", "1step", "-step", "step-", "step--two", "", "s".repeat(64)]) {
      expect(() => taskStepNameV1Schema.parse(name)).toThrow();
    }
  });

  it("drops the legacy composite kinds from the outcome", () => {
    const outcomeBase = {
      schemaVersion: "gardener.task-outcome/v1",
      runId: "run:1",
      taskId: "fixture.triage",
      bundleHash: sha256,
      status: "completed",
      summary: "Triaged.",
      observations: [],
    } as const;
    expect(taskOutcomeV1Schema.parse({ ...outcomeBase, proposedEffects: [] }).status).toBe("completed");
    expect(taskOutcomeV1Schema.parse({
      ...outcomeBase,
      proposedEffects: [proposalFor("issue.label.add", "label"), proposalFor("issue.comment.create", "comment")],
    }).status).toBe("completed");
    for (const legacy of ["issue.labels.update", "repository.draft_pr.create"]) {
      expect(() => taskOutcomeV1Schema.parse({
        ...outcomeBase,
        proposedEffects: [{ operationId: "op-1", kind: legacy, rationale: "legacy", issueNumber: 1, add: [], remove: [] }],
      })).toThrow();
    }
  });
});

describe("probeOperationShape", () => {
  it("reports nothing for a complete payload", () => {
    expect(probeOperationShape({ kind: "issue.close", payload: payloadFor("issue.close") })).toEqual([]);
  });

  it("reports the exact failing pointer", () => {
    const [message] = probeOperationShape({
      kind: "commit.create",
      payload: { ...payloadFor("commit.create"), files: [{ path: "../escape", captured: { status: "deleted" } }] },
    });
    expect(message).toMatch(/^\/files\/0\/path:/);
  });

  it("honours deferred pointers for capture-materialized fields", () => {
    const withoutFiles = { branch: "gardener/fix-2", expectedHeadSha: sha1, message: "Fix issue" };
    expect(probeOperationShape({ kind: "commit.create", payload: withoutFiles })).not.toEqual([]);
    expect(probeOperationShape({ kind: "commit.create", payload: withoutFiles, deferredPointers: ["/files"] })).toEqual([]);
  });

  it("flags a pointer that cannot address a payload location", () => {
    expect(probeOperationShape({
      kind: "issue.comment.create",
      payload: { ...payloadFor("issue.comment.create"), body: "text" },
      references: { "/body/0/deeper": { step: "earlier", output: "commentUrl" } },
    })).toContainEqual(expect.stringMatching(/does not address a payload location/));
  });

  it("keeps the operation schema itself as the single source of truth", () => {
    for (const kind of operationKindValues) {
      expect(probeOperationShape({ kind, payload: payloadFor(kind) })).toEqual([]);
      expect(operationSchema.parse({
        schemaVersion: "v2",
        id: "op:1",
        repository: { provider: "github", id: "1", owner: "scuffi", name: "gardener", defaultBranch: "main" },
        kind,
        ...payloadFor(kind),
      }).kind).toBe(kind);
    }
  });
});

describe("repository change capture", () => {
  const manifest = {
    schemaVersion: "gardener.task-capture-manifest/v1" as const,
    captureId: "run:1:capture:1",
    baseSha: sha1,
    files: [
      { path: "src/a.ts", status: "modified", mode: "100644", sizeBytes: 12, sha256 },
      { path: "src/b.ts", status: "added", mode: "100755", sizeBytes: 8, sha256: changesSha256 },
      { path: "src/c.ts", status: "deleted" },
    ],
    totalBytes: 20,
    truncated: false,
  };

  it("describes each path without carrying file bytes", () => {
    const parsed = taskCaptureManifestV1Schema.parse(manifest);
    expect(parsed.files).toHaveLength(3);
    expect(JSON.stringify(parsed)).not.toContain("contentBase64");
    expect(parsed.files.some((file) => "contentBase64" in file)).toBe(false);
  });

  it("requires mode and digest for written paths and forbids them for deletions", () => {
    expect(() => taskCaptureManifestV1Schema.parse({
      ...manifest,
      files: [{ path: "src/a.ts", status: "modified", sizeBytes: 12, sha256 }],
      totalBytes: 12,
    })).toThrow();
    expect(() => taskCaptureManifestV1Schema.parse({
      ...manifest,
      files: [{ path: "src/c.ts", status: "deleted", mode: "100644", sizeBytes: 0, sha256 }],
      totalBytes: 0,
    })).toThrow();
  });

  it("rejects duplicate paths, mis-summed totals, and truncated captures", () => {
    expect(() => taskCaptureManifestV1Schema.parse({
      ...manifest,
      files: [manifest.files[0], manifest.files[0]],
      totalBytes: 24,
    })).toThrow(/unique/);
    expect(() => taskCaptureManifestV1Schema.parse({ ...manifest, totalBytes: 21 })).toThrow(/totalBytes/);
    expect(() => taskCaptureManifestV1Schema.parse({ ...manifest, truncated: true })).toThrow();
  });

  it("offers a compact ref that binds capture identity and both digests", () => {
    const ref = {
      schemaVersion: "gardener.task-capture-ref/v1" as const,
      captureId: "run:1:capture:1",
      baseSha: sha1,
      manifestSha256: sha256,
      changesSha256,
      fileCount: 3,
      sizeBytes: 20,
    };
    expect(taskCaptureRefV1Schema.parse(ref)).toEqual(ref);
    expect(() => taskCaptureRefV1Schema.parse({ ...ref, fileCount: 0 })).toThrow();
  });
});

describe("event binding", () => {
  function eventBase(kind: string): Record<string, unknown> {
    return {
      schemaVersion: "gardener.normalized-event/v1",
      eventId: "event:1",
      kind,
      occurredAt: "2026-09-22T10:00:00.000Z",
      repository: {
        id: "1374842705", ownerId: "45369682", owner: "scuffi", name: "gardener",
        fullName: "scuffi/gardener", visibility: "private", commitSha: sha1, ref: "refs/heads/main",
      },
      workflow: {
        runId: "35256179260", runAttempt: 1, eventName: "issues",
        workflowRef: "scuffi/gardener/.github/workflows/gardener.yml@refs/heads/main",
        jobWorkflowRef: `scuffi/gardener/.github/workflows/gardener-task.yml@${"c".repeat(40)}`,
        runnerEnvironment: "github-hosted",
      },
      actor: { id: "45369682", login: "scuffi" },
    };
  }

  it("binds the resource an event actually carried", () => {
    const issueEvent = {
      ...eventBase("github.issue.opened"),
      issue: { id: "301", number: 2, title: "Bug", body: null, labels: [], author: { id: "1", login: "a" } },
    } as unknown as NormalizedEventV1;
    expect(taskEventBindingFromNormalizedEvent(issueEvent)).toEqual({
      kind: "github.issue.opened",
      eventName: "issues",
      action: "opened",
      resource: { kind: "issue", id: "301", number: 2 },
      commentId: null,
    });
  });

  it("carries a comment id when the event carried a comment", () => {
    const commentEvent = {
      ...eventBase("github.issue_comment.created"),
      workflow: { ...(eventBase("x").workflow as Record<string, unknown>), eventName: "issue_comment" },
      issue: { id: "301", number: 2, title: "Bug", body: null, labels: [], author: { id: "1", login: "a" } },
      comment: { id: "999", body: "hi", author: { id: "1", login: "a" } },
    } as unknown as NormalizedEventV1;
    const binding = taskEventBindingFromNormalizedEvent(commentEvent);
    expect(binding.eventName).toBe("issue_comment");
    expect(binding.commentId).toBe("999");
  });

  it("binds no resource for repository-level events", () => {
    const pushEvent = {
      ...eventBase("github.push"),
      push: { ref: "refs/heads/main", before: sha1, after: sha1, forced: false, commits: [], includedCommits: 0, commitsTruncated: false },
    } as unknown as NormalizedEventV1;
    expect(taskEventBindingFromNormalizedEvent(pushEvent)).toEqual({
      kind: "github.push", eventName: "push", action: null, resource: null, commentId: null,
    });
  });

  it("refuses a binding whose event name or action contradicts the trigger kind", () => {
    const binding = { kind: "github.issue.opened", eventName: "issues", action: "opened", resource: null, commentId: null };
    expect(taskEventBindingV1Schema.parse(binding)).toEqual(binding);
    expect(() => taskEventBindingV1Schema.parse({ ...binding, eventName: "discussion" })).toThrow(/eventName/);
    expect(() => taskEventBindingV1Schema.parse({ ...binding, action: "edited" })).toThrow(/action/);
    expect(() => taskEventBindingV1Schema.parse({ ...binding, kind: "github.push", eventName: "push" })).toThrow(/action/);
  });
});

describe("ordered effect plan", () => {
  it("accepts an empty plan", () => {
    const empty = plan({ operations: [] }) as unknown as TaskEffectPlanV1;
    expect(taskEffectPlanV1Schema.parse(empty).operations).toEqual([]);
  });

  it("imposes no Gardener ceiling on operation count", () => {
    const many = Array.from({ length: 250 }, (_, index) =>
      planOperation("issue.label.add", `label-${index + 1}`, index + 1));
    expect(taskEffectPlanV1Schema.parse(plan({ operations: many })).operations).toHaveLength(250);
  });

  it("requires unique step names and operation IDs", () => {
    expect(() => taskEffectPlanV1Schema.parse(plan({
      operations: [
        planOperation("issue.comment.create", "comment", 1),
        planOperation("issue.close", "comment", 2),
      ],
    }))).toThrow(/step names must be unique/);
    expect(() => taskEffectPlanV1Schema.parse(plan({
      operations: [
        planOperation("issue.comment.create", "comment", 1),
        planOperation("issue.close", "close", 1, { operationId: "run:1:1:comment" }),
      ],
    }))).toThrow(/operation IDs must be unique/);
  });

  it("resolves a backward reference to a real scalar output", () => {
    const parsed = taskEffectPlanV1Schema.parse(plan({
      operations: [
        planOperation("branch.create", "branch", 1),
        planOperation("issue.comment.create", "comment", 2, {
          payload: {
            issueNumber: 2,
            expectedIssueState: "open",
            expectedIssueUpdatedAt: "2026-09-22T10:00:00.000Z",
          },
          references: { "/body": { step: "branch", output: "branchUrl" } },
        }),
      ],
    }));
    expect(parsed.operations[1]?.references["/body"]).toEqual({ step: "branch", output: "branchUrl" });
  });

  it("rejects self, forward, unknown, and non-published references", () => {
    function withReference(reference: Record<string, string>, target = 1): Record<string, unknown> {
      const operations = [
        planOperation("branch.create", "branch", 1),
        planOperation("issue.comment.create", "comment", 2, {
          payload: { issueNumber: 2, expectedIssueState: "open", expectedIssueUpdatedAt: "2026-09-22T10:00:00.000Z" },
          references: { "/body": reference },
        }),
      ];
      return plan({ operations: target === 1 ? operations : operations.reverse() });
    }
    expect(() => taskEffectPlanV1Schema.parse(withReference({ step: "comment", output: "commentUrl" })))
      .toThrow(/cannot reference its own output/);
    expect(() => taskEffectPlanV1Schema.parse(withReference({ step: "nowhere", output: "commentUrl" })))
      .toThrow(/unknown step/);
    expect(() => taskEffectPlanV1Schema.parse(withReference({ step: "branch", output: "branchUrl" }, 2)))
      .toThrow(/does not run before this step/);
    expect(() => taskEffectPlanV1Schema.parse(withReference({ step: "branch", output: "labels" })))
      .toThrow(/does not publish a scalar output/);
    expect(() => taskEffectPlanV1Schema.parse(withReference({ step: "branch", output: "commentUrl" })))
      .toThrow(/does not publish a scalar output/);
  });

  it("enforces the optional task operation and byte ceilings", () => {
    const three = [
      planOperation("issue.comment.create", "comment", 1),
      planOperation("issue.label.add", "label", 2),
      planOperation("issue.close", "close", 3),
    ];
    expect(taskEffectPlanV1Schema.parse(plan({ operations: three, limits: { maxEffectOperations: 3 } })).operations)
      .toHaveLength(3);
    expect(() => taskEffectPlanV1Schema.parse(plan({ operations: three, limits: { maxEffectOperations: 2 } })))
      .toThrow(/at most 2/);

    const wide = Array.from({ length: 10 }, (_, index) =>
      planOperation("issue.label.add", `label-${index + 1}`, index + 1));
    const bytes = canonicalJsonByteLength(wide) as number;
    expect(bytes).toBeGreaterThan(1_024);
    expect(taskEffectPlanV1Schema.parse(plan({ operations: wide, limits: { maxEffectBytes: bytes } })).operations)
      .toHaveLength(10);
    expect(() => taskEffectPlanV1Schema.parse(plan({ operations: wide, limits: { maxEffectBytes: bytes - 1 } })))
      .toThrow(new RegExp(`serialize to ${bytes} bytes but the task allows at most ${bytes - 1}`));
    expect(() => taskEffectPlanV1Schema.parse(plan({ operations: wide, limits: { maxEffectBytes: 1_024 } })))
      .toThrow(/at most 1024/);
  });

  it("binds a capture manifest to the steps that materialize it", () => {
    const capture = {
      schemaVersion: "gardener.task-capture-manifest/v1",
      captureId: "run:1:capture:1",
      baseSha: sha1,
      files: [{ path: "src/a.ts", status: "modified", mode: "100644", sizeBytes: 12, sha256 }],
      totalBytes: 12,
      truncated: false,
    };
    const materializing = planOperation("commit.create", "commit", 1, {
      payload: { branch: "gardener/fix-2", expectedHeadSha: sha1, message: "Fix issue" },
    });
    const withCapture = plan({ operations: [materializing], capture, changesSha256 });
    expect(taskEffectPlanV1Schema.parse(withCapture).capture?.captureId).toBe("run:1:capture:1");

    expect(() => taskEffectPlanV1Schema.parse({ ...withCapture, capture: undefined, changesSha256: undefined }))
      .toThrow(/carries no capture manifest/);
    expect(() => taskEffectPlanV1Schema.parse({ ...withCapture, changesSha256: undefined }))
      .toThrow(/must be present together/);
    expect(() => taskEffectPlanV1Schema.parse(plan({ capture, changesSha256 })))
      .toThrow(/no step materializes/);
    expect(() => taskEffectPlanV1Schema.parse({
      ...withCapture,
      capture: { ...capture, baseSha: "d".repeat(40) },
    })).toThrow(/capture base must equal the planning commit/);
  });

  it("refuses a planned commit that carries its own contents", () => {
    // Same rule one layer up. A plan is what the privileged job executes, so
    // if the bytes could arrive here the proposal-layer check would only be
    // a suggestion.
    const capture = {
      schemaVersion: "gardener.task-capture-manifest/v1",
      captureId: "run:1:capture:1",
      baseSha: sha1,
      files: [{ path: "src/a.ts", status: "modified", mode: "100644", sizeBytes: 12, sha256 }],
      totalBytes: 12,
      truncated: false,
    };
    const inlined = planOperation("commit.create", "commit", 1, { payload: payloadFor("commit.create") });
    expect(() => taskEffectPlanV1Schema.parse(plan({ operations: [inlined], capture, changesSha256 })))
      .toThrow(/may not be supplied by the task/);
    expect(() => taskEffectPlanV1Schema.parse(plan({
      operations: [planOperation("commit.create", "commit", 1, {
        references: { "/files": { step: "earlier", output: "commentUrl" } },
      })],
      capture,
      changesSha256,
    }))).toThrow(/may not be referenced/);
  });

  it("requires a capture for every planned commit", () => {
    // Unconditional deferral means a commit with no capture behind it can
    // never be planned, whatever its payload looks like.
    expect(() => taskEffectPlanV1Schema.parse(plan({
      operations: [planOperation("commit.create", "commit", 1)],
    }))).toThrow(/carries no capture manifest/);
  });

  it("still probe-validates each planned payload", () => {
    expect(() => taskEffectPlanV1Schema.parse(plan({
      operations: [planOperation("issue.comment.create", "comment", 1, {
        payload: { ...payloadFor("issue.comment.create"), body: "" },
      })],
    }))).toThrow();
  });
});
