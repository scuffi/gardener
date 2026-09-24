import { describe, expect, it } from "vitest";
import { COMMIT_FILE_LIMIT, operationOutputRenderedMaxLength } from "../src/operations";
import {
  CAPTURE_FILE_MAX_BYTES,
  CAPTURE_TOTAL_MAX_BYTES,
  EFFECT_TRANSPORT_MAX_BYTES,
  canonicalJsonByteLength,
  isPrototypePollutingKey,
  isProtectedCapturePath,
  probeOperationShape,
  prototypePollutingKeys,
  protectedCapturePathPrefixes,
  protectedCapturePaths,
  taskCaptureManifestV1Schema,
  taskCaptureRefV1Schema,
  taskEffectPayloadV1Schema,
  taskEffectPlanV1Schema,
  taskEffectProposalV1Schema,
  taskPayloadPointerV1Schema,
  renderPlaceholders,
  taskStepReferencesV1Schema,
} from "../src/task";

const sha1 = "a".repeat(40);
const sha256 = "b".repeat(64);
const now = "2026-09-22T10:00:00.000Z";

function commentPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { issueNumber: 2, expectedIssueState: "open", expectedIssueUpdatedAt: now, body: "text", ...overrides };
}

function proposal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { stepName: "comment", kind: "issue.comment.create", payload: commentPayload(), rationale: "r", ...overrides };
}

function planOperation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    stepName: "comment",
    operationId: "run:1:1:comment",
    kind: "issue.comment.create",
    payload: commentPayload(),
    references: {},
    rationale: "r",
    ...overrides,
  };
}

function plan(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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
    event: { kind: "github.issue.opened", eventName: "issues", action: "opened", resource: null, commentId: null },
    limits: {},
    operations: [planOperation()],
    ...overrides,
  };
}

/** Sentinel names used to prove `Object.prototype` was never written. */
const witnesses = ["gardenerPollutionWitness", "pwned", "polluted"] as const;

function prototypeIsClean(): boolean {
  const probe = {} as Record<string, unknown>;
  return witnesses.every((name) => probe[name] === undefined)
    && (Object.prototype as unknown as Record<string, unknown>).gardenerPollutionWitness === undefined;
}

