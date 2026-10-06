/**
 * Markdown for the GitHub Actions job summary. The renderers are pure, so the
 * bridges only decide when to write. The summary is informational: rendering
 * and writing share one guard, so neither can change a job's outcome.
 *
 * The plan job's copy is not tamper-proof. The model's shell gets no
 * `GITHUB_STEP_SUMMARY` or `RUNNER_TEMP`, but it runs as the same user and could
 * find the file. The apply job has no checkout or model, so its copy is the
 * trusted one. Model text is still escaped so it cannot impersonate the
 * surrounding Gardener output.
 */
import * as core from "@actions/core";
import type { TaskEffectPlanV1 } from "@gardener/contracts";
import type { RunnerEffectReceiptV1, RunnerTerminalV1 } from "@gardener/protocol";

export interface JobSummaryContext {
  /** `GITHUB_RUN_ID`, shown so operators can find the run with `gardener runs`. */
  githubRunId?: string;
  /** `GITHUB_RUN_ATTEMPT`. */
  githubRunAttempt?: string;
}

const MAX_CELL = 300;
/** Actions discards a step summary over 1 MiB; stay well below it. */
export const MAX_SUMMARY_CHARS = 512 * 1024;

const summarySecrets = new Set<string>();

/**
 * Masks a value in logs and records it so the job summary scrubs it too. The
 * summary is a separate upload, so log masking is not relied on for it.
 */
export function addSecret(value: string): void {
  core.setSecret(value);
  if (value.length >= 4) summarySecrets.add(value);
}

/** Replaces every registered secret, then bounds the total size. */
export function scrubSummary(markdown: string, secrets: Iterable<string> = summarySecrets): string {
  let scrubbed = markdown;
  for (const secret of secrets) scrubbed = scrubbed.split(secret).join("***");
  if (scrubbed.length <= MAX_SUMMARY_CHARS) return scrubbed;
  const kept = scrubbed.slice(0, MAX_SUMMARY_CHARS);
  const open = (kept.match(/<details>/g)?.length ?? 0) - (kept.match(/<\/details>/g)?.length ?? 0);
  return `${kept}\n\n_Summary truncated._\n${open > 0 ? "\n</details>\n" : ""}`;
}

const PLAN_HEADINGS: Record<RunnerTerminalV1["status"], string> = {
  completed: "✅ Planning finished",
  failed: "❌ Planning failed",
  cancelled: "⏹️ Planning cancelled",
};

const STEP_STATUS: Record<RunnerEffectReceiptV1["operations"][number]["receipt"]["status"], string> = {
  succeeded: "✅ applied",
  skipped: "↩️ already applied",
  conflicted: "⚠️ conflicted",
  failed: "❌ failed",
};

/** Summary for the plan job: the final status, why, and what apply will do. */
export function renderPlanJobSummary(input: {
  terminal?: Pick<RunnerTerminalV1, "status" | "summary">;
  plan?: TaskEffectPlanV1;
  /** Set when the bridge failed before or around the session. */
  error?: string;
  /** Set when the bridge stopped before planning without failing the job. */
  skipped?: string;
  context?: JobSummaryContext;
}): string {
  const lines: string[] = [];
  if (input.skipped !== undefined) {
    lines.push("## Gardener: ⏭️ Planning skipped", "", "**Why:** the run stopped before planning.", "", quote(input.skipped), "");
    lines.push(...footer(input.context));
    return lines.join("\n");
  }
  const status = input.error !== undefined ? "failed" : input.terminal?.status ?? "failed";
  const task = input.plan ? ` · ${inline(input.plan.taskName)}` : "";
  lines.push(`## Gardener${task}: ${PLAN_HEADINGS[status]}`, "");
  if (input.error !== undefined) {
    lines.push("**Why:** the plan bridge stopped with an error.", "", quote(input.error), "");
  } else if (input.terminal && status !== "completed") {
    lines.push("**Why:**", "", quote(input.terminal.summary), "");
  } else if (input.terminal) {
    if (input.plan && input.plan.operations.length > 0) {
      const count = input.plan.operations.length;
      lines.push(`The model proposed ${count} ${count === 1 ? "step" : "steps"}. The **Apply exact task plan** job applies them.`, "");
      lines.push("| # | Step | Effect | Reason |", "|---|---|---|---|");
      input.plan.operations.forEach((operation, index) => {
        lines.push(`| ${index + 1} | ${code(operation.stepName)} | ${code(operation.kind)} | ${cell(operation.rationale)} |`);
      });
      lines.push("");
    } else {
      lines.push("The model proposed no changes, so nothing is applied.", "");
    }
    lines.push(details("Model's summary (written by the model)", input.terminal.summary), "");
  }
  lines.push(...footer(input.context));
  return lines.join("\n");
}

