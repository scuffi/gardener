import { basename, resolve } from "node:path";
import { runnerEffectReceiptV1Schema } from "@gardener/protocol";
import { z } from "zod";
import { readActionsManifest, readProjectLock } from "./actions-installation.js";
import { setTaskEnabled } from "./actions-operations.js";
import { runCommand, wrangler } from "./commands.js";

const repositorySlug = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);

export interface ActionsQualificationReport {
  schemaVersion: "gardener.actions-qualification/v1";
  workspace: string;
  repository: string;
  qualifiedAt: string;
  tasks: Array<{
    taskId: string;
    label: string;
    issueNumber: number;
    issueUrl: string;
    runId: string;
    runUrl: string;
    commentId: string;
    commentUrl: string;
    bundleHash: string;
  }>;
  drills?: {
    negativeAdmission: { taskId: string; issueNumber: number; runId: string; rejected: true };
    cancellation: { taskId: string; issueNumber: number; runId: string; status: "cancelled" };
    reconciliation: { runsVerified: number; duplicateSettlementEvents: 0; duplicateEffectEvents: 0 };
  };
}

export async function qualifyActions(input: {
  workspace: string;
  repository: string;
  repositoryRoot: string;
  sourceRoot: string;
  drills?: boolean;
  drillsOnly?: boolean;
}): Promise<ActionsQualificationReport> {
  const repository = repositorySlug.parse(input.repository);
  const repositoryRoot = resolve(input.repositoryRoot);
  const sourceRoot = resolve(input.sourceRoot);
  const manifest = await readActionsManifest(input.workspace);
  if (!manifest) throw new Error(`No Actions installation exists for workspace ${input.workspace}`);
  const lock = await readProjectLock(repositoryRoot);
  const results: ActionsQualificationReport["tasks"] = [];
  if (input.drillsOnly && !input.drills) throw new Error("--drills-only requires --drills");

  if (!input.drillsOnly) {
    for (const [taskId, task] of Object.entries(lock.tasks).sort(([left], [right]) => left.localeCompare(right))) {
    const bundle = task.bundle as {
      triggers?: Array<{ kind?: unknown; labelsAll?: unknown }>;
    };
    const trigger = bundle.triggers?.[0];
    if (trigger?.kind !== "github.issue.opened" || !Array.isArray(trigger.labelsAll)
      || typeof trigger.labelsAll[0] !== "string") {
      throw new Error(`Task ${taskId} has no issue-opened qualification label`);
    }
    const label = trigger.labelsAll[0];
    runCommand("gh", [
      "label", "create", label, "--repo", repository, "--color", "0E8A16", "--force",
      "--description", `Gardener task ${taskId}`,
    ], { cwd: repositoryRoot, quiet: true });

    const startedAt = new Date().toISOString();
    const issueOutput = runCommand("gh", [
      "issue", "create", "--repo", repository,
      "--title", `Gardener qualification · ${taskId} · ${Date.now()}`,
      "--body", "Disposable Gardener qualification issue. The generated task must inspect the repository and post exactly one marked comment.",
      "--label", label,
    ], { cwd: repositoryRoot, quiet: true }).stdout.trim();
    const issueUrl = issueOutput.split(/\s+/).find((value) => /^https:\/\/github\.com\//.test(value));
    if (!issueUrl) throw new Error(`GitHub did not return an issue URL for task ${taskId}`);
    const issueNumber = Number(new URL(issueUrl).pathname.split("/").at(-1));
    if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) throw new Error("GitHub returned an invalid issue number");

    const run = await waitForWorkflowRun({
      repository,
      workflow: basename(task.workflow),
      startedAt,
      cwd: repositoryRoot,
    });
    await waitForRunCompletion(repositoryRoot, repository, run.databaseId, true);

    const comments = githubJson(repositoryRoot, [
      "api", `repos/${repository}/issues/${issueNumber}/comments`,
    ]) as Array<{ id?: unknown; html_url?: unknown; body?: unknown; user?: { login?: unknown } }>;
    const marked = comments.filter((comment) =>
      comment.user?.login === "github-actions[bot]"
      && typeof comment.body === "string"
      && comment.body.includes("<!-- gardener-operation:")
    );
    if (marked.length !== 1) throw new Error(`Task ${taskId} produced ${marked.length} marked comments instead of one`);
    const comment = marked[0]!;
    if (typeof comment.id !== "number" || typeof comment.html_url !== "string") {
      throw new Error(`Task ${taskId} returned an invalid GitHub comment receipt`);
    }

    const d1 = await executeD1WithRetry(sourceRoot, [
      "d1", "execute", manifest.cloudflare.database.name,
      "--remote", "--config", manifest.cloudflare.runtimeConfig, "--json",
      "--command", `SELECT bundle_hash,effect_receipt_json FROM actions_task_runs WHERE github_run_id='${run.databaseId.replaceAll("'", "''")}' AND effect_receipt_json IS NOT NULL;`,
    ]);
    const rows = d1Rows(JSON.parse(d1.stdout));
    if (rows.length !== 1 || typeof rows[0]?.effect_receipt_json !== "string") {
      throw new Error(`Task ${taskId} has no unique persisted effect receipt`);
    }
    const receipt = runnerEffectReceiptV1Schema.parse(JSON.parse(rows[0].effect_receipt_json));
    if (receipt.status !== "applied" || receipt.operations.length !== receipt.plannedOperations) {
      throw new Error(`Task ${taskId} effect receipt did not apply the complete ordered plan`);
    }
    const commentSteps = receipt.operations.filter((step) => step.receipt.kind === "issue.comment.create");
    if (commentSteps.length !== 1) {
      throw new Error(`Task ${taskId} receipt records ${commentSteps.length} issue comments instead of one`);
    }
    const commentStep = commentSteps[0]!;
    const receiptCommentId = commentStep.outputs.commentId;
    const receiptCommentUrl = commentStep.outputs.commentUrl ?? commentStep.receipt.resourceUrl;
    if (receiptCommentId !== String(comment.id) || receiptCommentUrl !== comment.html_url) {
      throw new Error(`Task ${taskId} D1 receipt does not match the GitHub comment`);
    }
    if (rows[0].bundle_hash !== task.bundleHash || receipt.bundleHash !== task.bundleHash) {
      throw new Error(`Task ${taskId} D1 receipt does not match the compiled bundle`);
    }

      results.push({
        taskId,
        label,
        issueNumber,
        issueUrl,
        runId: run.databaseId,
        runUrl: run.url,
        commentId: receiptCommentId,
        commentUrl: receiptCommentUrl,
        bundleHash: task.bundleHash,
      });
    }
  }

  const report: ActionsQualificationReport = {
    schemaVersion: "gardener.actions-qualification/v1",
    workspace: input.workspace,
    repository,
    qualifiedAt: new Date().toISOString(),
    tasks: results,
  };
  if (input.drills) {
    const successfulRuns = results.length > 0
      ? results.map((result) => result.runId)
      : (await queryRuns(sourceRoot, manifest,
        `SELECT github_run_id FROM actions_task_runs WHERE effect_receipt_json IS NOT NULL AND json_extract(request_json,'$.event.repository.fullName')=${sql(repository)} ORDER BY created_at DESC,id DESC LIMIT ${Math.max(1, Object.keys(lock.tasks).length)};`))
        .map((row) => String(row.github_run_id));
    report.drills = await qualifyFailureDrills({
      ...input,
      repository,
      repositoryRoot,
      sourceRoot,
      manifest,
      lock,
      successfulRuns,
    });
  }
  return report;
}