describe("prototype-pollution resistance", () => {
  it("names every key that can reach the prototype chain", () => {
    expect([...prototypePollutingKeys]).toEqual(["__proto__", "constructor", "prototype"]);
    for (const key of prototypePollutingKeys) expect(isPrototypePollutingKey(key)).toBe(true);
    expect(isPrototypePollutingKey("body")).toBe(false);
  });

  it("rejects a polluting segment in every pointer position", () => {
    for (const key of prototypePollutingKeys) {
      expect(() => taskPayloadPointerV1Schema.parse(`/${key}`)).toThrow(/not addressable/);
      expect(() => taskPayloadPointerV1Schema.parse(`/${key}/x`)).toThrow(/not addressable/);
      expect(() => taskPayloadPointerV1Schema.parse(`/files/0/${key}`)).toThrow(/not addressable/);
      expect(() => taskStepReferencesV1Schema.parse({ [`/${key}/x`]: { step: "a", output: "commentUrl" } })).toThrow();
    }
    expect(taskPayloadPointerV1Schema.parse("/files/0/path")).toBe("/files/0/path");
  });

  it("rejects an own polluting key rather than dropping it", () => {
    for (const key of prototypePollutingKeys) {
      const payload = JSON.parse(`{"body":"x","${key}":{"gardenerPollutionWitness":1}}`);
      const parsed = taskEffectPayloadV1Schema.safeParse(payload);
      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues.map((issue) => issue.message).join(" "))
        .toContain(`may not contain the key "${key}"`);
    }
    // Nested, not just at the root.
    const nested = JSON.parse('{"body":"x","meta":{"deep":{"__proto__":{"gardenerPollutionWitness":1}}}}');
    expect(taskEffectPayloadV1Schema.safeParse(nested).success).toBe(false);
    expect(prototypeIsClean()).toBe(true);
  });

  it("never writes through a pointer into Object.prototype", () => {
    for (const key of prototypePollutingKeys) {
      const messages = probeOperationShape({
        kind: "issue.comment.create",
        payload: commentPayload(),
        references: { [`/${key}/gardenerPollutionWitness`]: { step: "a", output: "commentUrl" } },
      });
      expect(messages).toContainEqual(expect.stringMatching(/does not address a payload location/));
    }
    expect(probeOperationShape({
      kind: "issue.comment.create",
      payload: commentPayload(),
      references: { "/constructor/prototype/pwned": { step: "a", output: "commentUrl" } },
    })).toContainEqual(expect.stringMatching(/does not address a payload location/));
    expect(prototypeIsClean()).toBe(true);
  });

  it("leaves later unrelated parses working after an adversarial attempt", () => {
    // The real damage of pollution is not the first parse: it is that Zod's own
    // internals start failing afterwards, turning every later run into a crash.
    for (const key of prototypePollutingKeys) {
      taskEffectPayloadV1Schema.safeParse(JSON.parse(`{"${key}":{"gardenerPollutionWitness":1}}`));
      probeOperationShape({
        kind: "issue.comment.create",
        payload: commentPayload(),
        references: { [`/${key}/gardenerPollutionWitness`]: { step: "a", output: "commentUrl" } },
      });
    }
    expect(prototypeIsClean()).toBe(true);
    expect(taskEffectProposalV1Schema.parse(proposal()).stepName).toBe("comment");
    expect(taskEffectPlanV1Schema.parse(plan()).operations).toHaveLength(1);
    expect(probeOperationShape({ kind: "issue.comment.create", payload: commentPayload() })).toEqual([]);
  });

  it("carries the rejection through the proposal and plan schemas", () => {
    const hostile = JSON.parse('{"body":"x","__proto__":{"gardenerPollutionWitness":1}}');
    expect(taskEffectProposalV1Schema.safeParse({ ...proposal(), payload: hostile }).success).toBe(false);
    expect(taskEffectPlanV1Schema.safeParse(plan({ operations: [planOperation({ payload: hostile })] })).success).toBe(false);
    expect(prototypeIsClean()).toBe(true);
  });
});

describe("structural pre-validation", () => {
  it("fails a deeply nested payload instead of overflowing the stack", () => {
    let nested: unknown = "leaf";
    for (let depth = 0; depth < 60_000; depth += 1) nested = { n: nested };
    const parsed = taskEffectPayloadV1Schema.safeParse({ body: nested });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain("nests deeper than");
  });

  it("rejects a payload just past the depth limit and accepts one at it", () => {
    function chain(levels: number): unknown {
      let value: unknown = "leaf";
      for (let depth = 0; depth < levels; depth += 1) value = { n: value };
      return value;
    }
    // The payload object itself is depth 1, so `chain(11)` reaches depth 12.
    expect(taskEffectPayloadV1Schema.safeParse({ body: chain(10) }).success).toBe(true);
    expect(taskEffectPayloadV1Schema.safeParse({ body: chain(12) }).success).toBe(false);
  });

  it("rejects cycles, non-finite numbers, and values JSON cannot represent", () => {
    const cyclic: Record<string, unknown> = { body: "x" };
    cyclic.self = cyclic;
    expect(JSON.stringify(taskEffectPayloadV1Schema.safeParse(cyclic).error?.issues)).toContain("circular reference");
    expect(JSON.stringify(taskEffectPayloadV1Schema.safeParse({ a: Number.NaN }).error?.issues)).toContain("non-finite");
    expect(JSON.stringify(taskEffectPayloadV1Schema.safeParse({ a: Number.POSITIVE_INFINITY }).error?.issues)).toContain("non-finite");
    expect(taskEffectPayloadV1Schema.safeParse({ a: () => 1 }).success).toBe(false);
    expect(taskEffectPayloadV1Schema.safeParse({ a: 1n }).success).toBe(false);
    expect(taskEffectPayloadV1Schema.safeParse({ [Symbol("s")]: 1 }).success).toBe(false);
    expect(taskEffectPayloadV1Schema.safeParse([1, 2]).success).toBe(false);
    expect(taskEffectPayloadV1Schema.safeParse("text").success).toBe(false);
  });

  it("reports rather than throws when a value cannot be serialized", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(canonicalJsonByteLength(cyclic)).toBeNull();
    expect(canonicalJsonByteLength(undefined)).toBeNull();
    expect(canonicalJsonByteLength({ a: 1 })).toBe(7);

    // `JSON.stringify` survives depths that overflow a recursive schema, so the
    // depth gate — not the serializer — is what has to catch deep values.
    let nested: unknown = "leaf";
    for (let depth = 0; depth < 60_000; depth += 1) nested = { n: nested };
    expect(() => canonicalJsonByteLength(nested)).not.toThrow();
  });

  it("never throws out of probeOperationShape", () => {
    let nested: unknown = "leaf";
    for (let depth = 0; depth < 60_000; depth += 1) nested = { n: nested };
    expect(() => probeOperationShape({ kind: "issue.comment.create", payload: { body: nested } })).not.toThrow();
  });
});

