import type { TaskEffectPlanV1 } from "@gardener/contracts";
import type { RunnerEffectReceiptV1 } from "@gardener/protocol";
import * as core from "@actions/core";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_SUMMARY_CHARS,
  addSecret,
  renderApplyJobSummary,
  renderPlanJobSummary,
  scrubSummary,
  writeJobSummary,
} from "../src/job-summary";

vi.mock("@actions/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@actions/core")>()),
  setSecret: vi.fn(),
  warning: vi.fn(),
}));

const plan = {
  taskName: "pr-review-fix",
  operations: [
    { stepName: "fix", kind: "commit.create", rationale: "Fix the lcm overflow." },
    { stepName: "reply-lcm", kind: "pull_request.review_comment.reply", rationale: "Answer | the\nthread." },
  ],
} as unknown as TaskEffectPlanV1;

const context = { githubRunId: "37458168482", githubRunAttempt: "2" };

function step(stepName: string, kind: string, status: "succeeded" | "skipped" | "failed" | "conflicted", extra: object = {}) {
  return {
    stepName,
    outputs: {},
    receipt: {
      schemaVersion: "v2",
      operationId: `op_${stepName}`,
      operationHash: "a".repeat(64),
      kind,
      status,
      attempt: 1,
      attemptedAt: "2026-10-06T11:43:55.000Z",
      completedAt: "2026-10-06T11:43:56.000Z",
      ...extra,
    },
  };
}

function receipt(status: "applied" | "stopped", operations: ReturnType<typeof step>[], stoppedAtStep: string | null = null) {
  return { status, operations, stoppedAtStep, plannedOperations: 2 } as unknown as RunnerEffectReceiptV1;
}

describe("plan job summary", () => {
  it("lists proposed steps and labels the model's summary", () => {
    const markdown = renderPlanJobSummary({ terminal: { status: "completed", summary: "Fixed **one** finding." }, plan, context });
    expect(markdown).toContain("## Gardener · pr-review-fix: ✅ Planning finished");
    expect(markdown).toContain("The model proposed 2 steps.");
    expect(markdown).toContain("| 1 | `fix` | `commit.create` | Fix the lcm overflow. |");
    // Pipes and newlines in model text cannot break the table.
    expect(markdown).toContain("| Answer \\| the thread. |");
    expect(markdown).toContain("<summary>Model's summary (written by the model)</summary>");
    expect(markdown).toContain("Fixed **one** finding.");
    expect(markdown).toContain("GitHub run 37458168482, attempt 2.");
  });

  it("says when nothing is proposed", () => {
    const markdown = renderPlanJobSummary({ terminal: { status: "completed", summary: "Nothing to do." } });
    expect(markdown).toContain("## Gardener: ✅ Planning finished");
    expect(markdown).toContain("The model proposed no changes, so nothing is applied.");
    expect(markdown).not.toContain("GitHub run");
  });

  it("shows why planning failed", () => {
    const markdown = renderPlanJobSummary({ terminal: { status: "failed", summary: "Task exceeded its runtime budget\nline two" } });
    expect(markdown).toContain("❌ Planning failed");
    expect(markdown).toContain("```text\nTask exceeded its runtime budget\nline two\n```");
    expect(markdown).not.toContain("Model's summary");
  });

  it("shows a bridge error even without a terminal result", () => {
    const markdown = renderPlanJobSummary({ error: "Gardener session closed before completion" });
    expect(markdown).toContain("❌ Planning failed");
    expect(markdown).toContain("**What happened:** The connection to the Gardener runtime dropped");
    expect(markdown).toContain("**What to do:** Re-run all jobs.");
    expect(markdown).toContain("<details><summary>Error details</summary>\n\n```text\nGardener session closed before completion\n```");
  });

  it("treats a bridge error after a completed terminal as a failure", () => {
    const markdown = renderPlanJobSummary({ terminal: { status: "completed", summary: "done" }, plan, error: "capture digest mismatch" });
    expect(markdown).toContain("❌ Planning failed");
    expect(markdown).toContain("```text\ncapture digest mismatch\n```");
  });

  it("shows a run that stopped before planning", () => {
    const markdown = renderPlanJobSummary({ skipped: "Pull request #12 moved again", context });
    expect(markdown).toContain("## Gardener: ⏭️ Planning skipped");
    expect(markdown).toContain("```text\nPull request #12 moved again\n```");
    expect(markdown).toContain("GitHub run 37458168482");
  });

  it("shows a cancelled run", () => {
    expect(renderPlanJobSummary({ terminal: { status: "cancelled", summary: "Run was cancelled" } })).toContain("⏹️ Planning cancelled");
  });
});