/** Summary for the apply job: one row per step, and where it stopped. */
export function renderApplyJobSummary(input: {
  plan?: TaskEffectPlanV1;
  receipt?: RunnerEffectReceiptV1;
  /** Set when apply failed outside a step (bindings, digest, connection). */
  error?: string;
  context?: JobSummaryContext;
}): string {
  const lines: string[] = [];
  const task = input.plan ? ` · ${inline(input.plan.taskName)}` : "";
  const receipt = input.receipt;
  const heading = receipt?.status === "applied" && input.error === undefined
    ? "✅ Plan applied"
    : receipt?.status === "stopped"
      ? "❌ Plan stopped"
      : "❌ Apply failed";
  lines.push(`## Gardener${task}: ${heading}`, "");
  if (receipt) {
    const done = receipt.operations.length;
    if (receipt.status === "stopped" && receipt.stoppedAtStep) {
      lines.push(`Stopped at ${code(receipt.stoppedAtStep)} after ${done} of ${receipt.plannedOperations} steps. Later steps were not run.`, "");
    } else {
      lines.push(`${done} of ${receipt.plannedOperations} steps ran.`, "");
    }
    lines.push("| # | Step | Effect | Result | Link |", "|---|---|---|---|---|");
    receipt.operations.forEach((step, index) => {
      const link = step.receipt.resourceUrl ? `[open](${step.receipt.resourceUrl})` : "";
      lines.push(`| ${index + 1} | ${code(step.stepName)} | ${code(step.receipt.kind)} | ${STEP_STATUS[step.receipt.status]} | ${link} |`);
    });
    lines.push("");
    for (const step of receipt.operations) {
      if (!step.receipt.error) continue;
      lines.push(`**\`${inline(step.stepName)}\`** · \`${inline(step.receipt.error.code)}\``, "", quote(step.receipt.error.message), "");
    }
  }
  if (input.error !== undefined && !(receipt?.status === "stopped")) {
    lines.push("**Why:** the apply bridge stopped with an error before finishing.", "", quote(input.error), "");
  }
  lines.push(...footer(input.context));
  return lines.join("\n");
}

/**
 * Renders and appends the job summary. Rendering happens inside the guard, so
 * a failure in either is a warning, never a job failure.
 */
export async function writeJobSummary(render: () => string): Promise<void> {
  try {
    if (!process.env.GITHUB_STEP_SUMMARY) return;
    await core.summary.addRaw(scrubSummary(render()), true).write();
  } catch (error) {
    core.summary.emptyBuffer();
    core.warning(`Could not write the Gardener job summary: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function jobSummaryContext(): JobSummaryContext {
  return {
    ...(process.env.GITHUB_RUN_ID ? { githubRunId: process.env.GITHUB_RUN_ID } : {}),
    ...(process.env.GITHUB_RUN_ATTEMPT ? { githubRunAttempt: process.env.GITHUB_RUN_ATTEMPT } : {}),
  };
}

function footer(context: JobSummaryContext | undefined): string[] {
  if (!context?.githubRunId) return [];
  const attempt = context.githubRunAttempt ? `, attempt ${inline(context.githubRunAttempt)}` : "";
  return [`<sub>GitHub run ${inline(context.githubRunId)}${attempt}. Operators can inspect it with \`gardener runs --repository <owner/repo>\`.</sub>`, ""];
}

/** A text table cell: one line, no pipes, links, HTML or code spans, bounded length. */
function cell(value: string): string {
  const flat = bounded(value.replace(/\s+/g, " ").trim());
  return flat.replace(/[\\`*_[\]<>|]/g, (character) => `\\${character}`);
}

/** A code-span table cell: one line, no backticks or pipes, bounded length. */
function code(value: string): string {
  return `\`${bounded(inline(value)).replace(/\|/g, "\\|")}\``;
}

function bounded(value: string): string {
  return value.length > MAX_CELL ? `${value.slice(0, MAX_CELL - 1)}…` : value;
}

function inline(value: string): string {
  return value.replace(/\s+/g, " ").replace(/`/g, "'").trim();
}

/**
 * Failure text (model, provider or bridge) as a fenced block, so none of its
 * markdown renders. The fence is longer than any backtick run inside it.
 */
function quote(value: string): string {
  const longest = Math.max(2, ...[...value.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}text\n${value.trim()}\n${fence}`;
}

/** Model text keeps its markdown, but cannot close the block it sits in. */
function details(title: string, body: string): string {
  const contained = body.trim().replace(/<(\s*\/?\s*details)/gi, "&lt;$1");
  return `<details><summary>${title}</summary>\n\n${contained}\n\n</details>`;
}