describe("pointer array bounds", () => {
  function commitPayload(): Record<string, unknown> {
    return { branch: "gardener/fix", expectedHeadSha: sha1, message: "Fix", files: [] };
  }

  /**
   * A reference pointer is model-authored text. Before this bound a large
   * index made the probe materialize a sparse array that the operation schema
   * then walked: `/files/1000000` produced 1,000,001 issues and
   * `/files/999999999` exhausted the heap from inside `safeParse`.
   */
  it("refuses an array index no operation payload could hold, quickly and without exhausting memory", () => {
    for (const index of ["1000000", "999999999", "9007199254740991"]) {
      const started = Date.now();
      const parsed = taskEffectProposalV1Schema.safeParse(proposal({
        stepName: "commit",
        kind: "commit.create",
        payload: commitPayload(),
        references: { [`/files/${index}`]: { step: "earlier", output: "commitSha" } },
      }));
      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues.length).toBeLessThanOrEqual(8);
      expect(parsed.error?.issues.map((issue) => issue.message).join(" "))
        .toContain("does not address a payload location");
      expect(Date.now() - started).toBeLessThan(1_000);
    }
  });

  it("still addresses the indices a real payload uses", () => {
    for (const index of ["0", "1", "99"]) {
      expect(probeOperationShape({
        kind: "commit.create",
        payload: commitPayload(),
        references: { [`/files/${index}/path`]: { step: "earlier", output: "commitSha" } },
      })).not.toContainEqual(expect.stringMatching(/does not address a payload location/));
    }
    // One past the largest array any operation schema accepts.
    expect(probeOperationShape({
      kind: "commit.create",
      payload: commitPayload(),
      references: { "/files/100/path": { step: "earlier", output: "commitSha" } },
    })).toContainEqual(expect.stringMatching(/does not address a payload location/));
  });

  it("refuses a non-canonical numeric segment rather than coercing it", () => {
    for (const index of ["01", "1e3", "-1", "1.0", " 1"]) {
      expect(probeOperationShape({
        kind: "commit.create",
        payload: commitPayload(),
        references: { [`/files/${index}`]: { step: "earlier", output: "commitSha" } },
      })).toContainEqual(expect.stringMatching(/does not address a payload location/));
    }
  });

  it("caps how many problems one step reports", () => {
    const manyWrong = Array.from({ length: 500 }, () => 42);
    const messages = probeOperationShape({
      kind: "pull_request.review.submit",
      payload: {
        pullNumber: 3,
        expectedHeadSha: sha1,
        expectedBaseRef: "main",
        expectedBaseSha: sha1,
        expectedState: "open",
        expectedDraft: false,
        expectedPullUpdatedAt: now,
        event: "comment",
        body: "look",
        comments: manyWrong,
      },
    });
    expect(messages.length).toBeLessThanOrEqual(33);
    expect(messages).toContainEqual(expect.stringMatching(/further problems were not reported/));
  });
});

