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
import { applyFailureAdvice, planFailureAdvice, splitFailureTrail } from "./failure-advice";

export interface JobSummaryContext {
  /** `GITHUB_RUN_ID`. */
  githubRunId?: string;
  /** `GITHUB_RUN_ATTEMPT`. */
  githubRunAttempt?: string;
  /** `GITHUB_REPOSITORY_ID`, which with the run id names the Gardener run. */
  githubRepositoryId?: string;
  /** The reusable workflow's `task-name`, for summaries written without a plan. */
  taskName?: string;
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
  const task = taskLabel(input.plan?.taskName ?? input.context?.taskName);
  if (input.skipped !== undefined) {
    lines.push(`## Gardener${task}: ⏭️ Planning skipped`, "", "**What happened:** the run stopped before planning. Nothing was changed.", "", quote(input.skipped), "");
    lines.push(...footer(input.context, input.plan?.runId));
    return lines.join("\n");
  }
  const status = input.error !== undefined ? "failed" : input.terminal?.status ?? "failed";
  lines.push(`## Gardener${task}: ${PLAN_HEADINGS[status]}`, "");
  if (input.error !== undefined || (input.terminal && status !== "completed")) {
    const raw = input.error ?? input.terminal!.summary;
    const { message, trail } = splitFailureTrail(raw);
    const advice = planFailureAdvice(message, status === "cancelled" ? "cancelled" : "failed");
    lines.push(`**What happened:** ${advice.what}`, "", `**What to do:** ${advice.todo}`, "");
    if (trail) lines.push(`**Before stopping:** ${cell(trail)}`, "");
    lines.push(fenced("Error details", message), "");
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
  lines.push(...footer(input.context, input.plan?.runId));
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
  const task = taskLabel(input.plan?.taskName ?? input.context?.taskName);
  const receipt = input.receipt;
  const heading = receipt?.status === "applied" && input.error === undefined
    ? "✅ Plan applied"
    : receipt?.status === "stopped"
      ? "❌ Plan stopped"
      : "❌ Apply failed";
  lines.push(`## Gardener${task}: ${heading}`, "");
  const stopping = receipt?.status === "stopped" ? receipt.operations.find((step) => step.receipt.error) : undefined;
  if (stopping?.receipt.error) {
    const advice = applyFailureAdvice(stopping.receipt.error.code);
    lines.push(
      `**What happened:** step ${code(stopping.stepName)} (${code(stopping.receipt.kind)}) did not apply. ${advice.what}`,
      "",
      `**What to do:** ${advice.todo}`,
      "",
    );
  } else if (input.error !== undefined && receipt?.status !== "stopped") {
    lines.push(
      "**What happened:** the apply job stopped before finishing the plan.",
      "",
      `**What to do:** ${receipt && receipt.operations.length > 0 ? "Check the steps below. " : "Nothing was written. "}Re-run all jobs; if it fails again, an operator can see the full record with the command below.`,
      "",
      fenced("Error details", input.error),
      "",
    );
  }
  if (receipt) {
    const done = receipt.operations.length;
    if (receipt.status === "stopped" && receipt.stoppedAtStep) {
      const before = receipt.operations.filter((step) => step.receipt.status === "succeeded" || step.receipt.status === "skipped").length;
      const earlier = before === 0 ? "No earlier step applied" : `${before} earlier ${before === 1 ? "step" : "steps"} applied`;
      lines.push(`Stopped at ${code(receipt.stoppedAtStep)}, step ${done} of ${receipt.plannedOperations}. ${earlier}; later steps were not run.`, "");
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
      lines.push(fenced(`Error from ${inline(step.stepName)}: ${inline(step.receipt.error.code)}`, step.receipt.error.message), "");
    }
  }
  lines.push(...footer(input.context, input.plan?.runId, false));
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
  const taskName = process.env["INPUT_TASK-NAME"]?.trim();
  return {
    ...(process.env.GITHUB_RUN_ID ? { githubRunId: process.env.GITHUB_RUN_ID } : {}),
    ...(process.env.GITHUB_RUN_ATTEMPT ? { githubRunAttempt: process.env.GITHUB_RUN_ATTEMPT } : {}),
    ...(process.env.GITHUB_REPOSITORY_ID ? { githubRepositoryId: process.env.GITHUB_REPOSITORY_ID } : {}),
    ...(taskName ? { taskName } : {}),
  };
}

function footer(context: JobSummaryContext | undefined, planRunId?: string, derive = true): string[] {
  if (!context?.githubRunId) return [];
  const attempt = context.githubRunAttempt ? `, attempt ${inline(context.githubRunAttempt)}` : "";
  // Only the plan job derives its own run id. Re-running just the apply job
  // starts a new attempt for the same plan, so apply relies on the plan's id.
  const derived = derive && context.githubRepositoryId && context.githubRunAttempt
    ? `repo-${context.githubRepositoryId}-run-${context.githubRunId}-attempt-${context.githubRunAttempt}-plan`
    : undefined;
  const runId = planRunId ?? derived;
  const inspect = runId && /^[A-Za-z0-9._-]+$/.test(runId)
    ? ` Operators can inspect it with \`gardener runs view --workspace <name> --run ${runId}\`.`
    : "";
  return [`<sub>GitHub run ${inline(context.githubRunId)}${attempt}.${inspect}</sub>`, ""];
}

/** The task name can come from the caller workflow, so it is escaped like any table cell. */
function taskLabel(name: string | undefined): string {
  return name ? ` · ${cell(name)}` : "";
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

/** A collapsed block of model text: it keeps its markdown but cannot close the block it sits in. */
function details(title: string, body: string): string {
  const contained = body.trim().replace(/<(\s*\/?\s*details)/gi, "&lt;$1");
  return `<details><summary>${title}</summary>\n\n${contained}\n\n</details>`;
}

/** A collapsed block of failure text, fenced so none of it renders or escapes. */
function fenced(title: string, text: string): string {
  return `<details><summary>${title}</summary>\n\n${quote(text)}\n\n</details>`;
}