describe("apply job summary", () => {
  it("lists every applied step with its link", () => {
    const markdown = renderApplyJobSummary({
      plan,
      receipt: receipt("applied", [
        step("fix", "commit.create", "succeeded", { resourceUrl: "https://github.com/o/r/commit/abc" }),
        step("reply-lcm", "pull_request.review_comment.reply", "skipped"),
      ]),
      context,
    });
    expect(markdown).toContain("## Gardener · pr-review-fix: ✅ Plan applied");
    expect(markdown).toContain("2 of 2 steps ran.");
    expect(markdown).toContain("| 1 | `fix` | `commit.create` | ✅ applied | [open](https://github.com/o/r/commit/abc) |");
    expect(markdown).toContain("| 2 | `reply-lcm` | `pull_request.review_comment.reply` | ↩️ already applied |  |");
  });

  it("explains where a plan stopped and why", () => {
    const markdown = renderApplyJobSummary({
      plan,
      receipt: receipt("stopped", [
        step("fix", "commit.create", "conflicted", { error: { code: "branch_head_changed", message: "The branch moved since planning.", retryable: false } }),
      ], "fix"),
      error: "Effect plan stopped at fix: The branch moved since planning.",
    });
    expect(markdown).toContain("❌ Plan stopped");
    expect(markdown).toContain("Stopped at `fix`, step 1 of 2. No earlier step applied; later steps were not run.");
    expect(markdown).toContain("⚠️ conflicted");
    expect(markdown).toContain("**What happened:** step `fix` (`commit.create`) did not apply. The branch changed after Gardener planned this step");
    expect(markdown).toContain("Nothing was written for this step or any later step.");
    expect(markdown).toContain("**Re-run all jobs**: re-running only the apply job replays the same plan.");
    expect(markdown).toContain("<details><summary>Error from fix: branch_head_changed</summary>\n\n```text\nThe branch moved since planning.\n```");
    // The step error already explains the stop; the bridge error is not repeated.
    expect(markdown).not.toContain("apply bridge stopped");
  });

  it("shows an error raised before any step ran", () => {
    const markdown = renderApplyJobSummary({ error: "Effect artifact digest mismatch" });
    expect(markdown).toContain("## Gardener: ❌ Apply failed");
    expect(markdown).toContain("```text\nEffect artifact digest mismatch\n```");
  });
});

describe("model text containment", () => {
  it("keeps a closing details tag in the model summary inside its block", () => {
    const markdown = renderPlanJobSummary({
      terminal: { status: "completed", summary: "ok</details>\n## Gardener: ✅ Plan applied\n< / DETAILS >" },
    });
    expect(markdown.match(/<\/details>/g)).toHaveLength(1);
    expect(markdown).toContain("ok&lt;/details>");
    expect(markdown).toContain("&lt; / DETAILS >");
    expect(markdown.trimEnd().endsWith("</details>")).toBe(true);
  });

  it("escapes links, HTML and code spans in rationale cells", () => {
    const markdown = renderPlanJobSummary({
      terminal: { status: "completed", summary: "s" },
      plan: {
        taskName: "t",
        operations: [{ stepName: "a", kind: "issue.comment.create", rationale: "see [docs](https://x.test) <img src=x> `code` *bold*" }],
      } as unknown as TaskEffectPlanV1,
    });
    expect(markdown).toContain("see \\[docs\\](https://x.test) \\<img src=x\\> \\`code\\` \\*bold\\* |");
  });

  it("bounds long cells", () => {
    const markdown = renderPlanJobSummary({
      terminal: { status: "completed", summary: "s" },
      plan: { taskName: "t", operations: [{ stepName: "a", kind: "issue.comment.create", rationale: "x".repeat(1_000) }] } as unknown as TaskEffectPlanV1,
    });
    expect(markdown).toContain(`${"x".repeat(299)}…`);
    expect(markdown).not.toContain("x".repeat(300));
  });
});