describe("transport ceiling", () => {
  it("states one shared decoded-byte ceiling", () => {
    // Mirrored by EFFECT_TRANSPORT_MAX_BYTES in @gardener/protocol, which
    // asserts the identical literal in its own suite.
    expect(EFFECT_TRANSPORT_MAX_BYTES).toBe(4 * 1_024 * 1_024);
  });

  it("bounds the whole canonical plan unconditionally, with no operation-count cap", () => {
    const filler = "x".repeat(60_000);
    const many = Array.from({ length: 90 }, (_, index) => planOperation({
      stepName: `comment-${index + 1}`,
      operationId: `run:1:${index + 1}:comment`,
      payload: commentPayload({ body: filler }),
    }));
    // No `maxEffectBytes` is declared: the ceiling still applies.
    const oversized = plan({ operations: many });
    expect(canonicalJsonByteLength(oversized)).toBeGreaterThan(EFFECT_TRANSPORT_MAX_BYTES);
    expect(() => taskEffectPlanV1Schema.parse(oversized))
      .toThrow(new RegExp(`but the effect artifact carries at most ${EFFECT_TRANSPORT_MAX_BYTES}`));

    // A large plan that fits is still accepted, and count alone never rejects.
    const wide = Array.from({ length: 400 }, (_, index) => planOperation({
      stepName: `comment-${index + 1}`,
      operationId: `run:1:${index + 1}:comment`,
    }));
    expect(taskEffectPlanV1Schema.parse(plan({ operations: wide })).operations).toHaveLength(400);
  });
});

describe("protected capture paths", () => {
  function manifest(paths: readonly string[]): Record<string, unknown> {
    return {
      schemaVersion: "gardener.task-capture-manifest/v1",
      captureId: "run:1:capture:1",
      baseSha: sha1,
      files: paths.map((path) => ({ path, status: "modified", mode: "100644", sizeBytes: 4, sha256 })),
      totalBytes: 4 * paths.length,
      truncated: false,
    };
  }

  it("names the prefixes that would rewrite Gardener's own authority", () => {
    expect([...protectedCapturePathPrefixes]).toEqual([".git/", ".github/workflows/", ".github/actions/", ".gardener/"]);
    expect(isProtectedCapturePath(".github/workflows/gardener-task.yml")).toBe(true);
    expect(isProtectedCapturePath(".gardener/tasks/x/TASK.md")).toBe(true);
    expect(isProtectedCapturePath(".gardener")).toBe(true);
    expect(isProtectedCapturePath("src/a.ts")).toBe(false);
  });

  it("refuses CODEOWNERS at each location GitHub resolves it from", () => {
    expect(protectedCapturePaths).toEqual(expect.arrayContaining(["CODEOWNERS", ".github/CODEOWNERS", "docs/CODEOWNERS"]));
    for (const path of protectedCapturePaths) {
      expect(isProtectedCapturePath(path)).toBe(true);
      expect(() => taskCaptureManifestV1Schema.parse(manifest([path]))).toThrow(/may not write the protected path/);
    }
    // A path that merely contains the name is not the owners file.
    expect(isProtectedCapturePath("src/CODEOWNERS.md")).toBe(false);
    expect(isProtectedCapturePath("docs/team/CODEOWNERS")).toBe(false);
  });

  it("matches protected paths case-insensitively, as a checkout would resolve them", () => {
    for (const path of [
      ".GitHub/Workflows/ci.yml",
      ".GITHUB/WORKFLOWS/ci.yml",
      ".GitHub/Actions/a/action.yml",
      ".Gardener/gardener.json",
      ".GIT/config",
      "codeowners",
      ".github/Codeowners",
      "DOCS/CODEOWNERS",
    ]) {
      expect(isProtectedCapturePath(path)).toBe(true);
      expect(() => taskCaptureManifestV1Schema.parse(manifest([path]))).toThrow(/may not write the protected path/);
    }
    expect(isProtectedCapturePath("src/Github/workflows.ts")).toBe(false);
  });

  it("rejects a protected path in the manifest, where the full path set is known", () => {
    expect(taskCaptureManifestV1Schema.parse(manifest(["src/a.ts"])).files).toHaveLength(1);
    for (const path of [".github/workflows/x.yml", ".github/actions/a/action.yml", ".gardener/gardener.json", ".git/config"]) {
      expect(() => taskCaptureManifestV1Schema.parse(manifest([path])))
        .toThrow(/may not write the protected path/);
    }
  });

  it("blocks a materialized commit from writing a protected path through the plan", () => {
    const capture = manifest([".github/workflows/gardener-task.yml"]);
    const materializing = planOperation({
      stepName: "commit",
      operationId: "run:1:1:commit",
      kind: "commit.create",
      payload: { branch: "gardener/fix", expectedHeadSha: sha1, message: "Fix" },
    });
    expect(() => taskEffectPlanV1Schema.parse(plan({
      operations: [materializing],
      capture,
      changesSha256: "d".repeat(64),
    }))).toThrow(/may not write the protected path/);

    // The same plan with an ordinary path is accepted, so the rule is the path,
    // not materialization itself.
    expect(taskEffectPlanV1Schema.parse(plan({
      operations: [materializing],
      capture: manifest(["src/a.ts"]),
      changesSha256: "d".repeat(64),
    })).capture?.files).toHaveLength(1);
  });

  it("bounds file count by what one commit.create can write, so every capture is materializable", () => {
    const paths = (count: number) => Array.from({ length: count }, (_, index) => `src/file-${index}.ts`);
    expect(taskCaptureManifestV1Schema.parse(manifest(paths(COMMIT_FILE_LIMIT))).files).toHaveLength(COMMIT_FILE_LIMIT);
    expect(() => taskCaptureManifestV1Schema.parse(manifest(paths(COMMIT_FILE_LIMIT + 1)))).toThrow();
  });
});

