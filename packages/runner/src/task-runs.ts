import path from "node:path";
import {
  TASK_WORKFLOW_PATH_PATTERN,
  taskWorkflowPath,
  type TaskEffectPlanV1,
  type TaskRunV1,
} from "@gardener/contracts";
import type { RunnerPlanStepReceiptV1, RunnerTaskRunReceiptV1 } from "@gardener/protocol";

const GITHUB_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 1_024 * 1_024;

/** What became of the plan's task run, for the job summary and the job's status. */
export interface TaskRunOutcome {
  readonly receipt: RunnerTaskRunReceiptV1;
  /** True when an earlier attempt settled it, so nothing was sent now. */
  readonly settled?: boolean;
  /** Why the dispatch's outcome is unknown, in words for the summary. Never a response body. */
  readonly error?: string;
}

/** The subject the run starts its task on, with a pull request this plan opened resolved from its step's outputs. */
export function taskRunSubject(
  run: TaskRunV1,
  operations: readonly RunnerPlanStepReceiptV1[],
): RunnerTaskRunReceiptV1["subject"] {
  const subject = run.subject;
  if ("openedBy" in subject) {
    const opened = operations.find((step) => step.stepName === subject.openedBy);
    const number = opened?.outputs.pullNumber;
    if (opened === undefined || (opened.receipt.status !== "succeeded" && opened.receipt.status !== "skipped")
      || typeof number !== "number" || !Number.isSafeInteger(number) || number < 1) {
      throw new Error(`task.run names the pull request step ${subject.openedBy} opened, which recorded no pull request number`);
    }
    return { kind: "pull_request", number };
  }
  return subject.kind === "issue"
    ? { kind: "issue", number: subject.issueNumber }
    : { kind: "pull_request", number: subject.pullNumber };
}

/**
 * The one `workflow_dispatch` request a task run makes: the target's own
 * Gardener workflow, on the default branch, with exactly one input naming the
 * subject, as the generated dispatch form names it. Built here, from the plan's
 * fields alone, so nothing the model wrote can become the ref, the workflow or
 * an input: every task workflow's form also takes a `prompt`, which reaches
 * the started run's model.
 */
export function taskRunDispatchRequest(
  run: Pick<TaskRunV1, "task" | "workflowPath">,
  subject: RunnerTaskRunReceiptV1["subject"],
  defaultBranch: string,
): { workflowFile: string; body: { ref: string; inputs: Record<string, string> } } {
  // The equality pins the exact path for this task id, so today the pattern
  // can never be the check that fires. It stays as the one check that would
  // still hold if a future plan field carried a path from elsewhere.
  if (!TASK_WORKFLOW_PATH_PATTERN.test(run.workflowPath) || run.workflowPath !== taskWorkflowPath(run.task)) {
    throw new Error(`task.run refuses to dispatch ${run.workflowPath}: it is not task ${run.task}'s Gardener workflow`);
  }
  const inputs: Record<string, string> = subject.kind === "issue"
    ? { issue: String(subject.number) }
    : { pull_request: String(subject.number) };
  return { workflowFile: path.posix.basename(run.workflowPath), body: { ref: defaultBranch, inputs } };
}

/**
 * Starts the plan's task, at most once. Only reached after every operation
 * applied. `record` stores an applied receipt carrying the task run's receipt
 * with the runtime, and must succeed before GitHub is called: the runtime
 * writes the lineage record the started run is admitted by when it sees
 * `dispatching`, and refuses it if the target is no longer an enabled task.
 *
 * Nothing here is ever retried. A prior `dispatched` or `dispatch_unknown` is
 * final; a prior `dispatching` with no successor means an attempt stopped
 * between reporting and settling, so the dispatch may or may not have
 * happened, and it settles as `dispatch_unknown` without calling GitHub. A
 * missed run is recoverable by a maintainer; a duplicate isn't.
 */