async function qualifyFailureDrills(input: {
  workspace: string;
  repository: string;
  repositoryRoot: string;
  sourceRoot: string;
  manifest: NonNullable<Awaited<ReturnType<typeof readActionsManifest>>>;
  lock: Awaited<ReturnType<typeof readProjectLock>>;
  successfulRuns: string[];
}): Promise<NonNullable<ActionsQualificationReport["drills"]>> {
  const [taskId, task] = Object.entries(input.lock.tasks).sort(([left], [right]) => left.localeCompare(right))[0] ?? [];
  if (!taskId || !task) throw new Error("Failure drills require at least one compiled task");
  const bundle = task.bundle as { triggers?: Array<{ kind?: unknown; labelsAll?: unknown }> };
  const trigger = bundle.triggers?.[0];
  if (trigger?.kind !== "github.issue.opened" || !Array.isArray(trigger.labelsAll)
    || typeof trigger.labelsAll[0] !== "string") {
    throw new Error(`Task ${taskId} has no issue-opened qualification label`);
  }
  const label = trigger.labelsAll[0];
  const workflow = basename(task.workflow);

  const taskControl = {
    workspace: input.workspace,
    repository: input.repository,
    taskId,
    repositoryRoot: input.repositoryRoot,
    sourceRoot: input.sourceRoot,
  };
  const remediation = `Run: gardener task enable --workspace ${input.workspace} --repository ${input.repository} --task ${taskId} --repository-root ${input.repositoryRoot} --source-root ${input.sourceRoot}`;
  await setTaskEnabled({ ...taskControl, enabled: false });
  let restoring: Promise<unknown> | undefined;
  const restore = () => restoring ??= setTaskEnabled({ ...taskControl, enabled: true });
  const emergencyRestore = (exitCode: number) => {
    console.error(`Qualification interrupted while task ${taskId} is disabled. ${remediation}`);
    void restore().then(
      () => process.exit(exitCode),
      () => process.exit(exitCode),
    );
  };
  const onInterrupt = () => emergencyRestore(130);
  const onTerminate = () => emergencyRestore(143);
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onTerminate);
  let negative: { taskId: string; issueNumber: number; runId: string; rejected: true };
  let negativeError: unknown;
  try {
    const issue = createQualificationIssue(input.repositoryRoot, input.repository, label, `negative admission · ${taskId}`);
    const run = await waitForWorkflowRun({
      repository: input.repository,
      workflow,
      startedAt: issue.startedAt,
      cwd: input.repositoryRoot,
    });
    await waitForRunCompletion(input.repositoryRoot, input.repository, run.databaseId, false);
    assertNoMarkedComment(input.repositoryRoot, input.repository, issue.issueNumber, taskId);
    const rows = await queryRuns(input.sourceRoot, input.manifest,
      `SELECT status,effect_receipt_json FROM actions_task_runs WHERE github_run_id=${sql(run.databaseId)};`);
    if (rows.some((row) => row.status === "completed" || row.effect_receipt_json !== null)) {
      throw new Error("Disabled task produced a completed run or effect receipt");
    }
    negative = { taskId, issueNumber: issue.issueNumber, runId: run.databaseId, rejected: true };
  } catch (error) {
    negativeError = error;
    throw error;
  } finally {
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onTerminate);
    try {
      await restore();
    } catch (restoreError) {
      throw new Error(`Failed to restore task ${taskId} after the negative drill. ${remediation}`, {
        cause: negativeError ?? restoreError,
      });
    }
  }

  const cancellationIssue = createQualificationIssue(
    input.repositoryRoot,
    input.repository,
    label,
    `cancellation · ${taskId}`,
  );
  const cancellationRun = await waitForWorkflowRun({
    repository: input.repository,
    workflow,
    startedAt: cancellationIssue.startedAt,
    cwd: input.repositoryRoot,
  });
  await waitForTaskRun(input.sourceRoot, input.manifest, cancellationRun.databaseId, (row) =>
    row.status === "admitted" || row.status === "running"
  );
  // Normal cancellation is deferred until after the JavaScript action exits.
  // GitHub's force-cancel endpoint delivered SIGTERM to the updated runner and
  // was live-qualified to settle the durable task outcome before job teardown.
  runCommand("gh", [
    "api", "--method", "POST",
    `repos/${input.repository}/actions/runs/${cancellationRun.databaseId}/force-cancel`,
  ], {
    cwd: input.repositoryRoot,
    quiet: true,
  });
  await waitForRunCompletion(input.repositoryRoot, input.repository, cancellationRun.databaseId, false);
  const cancelled = await waitForTaskRun(input.sourceRoot, input.manifest, cancellationRun.databaseId, (row) =>
    row.status === "cancelled"
  );
  if (cancelled.effect_receipt_json !== null) throw new Error("Cancelled task produced an effect receipt");
  assertNoMarkedComment(input.repositoryRoot, input.repository, cancellationIssue.issueNumber, taskId);

  const runList = input.successfulRuns.map(sql).join(",");
  const events = runList.length === 0 ? [] : await queryRuns(input.sourceRoot, input.manifest,
    `SELECT r.github_run_id,r.github_run_attempt,a.event,COUNT(*) AS event_count FROM actions_task_runs r JOIN actions_task_audit a ON a.run_id=r.id WHERE r.github_run_id IN (${runList}) AND r.github_run_attempt=(SELECT MAX(latest.github_run_attempt) FROM actions_task_runs latest WHERE latest.github_run_id=r.github_run_id) GROUP BY r.github_run_id,r.github_run_attempt,a.event ORDER BY r.github_run_id,r.github_run_attempt,a.event;`);
  for (const runId of input.successfulRuns) {
    const runEvents = events.filter((row) => String(row.github_run_id) === runId);
    if (Number(runEvents.find((row) => row.event === "task.settled")?.event_count) !== 1
      || Number(runEvents.find((row) => row.event === "effect.executed")?.event_count) !== 1) {
      throw new Error(`Run ${runId} does not have one reconciled settlement and effect event`);
    }
  }

  return {
    negativeAdmission: negative,
    cancellation: {
      taskId,
      issueNumber: cancellationIssue.issueNumber,
      runId: cancellationRun.databaseId,
      status: "cancelled",
    },
    reconciliation: {
      runsVerified: input.successfulRuns.length,
      duplicateSettlementEvents: 0,
      duplicateEffectEvents: 0,
    },
  };
}