describe("capture byte ceilings", () => {
  function manifestOf(sizes: readonly number[]): Record<string, unknown> {
    return {
      schemaVersion: "gardener.task-capture-manifest/v1",
      captureId: "run:1:capture:1",
      baseSha: sha1,
      files: sizes.map((sizeBytes, index) => ({
        path: `src/file-${index}.bin`,
        status: "modified",
        mode: "100644",
        sizeBytes,
        sha256,
      })),
      totalBytes: sizes.reduce((total, size) => total + size, 0),
      truncated: false,
    };
  }

  function captureRef(sizeBytes: number): Record<string, unknown> {
    return {
      schemaVersion: "gardener.task-capture-ref/v1",
      captureId: "run:1:capture:1",
      baseSha: sha1,
      manifestSha256: sha256,
      changesSha256: "d".repeat(64),
      fileCount: 1,
      sizeBytes,
    };
  }

  it("bounds one file by what the provider accepts as a single blob", () => {
    // GitHub refuses a blob or pushed file larger than 100 MiB, so a capture
    // describing one could never be applied.
    expect(CAPTURE_FILE_MAX_BYTES).toBe(100 * 1_024 * 1_024);
    expect(taskCaptureManifestV1Schema.parse(manifestOf([CAPTURE_FILE_MAX_BYTES])).totalBytes)
      .toBe(CAPTURE_FILE_MAX_BYTES);
    expect(() => taskCaptureManifestV1Schema.parse(manifestOf([CAPTURE_FILE_MAX_BYTES + 1]))).toThrow();
    // The previously-accepted 900 MB single file is now refused at plan time.
    expect(taskCaptureManifestV1Schema.safeParse(manifestOf([900_000_000])).success).toBe(false);
  });

  it("bounds the aggregate by the largest capture a commit could materialize", () => {
    // Derived from the provider: 100 tree entries per commit.create, each at
    // most one maximum blob.
    expect(CAPTURE_TOTAL_MAX_BYTES).toBe(100 * CAPTURE_FILE_MAX_BYTES);
    const atCeiling = manifestOf(Array.from({ length: 100 }, () => CAPTURE_FILE_MAX_BYTES));
    expect(taskCaptureManifestV1Schema.parse(atCeiling).totalBytes).toBe(CAPTURE_TOTAL_MAX_BYTES);
    const overCeiling = manifestOf(Array.from({ length: 101 }, () => CAPTURE_FILE_MAX_BYTES));
    expect(taskCaptureManifestV1Schema.safeParse(overCeiling).success).toBe(false);
    expect(taskCaptureManifestV1Schema.safeParse({
      ...manifestOf([4]),
      totalBytes: Number.MAX_SAFE_INTEGER,
    }).success).toBe(false);
  });

  it("holds the ref to the same aggregate ceiling as the manifest", () => {
    expect(taskCaptureRefV1Schema.parse(captureRef(CAPTURE_TOTAL_MAX_BYTES)).sizeBytes).toBe(CAPTURE_TOTAL_MAX_BYTES);
    expect(taskCaptureRefV1Schema.safeParse(captureRef(CAPTURE_TOTAL_MAX_BYTES + 1)).success).toBe(false);
    expect(taskCaptureRefV1Schema.safeParse(captureRef(Number.MAX_SAFE_INTEGER)).success).toBe(false);
  });
});

