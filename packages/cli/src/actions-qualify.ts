import { basename, resolve } from "node:path";
import { runnerEffectReceiptV1Schema } from "@gardener/protocol";
import { z } from "zod";
import { readActionsManifest, readProjectLock } from "./actions-installation.js";
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
}

export async function qualifyActions(input: {
  workspace: string;
  repository: string;
  repositoryRoot: string;
  sourceRoot: string;
}): Promise<ActionsQualificationReport> {
  const repository = repositorySlug.parse(input.repository);
  const repositoryRoot = resolve(input.repositoryRoot);
  const sourceRoot = resolve(input.sourceRoot);
  const manifest = await readActionsManifest(input.workspace);
  if (!manifest) throw new Error(`No Actions installation exists for workspace ${input.workspace}`);
  const lock = await readProjectLock(repositoryRoot);
  const results: ActionsQualificationReport["tasks"] = [];

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
    runCommand("gh", ["run", "watch", run.databaseId, "--repo", repository, "--exit-status"], {
      cwd: repositoryRoot,
      quiet: true,
    });

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

    const d1 = wrangler(sourceRoot, "apps/gardener", [
      "d1", "execute", manifest.cloudflare.database.name,
      "--remote", "--config", manifest.cloudflare.runtimeConfig, "--json",
      "--command", `SELECT bundle_hash,effect_receipt_json FROM actions_task_runs WHERE github_run_id='${run.databaseId.replaceAll("'", "''")}' AND effect_receipt_json IS NOT NULL;`,
    ], undefined, { quiet: true });
    const rows = d1Rows(JSON.parse(d1.stdout));
    if (rows.length !== 1 || typeof rows[0]?.effect_receipt_json !== "string") {
      throw new Error(`Task ${taskId} has no unique persisted effect receipt`);
    }
    const receipt = runnerEffectReceiptV1Schema.parse(JSON.parse(rows[0].effect_receipt_json));
    if (receipt.commentId !== String(comment.id) || receipt.commentUrl !== comment.html_url) {
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
      commentId: receipt.commentId,
      commentUrl: receipt.commentUrl,
      bundleHash: task.bundleHash,
    });
  }

  return {
    schemaVersion: "gardener.actions-qualification/v1",
    workspace: input.workspace,
    repository,
    qualifiedAt: new Date().toISOString(),
    tasks: results,
  };
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