function createQualificationIssue(cwd: string, repository: string, label: string, drill: string): {
  issueNumber: number;
  startedAt: string;
} {
  const startedAt = new Date().toISOString();
  const output = runCommand("gh", [
    "issue", "create", "--repo", repository,
    "--title", `Gardener qualification drill · ${drill} · ${Date.now()}`,
    "--body", `Disposable Gardener ${drill} qualification issue.`,
    "--label", label,
  ], { cwd, quiet: true }).stdout.trim();
  const issueUrl = output.split(/\s+/).find((value) => /^https:\/\/github\.com\//.test(value));
  const issueNumber = issueUrl ? Number(new URL(issueUrl).pathname.split("/").at(-1)) : Number.NaN;
  if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) throw new Error("GitHub returned an invalid drill issue number");
  return { issueNumber, startedAt };
}

function assertNoMarkedComment(cwd: string, repository: string, issueNumber: number, taskId: string): void {
  const comments = githubJson(cwd, ["api", `repos/${repository}/issues/${issueNumber}/comments`]) as Array<{ body?: unknown }>;
  if (comments.some((comment) => typeof comment.body === "string" && comment.body.includes("<!-- gardener-operation:"))) {
    throw new Error(`Task ${taskId} failure drill unexpectedly produced a marked comment`);
  }
}