describe("failure explanations", () => {
  it("explains a task limit and shows what the model did before stopping", () => {
    const markdown = renderPlanJobSummary({
      terminal: { status: "failed", summary: "Task model-turn limit was exceeded (23 tool calls: 12 repository.exec, 11 repository.read_file; no effects proposed)" },
      context: { ...context, githubRepositoryId: "1385186671", taskName: "pr-review-fix" },
    });
    expect(markdown).toContain("## Gardener · pr-review-fix: ❌ Planning failed");
    expect(markdown).toContain("**What happened:** The task reached its own `max-turns` limit before finishing, so nothing was changed.");
    expect(markdown).toContain("**What to do:** Raise `limits.max-turns` in the task's TASK.md");
    expect(markdown).toContain("**Before stopping:** 23 tool calls: 12 repository.exec, 11 repository.read\\_file; no effects proposed");
    expect(markdown).toContain("```text\nTask model-turn limit was exceeded\n```");
    expect(markdown).toContain("`gardener runs view --workspace <name> --run repo-1385186671-run-37458168482-attempt-2-plan`");
  });

  it("uses the plan's run id in the apply footer", () => {
    const markdown = renderApplyJobSummary({
      plan: { ...plan, runId: "repo-1-run-2-attempt-1-plan" } as TaskEffectPlanV1,
      error: "boom",
      context: { ...context, githubRepositoryId: "1" },
    });
    expect(markdown).toContain("--run repo-1-run-2-attempt-1-plan`");
  });

  it("escapes a task name from the caller workflow", () => {
    const markdown = renderPlanJobSummary({ skipped: "x", context: { taskName: "<img src=x> [a](b)" } });
    expect(markdown).toContain("## Gardener · \\<img src=x\\> \\[a\\](b): ⏭️ Planning skipped");
  });

  it("never derives a run id in the apply job, where an apply-only re-run changes the attempt", () => {
    const markdown = renderApplyJobSummary({ error: "boom", context: { ...context, githubRepositoryId: "1" } });
    expect(markdown).toContain("GitHub run 37458168482, attempt 2.");
    expect(markdown).not.toContain("gardener runs view");
  });

  it("names the task on a skipped run", () => {
    expect(renderPlanJobSummary({ skipped: "moved", context: { taskName: "pr-review-fix" } })).toContain("## Gardener · pr-review-fix: ⏭️ Planning skipped");
  });
});

describe("failure text", () => {
  it("renders no markdown and cannot close its fence", () => {
    const markdown = renderApplyJobSummary({ error: "## ✅ Plan applied\n| a | b |\n```\nescaped?" });
    expect(markdown).toContain("````text\n## ✅ Plan applied\n| a | b |\n```\nescaped?\n````");
    expect(markdown).toContain("## Gardener: ❌ Apply failed");
  });

  it("closes an open details block when truncating", () => {
    const truncated = scrubSummary(`<details><summary>x</summary>\n\n${"z".repeat(MAX_SUMMARY_CHARS)}</details>`, []);
    expect(truncated.trimEnd().endsWith("</details>")).toBe(true);
  });
});

describe("scrubbing and writing", () => {
  const originalSummary = process.env.GITHUB_STEP_SUMMARY;
  afterEach(() => {
    vi.clearAllMocks();
    if (originalSummary === undefined) delete process.env.GITHUB_STEP_SUMMARY;
    else process.env.GITHUB_STEP_SUMMARY = originalSummary;
  });

  it("replaces secrets and bounds the size", () => {
    expect(scrubSummary("token ghs_secret123 and ghs_secret123", ["ghs_secret123"])).toBe("token *** and ***");
    const long = scrubSummary("y".repeat(MAX_SUMMARY_CHARS + 10), []);
    expect(long.length).toBeLessThan(MAX_SUMMARY_CHARS + 100);
    expect(long).toContain("_Summary truncated._");
  });

  it("does nothing when the job has no summary file", async () => {
    delete process.env.GITHUB_STEP_SUMMARY;
    const render = vi.fn(() => "x");
    await writeJobSummary(render);
    expect(render).not.toHaveBeenCalled();
  });

  it("writes once, with registered secrets scrubbed", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "gardener-summary-"));
    const file = path.join(directory, "summary.md");
    await writeFile(file, "");
    process.env.GITHUB_STEP_SUMMARY = file;
    addSecret("ghs_registered_token");
    await writeJobSummary(() => renderApplyJobSummary({ error: "bad credentials ghs_registered_token" }));
    const written = await readFile(file, "utf8");
    expect(written).toContain("```text\nbad credentials ***\n```");
    expect(written).not.toContain("ghs_registered_token");
    expect(written.match(/## Gardener/g)).toHaveLength(1);
  });

  it("turns render and write failures into warnings", async () => {
    process.env.GITHUB_STEP_SUMMARY = "/unused";
    const warning = vi.mocked(core.warning);
    vi.spyOn(core.summary, "write").mockRejectedValueOnce(new Error("disk full"));
    await expect(writeJobSummary(() => { throw new Error("render broke"); })).resolves.toBeUndefined();
    await expect(writeJobSummary(() => "fine")).resolves.toBeUndefined();
    expect(warning).toHaveBeenCalledTimes(2);
    expect(warning.mock.calls[0]?.[0]).toContain("render broke");
    expect(warning.mock.calls[1]?.[0]).toContain("disk full");
    expect(core.summary.stringify()).toBe("");
  });
});
