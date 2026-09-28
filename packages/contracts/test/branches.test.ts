import { describe, expect, it } from "vitest";
import {
  DEFAULT_WRITE_BRANCHES,
  branchAllowed,
  branchPatternMatches,
  branchPatternsSchema,
  commitBaseRefusal,
  isValidBranchPattern,
} from "../src/branches";
import { bundleBranchPatterns, taskBundleV1Schema, taskEffectPlanV1Schema } from "../src/task";

const base = "a".repeat(40);
const other = "c".repeat(40);
const sha256 = "b".repeat(64);

describe("branch patterns", () => {
  it("accepts branch names with * inside a segment or ** as a whole segment", () => {
    for (const pattern of ["gardener/**", "**", "docs/*", "release/v*", "feature/**/wip", "main"]) {
      expect(isValidBranchPattern(pattern), pattern).toBe(true);
    }
    for (const pattern of ["", "docs/**x", "a***", "/docs", "docs/", "bad..name", "a b", "x/.hidden"]) {
      expect(isValidBranchPattern(pattern), pattern).toBe(false);
    }
    expect(() => branchPatternsSchema.parse([])).toThrow();
    expect(() => branchPatternsSchema.parse(["docs/*", "docs/*"])).toThrow(/unique/);
  });

  it("matches * within one segment and ** across one or more", () => {
    expect(branchPatternMatches("gardener/**", "gardener/fix")).toBe(true);
    expect(branchPatternMatches("gardener/**", "gardener/a/b")).toBe(true);
    expect(branchPatternMatches("gardener/**", "gardener")).toBe(false);
    expect(branchPatternMatches("docs/*", "docs/usage")).toBe(true);
    expect(branchPatternMatches("docs/*", "docs/a/b")).toBe(false);
    expect(branchPatternMatches("release/v*", "release/v1.2")).toBe(true);
    expect(branchPatternMatches("release/v*", "release/x1")).toBe(false);
    expect(branchPatternMatches("feature/**/wip", "feature/a/b/wip")).toBe(true);
    expect(branchPatternMatches("feature/**/wip", "feature/wip")).toBe(false);
    expect(branchPatternMatches("fix-🌱", "fix-🌱")).toBe(true);
    expect(branchPatternMatches("fix-*-🌱", "fix-a-🌱")).toBe(true);
    // Dots are literal, not regular-expression wildcards.
    expect(branchPatternMatches("v1.0", "v1x0")).toBe(false);
  });

  it("stays fast on patterns and branches built to backtrack", () => {
    const pattern = `${"**/".repeat(40)}zzz`;
    const branch = Array.from({ length: 60 }, () => "a").join("/");
    expect(isValidBranchPattern(pattern)).toBe(true);
    const started = performance.now();
    expect(branchPatternMatches(pattern, branch)).toBe(false);
    expect(branchPatternMatches(`${"a*".repeat(100)}b`, "a".repeat(250))).toBe(false);
    expect(performance.now() - started).toBeLessThan(200);
    expect(branchPatternMatches(`${"**/".repeat(3)}zzz`, "a/b/c/zzz")).toBe(true);
    expect(branchPatternMatches("a*b*c", "axxbyyc")).toBe(true);
  });

  it("never lets a wildcard reach the default branch", () => {
    expect(branchAllowed("main", ["**"], "main")).toBe(false);
    expect(branchAllowed("main", ["*"], "main")).toBe(false);
    expect(branchAllowed("main", ["**", "main"], "main")).toBe(true);
    expect(branchAllowed("docs/usage", ["**"], "main")).toBe(true);
    // A default branch inside a namespace is still guarded.
    expect(branchAllowed("gardener/main", DEFAULT_WRITE_BRANCHES, "gardener/main")).toBe(false);
    expect(branchAllowed("bad..name", ["**"], "main")).toBe(false);
  });
});

function bundle(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "gardener.task-bundle/v1",
    taskId: "fix",
    name: "Fix",
    description: "Fixes.",
    instructions: "Fix it.",
    triggers: [{ kind: "github.workflow_dispatch" }],
    tools: [],
    effects: ["branch.create", "commit.create", "pull_request.open"],
    network: { default: "deny", allow: [], deny: [] },
    limits: { runtimeSeconds: 120, maxTurns: 4, maxToolCalls: 8, inputTokens: 10_000, outputTokens: 4_000 },
    model: "@cf/zai-org/glm-5.3",
    ...overrides,
  };
}

describe("effect options in the bundle", () => {
  it("carries branch patterns for declared branch-writing kinds only", () => {
    const parsed = taskBundleV1Schema.parse(bundle({ effectOptions: { "commit.create": { branches: ["docs/*"] } } }));
    expect(bundleBranchPatterns(parsed)).toEqual({ "commit.create": ["docs/*"] });
    expect(bundleBranchPatterns(taskBundleV1Schema.parse(bundle()))).toBeUndefined();
    expect(() => taskBundleV1Schema.parse(bundle({ effectOptions: { "pull_request.open_draft": { branches: ["docs/*"] } } })))
      .toThrow(/does not declare/);
    expect(() => taskBundleV1Schema.parse(bundle({ effectOptions: { "issue.create": { branches: ["docs/*"] } } }))).toThrow();
    expect(() => taskBundleV1Schema.parse(bundle({ effectOptions: {} }))).toThrow(/omitted/);
  });
});