async function waitForTaskRun(
  sourceRoot: string,
  manifest: NonNullable<Awaited<ReturnType<typeof readActionsManifest>>>,
  githubRunId: string,
  accept: (row: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  const directD1 = Boolean(process.env.CLOUDFLARE_API_TOKEN ?? process.env.CF_API_TOKEN);
  const attempts = directD1 ? 2_400 : 180;
  const delayMs = directD1 ? 250 : 5_000;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const rows = await queryRunsFast(sourceRoot, manifest,
      `SELECT status,effect_receipt_json FROM actions_task_runs WHERE github_run_id=${sql(githubRunId)} ORDER BY github_run_attempt DESC LIMIT 1;`);
    if (rows[0] && accept(rows[0])) return rows[0];
    if (rows[0] && (rows[0].status === "completed" || rows[0].status === "failed")) {
      throw new Error(`Task run ${githubRunId} settled as ${String(rows[0].status)} instead of cancelled`);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs));
  }
  throw new Error(`Timed out waiting for task run ${githubRunId}`);
}

async function queryRunsFast(
  sourceRoot: string,
  manifest: NonNullable<Awaited<ReturnType<typeof readActionsManifest>>>,
  command: string,
): Promise<Array<Record<string, unknown>>> {
  const token = process.env.CLOUDFLARE_API_TOKEN ?? process.env.CF_API_TOKEN;
  if (!token) return queryRuns(sourceRoot, manifest, command);
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(manifest.cloudflare.accountId)}/d1/database/${encodeURIComponent(manifest.cloudflare.database.id)}/query`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ sql: command }),
    },
  );
  const body = await response.json().catch(() => null) as { success?: unknown; result?: unknown } | null;
  if (!response.ok || body?.success !== true) throw new Error("Cloudflare D1 qualification query failed");
  return d1Rows(body.result);
}

async function queryRuns(
  sourceRoot: string,
  manifest: NonNullable<Awaited<ReturnType<typeof readActionsManifest>>>,
  command: string,
): Promise<Array<Record<string, unknown>>> {
  const result = await executeD1WithRetry(sourceRoot, [
    "d1", "execute", manifest.cloudflare.database.name,
    "--remote", "--config", manifest.cloudflare.runtimeConfig, "--json", "--command", command,
  ]);
  return d1Rows(JSON.parse(result.stdout));
}

function sql(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function waitForRunCompletion(
  cwd: string,
  repository: string,
  runId: string,
  expectSuccess: boolean,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 180; attempt += 1) {
    let value: { status?: unknown; conclusion?: unknown } | undefined;
    try {
      value = githubJson(cwd, [
        "run", "view", runId, "--repo", repository, "--json", "status,conclusion",
      ]) as { status?: unknown; conclusion?: unknown };
      lastError = undefined;
    } catch (error) {
      lastError = error;
    }
    if (value?.status === "completed") {
      if (expectSuccess && value.conclusion !== "success") {
        throw new Error(`GitHub run ${runId} concluded ${String(value.conclusion)}`);
      }
      if (!expectSuccess && value.conclusion === "success") {
        throw new Error(`GitHub run ${runId} unexpectedly succeeded`);
      }
      return;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5_000));
  }
  throw new Error(`Timed out waiting for GitHub run ${runId}`, { cause: lastError });
}

async function waitForWorkflowRun(input: {
  repository: string;
  workflow: string;
  startedAt: string;
  cwd: string;
}): Promise<{ databaseId: string; url: string }> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const value = githubJson(input.cwd, [
      "run", "list", "--repo", input.repository, "--workflow", input.workflow,
      "--event", "issues", "--limit", "5", "--json", "databaseId,url,createdAt",
    ]) as Array<{ databaseId?: unknown; url?: unknown; createdAt?: unknown }>;
    const match = value.find((run) =>
      typeof run.databaseId === "number"
      && typeof run.url === "string"
      && typeof run.createdAt === "string"
      && run.createdAt >= input.startedAt
    );
    if (match) return { databaseId: String(match.databaseId), url: String(match.url) };
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
  }
  throw new Error(`Timed out waiting for ${input.workflow}`);
}

async function executeD1WithRetry(sourceRoot: string, args: string[]) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return wrangler(sourceRoot, "apps/gardener", args, undefined, { quiet: true });
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
    }
  }
  throw lastError;
}

function githubJson(cwd: string, args: string[]): unknown {
  return JSON.parse(runCommand("gh", args, { cwd, quiet: true }).stdout);
}

function d1Rows(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((result) => {
    if (!result || typeof result !== "object") return [];
    const rows = (result as { results?: unknown }).results;
    return Array.isArray(rows)
      ? rows.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object")
      : [];
  });
}