describe("placeholders in written text", () => {
  function draftOperation(): Record<string, unknown> {
    return planOperation({
      stepName: "open-pr",
      operationId: "run:1:1:open-pr",
      kind: "pull_request.open_draft",
      payload: { head: "gardener/fix-1", base: "main", expectedHeadSha: sha1, expectedBaseSha: sha1, title: "Fix", body: "Fix.", draft: true },
    });
  }
  function linkOperation(body: unknown, placeholders: Record<string, unknown>): Record<string, unknown> {
    return planOperation({
      stepName: "link",
      operationId: "run:1:2:link",
      payload: commentPayload({ body }),
      references: { "/body": { placeholders } },
    });
  }
  const pr = { step: "open-pr", output: "pullUrl" };

  it("accepts text that uses each declared placeholder", () => {
    expect(taskEffectPlanV1Schema.safeParse(plan({ operations: [draftOperation(), linkOperation("Fix: {{pr}}", { pr })] })).success).toBe(true);
  });

  it("refuses a declared placeholder the text does not use", () => {
    const parsed = taskEffectPlanV1Schema.safeParse(plan({ operations: [draftOperation(), linkOperation("Fix: see the PR", { pr })] }));
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.some((issue) => issue.message.includes("does not contain {{pr}}"))).toBe(true);
  });

  it("refuses placeholders without written text to fill", () => {
    const parsed = taskEffectPlanV1Schema.safeParse(plan({
      operations: [draftOperation(), planOperation({
        stepName: "link",
        operationId: "run:1:2:link",
        payload: { issueNumber: 2, expectedIssueState: "open", expectedIssueUpdatedAt: now },
        references: { "/body": { placeholders: { pr } } },
      })],
    }));
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.some((issue) => issue.message.includes("must be text written in the payload"))).toBe(true);
  });

  it("checks the field's limits with each placeholder at its longest", () => {
    // 65,536 is the comment body limit; a URL may render up to 1,024 characters.
    const nearLimit = `${"a".repeat(65_536 - 1_024 - 10)}{{pr}}`;
    const overLimit = `${"a".repeat(65_536 - 1_000)}{{pr}}`;
    expect(taskEffectPlanV1Schema.safeParse(plan({ operations: [draftOperation(), linkOperation(nearLimit, { pr })] })).success).toBe(true);
    expect(taskEffectPlanV1Schema.safeParse(plan({ operations: [draftOperation(), linkOperation(overLimit, { pr })] })).success).toBe(false);
  });

  it("refuses an unpublished output, a later step, and a nullable output in a placeholder", () => {
    const unpublished = taskEffectPlanV1Schema.safeParse(plan({
      operations: [draftOperation(), linkOperation("{{pr}}", { pr: { step: "open-pr", output: "pullRequestUrl" } })],
    }));
    expect(unpublished.error?.issues.some((issue) => issue.message.includes('it publishes') && issue.message.includes('"pullUrl"'))).toBe(true);
    const later = taskEffectPlanV1Schema.safeParse(plan({ operations: [linkOperation("{{pr}}", { pr }), draftOperation()] }));
    expect(later.error?.issues.some((issue) => issue.message.includes("does not run before this step"))).toBe(true);
    const nullable = taskEffectPlanV1Schema.safeParse(plan({
      operations: [
        planOperation({
          stepName: "unmark",
          operationId: "run:1:1:unmark",
          kind: "discussion.answer.unmark",
          payload: { discussionNumber: 3, expectedDiscussionState: "open", expectedDiscussionUpdatedAt: now, commentNodeId: "DC_abc", expectedAnswerCommentId: "5" },
        }),
        linkOperation("{{answer}}", { answer: { step: "unmark", output: "answerCommentId" } }),
      ],
    }));
    expect(nullable.error?.issues.some((issue) => issue.message.includes("may be null"))).toBe(true);
  });

  it("bounds placeholder names and counts", () => {
    expect(taskStepReferencesV1Schema.safeParse({ "/body": { placeholders: {} } }).success).toBe(false);
    expect(taskStepReferencesV1Schema.safeParse({ "/body": { placeholders: { "Bad-Name": pr } } }).success).toBe(false);
    const nine = Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`p${index}`, pr]));
    expect(taskStepReferencesV1Schema.safeParse({ "/body": { placeholders: nine } }).success).toBe(false);
    expect(taskStepReferencesV1Schema.safeParse({ "/body": { placeholders: pr, step: "x" } }).success).toBe(false);
  });

  it("refuses a reference nested inside another reference", () => {
    const parsed = taskStepReferencesV1Schema.safeParse({
      "/comments/0": { step: "a", output: "commentUrl" },
      "/comments/0/body": { placeholders: { u: { step: "a", output: "commentUrl" } } },
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toContain("is inside reference /comments/0");
    expect(taskStepReferencesV1Schema.safeParse({
      "/comments/0/body": { step: "a", output: "commentUrl" },
      "/comments/01": { step: "a", output: "commentUrl" },
    }).success).toBe(true);
  });

  it("refuses a whole-field reference where an object or array is required", () => {
    const review = (references: Record<string, unknown>) => taskEffectPlanV1Schema.safeParse(plan({
      operations: [planOperation(), planOperation({
        stepName: "review",
        operationId: "run:1:2:review",
        kind: "pull_request.review.submit",
        payload: {
          pullNumber: 8, expectedHeadSha: sha1, expectedBaseRef: "main", expectedBaseSha: sha1, expectedState: "open",
          expectedDraft: false, expectedPullUpdatedAt: now, event: "comment", body: "Review.",
          comments: [{ path: "src/a.ts", line: 1, side: "RIGHT", body: "Here." }],
        },
        references,
      })],
    }));
    const structural = review({ "/comments/0": { step: "comment", output: "commentUrl" } });
    expect(structural.success).toBe(false);
    expect(structural.error?.issues.some((issue) => issue.message.includes("/comments/0: "))).toBe(true);
    // A scalar field under the same array is still fine to fill.
    expect(review({ "/comments/0/body": { step: "comment", output: "commentUrl" } }).success).toBe(true);
  });

  it("renders a string output at least as long as the longest string it can carry", () => {
    // pull_request.update publishes the pull request's title, which may be 256 characters.
    expect(operationOutputRenderedMaxLength("string")).toBeGreaterThanOrEqual(256);
  });

  it("renders in one pass and leaves undeclared braces alone", () => {
    expect(renderPlaceholders("{{a}} {{b}} {{a}} {{ c }}", new Map([["a", "{{b}}"], ["b", "2"]]))).toBe("{{b}} 2 {{b}} {{ c }}");
  });
});