function operation(stepName: string, kind: string, payload: Record<string, unknown>, references: Record<string, unknown> = {}) {
  return { stepName, operationId: `run:1:${stepName}`, kind, payload, references, rationale: "r" };
}

const branchStep = operation("branch", "branch.create", { branch: "docs/fix", fromSha: base, expectedAbsent: true });
const commitStep = operation(
  "commit",
  "commit.create",
  { branch: "docs/fix", message: "Fix" },
  { "/expectedHeadSha": { step: "branch", output: "commitSha" } },
);
const capture = {
  schemaVersion: "gardener.task-capture-manifest/v1",
  captureId: "run:1:capture:1",
  baseSha: base,
  files: [{ path: "docs/a.md", status: "modified", mode: "100644", sizeBytes: 1, sha256 }],
  totalBytes: 1,
  truncated: false,
};

function plan(operations: unknown[], overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "gardener.task-effect-plan/v1",
    runId: "run:1",
    taskId: "fix",
    taskName: "Fix",
    bundleHash: sha256,
    repository: { id: "1", fullName: "scuffi/gardener", defaultBranch: "main" },
    provenance: { sourcePath: ".gardener/tasks/fix/TASK.md", commitSha: base, workflowRunId: "1", workflowRunAttempt: 1 },
    event: { kind: "github.workflow_dispatch", eventName: "workflow_dispatch", action: null, resource: null, commentId: null },
    limits: {},
    capture,
    changesSha256: sha256,
    operations,
    ...overrides,
  };
}

describe("branch rules in the plan", () => {
  it("confines branch writes to gardener/** unless the plan carries patterns", () => {
    expect(() => taskEffectPlanV1Schema.parse(plan([branchStep, commitStep]))).toThrow(/outside this task's branches/);
    const allowed = { "branch.create": ["docs/*"], "commit.create": ["docs/*"] };
    expect(taskEffectPlanV1Schema.parse(plan([branchStep, commitStep], { branchPatterns: allowed })).operations).toHaveLength(2);
    // Each kind has its own patterns.
    expect(() => taskEffectPlanV1Schema.parse(plan([branchStep, commitStep], { branchPatterns: { "branch.create": ["docs/*"] } })))
      .toThrow(/commit.create branch docs\/fix is outside/);
  });

  it("refuses the default branch under a wildcard and names why", () => {
    const toMain = operation("commit", "commit.create", { branch: "main", expectedHeadSha: base, message: "Fix" });
    expect(() => taskEffectPlanV1Schema.parse(plan([toMain], { branchPatterns: { "commit.create": ["**"] } })))
      .toThrow(/is the default branch/);
    expect(taskEffectPlanV1Schema.parse(plan([toMain], { branchPatterns: { "commit.create": ["main"] } })).operations).toHaveLength(1);
  });

  it("checks a ready pull request's head", () => {
    const open = operation("open", "pull_request.open", {
      head: "docs/fix", base: "main", expectedHeadSha: base, expectedBaseSha: base, title: "Fix", body: "",
    });
    expect(() => taskEffectPlanV1Schema.parse(plan([open], { capture: undefined, changesSha256: undefined })))
      .toThrow(/pull_request.open head docs\/fix/);
    expect(taskEffectPlanV1Schema.parse(plan([open], {
      capture: undefined, changesSha256: undefined, branchPatterns: { "pull_request.open": ["docs/**"] },
    })).operations).toHaveLength(1);
  });

  it("requires a commit to sit on the captured commit", () => {
    const patterns = { branchPatterns: { "branch.create": ["docs/*"], "commit.create": ["docs/*"] } };
    const elsewhere = { ...branchStep, payload: { ...branchStep.payload, fromSha: other } };
    expect(() => taskEffectPlanV1Schema.parse(plan([elsewhere, commitStep], patterns))).toThrow(/must start from the captured commit/);
    const literal = operation("commit", "commit.create", { branch: "docs/fix", expectedHeadSha: other, message: "Fix" });
    expect(() => taskEffectPlanV1Schema.parse(plan([literal], patterns))).toThrow(/must build on the captured commit/);
    const onBase = operation("commit", "commit.create", { branch: "docs/fix", expectedHeadSha: base, message: "Fix" });
    expect(taskEffectPlanV1Schema.parse(plan([onBase], patterns)).operations).toHaveLength(1);
  });

  it("only follows a head reference to a branch.create commitSha", () => {
    const fromIssue = operation("issue", "issue.create", { title: "t", body: "b" });
    expect(commitBaseRefusal(
      { ...commitStep, references: { "/expectedHeadSha": { step: "issue", output: "issueNumber" } } },
      [fromIssue],
      base,
    )).toMatch(/may only reference a branch.create/);
    expect(commitBaseRefusal(commitStep, [branchStep], base)).toBeUndefined();
  });
});