export async function dispatchPlanTaskRun(input: {
  plan: TaskEffectPlanV1;
  operations: readonly RunnerPlanStepReceiptV1[];
  prior?: RunnerTaskRunReceiptV1 | undefined;
  token: string;
  deadlineAt: number;
  record(receipt: RunnerTaskRunReceiptV1): Promise<unknown>;
  fetch?: typeof fetch;
  now?: () => Date;
}): Promise<TaskRunOutcome | undefined> {
  const run = input.plan.taskRuns?.[0];
  if (run === undefined) return undefined;
  const now = input.now ?? (() => new Date());
  const prior = input.prior;
  if (prior !== undefined && prior.status !== "dispatching") return { receipt: prior, settled: true };
  if (prior !== undefined) {
    const unknown: RunnerTaskRunReceiptV1 = { ...prior, status: "dispatch_unknown", reason: "interrupted" };
    await input.record(unknown);
    return { receipt: unknown, error: "an earlier attempt stopped after reporting the dispatch, so it is not sent again" };
  }
  const subject = taskRunSubject(run, input.operations);
  const repository = input.plan.repository.fullName;
  const fetchImpl = input.fetch ?? fetch;
  const remaining = () => Math.min(GITHUB_TIMEOUT_MS, Math.max(1_000, input.deadlineAt - now().getTime()));
  // Read now rather than taken from the plan: the dispatch runs the target's
  // workflow as it is on the default branch today.
  const defaultBranch = await readDefaultBranch(repository, input.token, fetchImpl, AbortSignal.timeout(remaining()));
  const request = taskRunDispatchRequest(run, subject, defaultBranch);
  const dispatching: RunnerTaskRunReceiptV1 = { task: run.task, subject, status: "dispatching", attemptedAt: now().toISOString() };
  // If this throws, nothing was sent; if the receipt was persisted anyway (a
  // lost answer), a rerun settles it as `dispatch_unknown` rather than sending it.
  await input.record(dispatching);
  let outcome: TaskRunOutcome;
  try {
    const response = await fetchImpl(
      `https://api.github.com/repos/${repositoryPath(repository)}/actions/workflows/${encodeURIComponent(request.workflowFile)}/dispatches`,
      {
        method: "POST",
        headers: { ...githubHeaders(input.token), "content-type": "application/json" },
        body: JSON.stringify(request.body),
        redirect: "error",
        signal: AbortSignal.timeout(remaining()),
      },
    );
    await response.body?.cancel().catch(() => undefined);
    outcome = response.status === 204 || response.status === 200
      ? { receipt: { ...dispatching, status: "dispatched" } }
      : {
        receipt: { ...dispatching, status: "dispatch_unknown", reason: "dispatch_refused" },
        error: `GitHub refused the dispatch of ${request.workflowFile} (HTTP ${response.status})`,
      };
  } catch {
    outcome = {
      receipt: { ...dispatching, status: "dispatch_unknown", reason: "dispatch_failed" },
      error: `the dispatch of ${request.workflowFile} did not complete, so whether it started is unknown`,
    };
  }
  await input.record(outcome.receipt);
  return outcome;
}

async function readDefaultBranch(repository: string, token: string, fetchImpl: typeof fetch, signal: AbortSignal): Promise<string> {
  const response = await fetchImpl(`https://api.github.com/repos/${repositoryPath(repository)}`, {
    headers: githubHeaders(token),
    redirect: "error",
    signal,
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`task.run could not read ${repository}'s default branch (HTTP ${response.status}); nothing was dispatched, so a rerun tries again`);
  }
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) throw new Error("task.run could not read the repository: the response is too large");
  const branch = (JSON.parse(text) as { default_branch?: unknown }).default_branch;
  if (typeof branch !== "string" || branch.length === 0 || branch.length > 255) {
    throw new Error("task.run could not read the repository's default branch; nothing was dispatched, so a rerun tries again");
  }
  return branch;
}

function repositoryPath(repository: string): string {
  const parts = repository.split("/");
  if (parts.length !== 2 || parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new Error("Plan repository name is invalid");
  }
  return parts.map(encodeURIComponent).join("/");
}

function githubHeaders(token: string): Record<string, string> {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "user-agent": "gardener-runner",
    "x-github-api-version": "2022-11-28",
  };
}
