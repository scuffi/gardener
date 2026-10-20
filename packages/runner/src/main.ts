import * as core from "@actions/core";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { taskEffectPlanV1Schema, type TaskEffectPlanV1 } from "@gardener/contracts";
import { type RunnerEventV1 } from "@gardener/protocol";
import {
  actorPermissionTarget,
  authorPermissionLogin,
  fetchAuthorPermission,
  withActorPermission,
  withAuthorPermission,
} from "./author-permission";
import { fetchDispatchTarget } from "./dispatch-target";
import { dispatchTargetRequest, normalizeGitHubEvent, normalizePullRequest } from "./event";
import { fetchCurrentPullRequest, UnconfirmedHeadError, withCheckoutSha, withCurrentPullRequestHead } from "./current-head";
import { createPlanningExecutor, planningCaptureBase } from "./executor";
import { GitHubReadClient } from "./github-read";
import { addSecret, jobSummaryContext, renderPlanJobSummary, writeJobSummary } from "./job-summary";
import { prepareMerge, type MergePreparation } from "./merge-base";
import { runPlanningSession } from "./session";

const oidcRequestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
const oidcRequestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;

/**
 * The repository-scoped read token is captured and removed from the process
 * environment before any task-controlled command can run, so it exists only in
 * this module's closure. `safePlannerEnvironment` additionally allowlists the
 * shell environment, so the token cannot reach `repository.exec` either way.
 */
const providerReadToken = process.env["INPUT_GITHUB-TOKEN"]?.trim() ?? "";
delete process.env["INPUT_GITHUB-TOKEN"];

async function main(): Promise<void> {
  let terminal: Awaited<ReturnType<typeof runPlanningSession>> | undefined;
  let plan: TaskEffectPlanV1 | undefined;
  try {
    const runtimeUrl = requiredInput("runtime-url");
    const agentHash = requiredInput("task-bundle-hash");
    if (!/^[a-f0-9]{64}$/.test(agentHash)) throw new Error("task-bundle-hash must be a lowercase SHA-256 digest");
    const maxReconnects = integerInput("max-reconnects", 5, 0, 20);
    // Set only when the workflow checked out a pull request's head.
    const baseSha = planningCaptureBase(process.env["INPUT_CHECKOUT-REF"], process.env.GITHUB_SHA);
    const mergeRequested = booleanInput("merge-base");
    if (providerReadToken) addSecret(providerReadToken);
    const workspace = requiredEnvironment("GITHUB_WORKSPACE");
    // Reading the event only calls the GitHub API; nothing has touched the
    // checkout yet, and no task command can run until the session connects.
    let event: RunnerEventV1 | undefined;
    try {
      event = await githubEvent(checkoutRef(process.env["INPUT_CHECKOUT-REF"]));
    } catch (error) {
      if (!(error instanceof UnconfirmedHeadError)) throw error;
      // Nothing to plan against, and failing would not bring a newer run.
      core.notice(`${error.message} Stopping without planning.`);
      await writeJobSummary(() => renderPlanJobSummary({ skipped: error.message, context: jobSummaryContext() }));
      return;
    }
    // The merge is prepared before the capture baseline below, because its
    // fetch writes objects and shallow state; it never touches the working
    // tree, index, configuration or attributes that the baseline digests.
    const merge = mergeRequested ? await mergePreparation(workspace, event) : undefined;
    if (merge?.status === "unavailable") core.warning(merge.reason);
    // Built long before the session connects, so the capture baseline is
    // taken while the checkout is still exactly what `actions/checkout`
    // produced.
    const executor = await createPlanningExecutor({
      workspace,
      runnerTemp: process.env.RUNNER_TEMP,
      baseSha,
      ...(merge === undefined ? {} : { merge }),
      ...(providerReadToken
        ? {
          createReadClient: (signal: AbortSignal, maxResponseBytes: number) => new GitHubReadClient({
            token: providerReadToken,
            signal,
            limits: { maxResponseBytes },
          }),
        }
        : {}),
    });
    const cancellation = new AbortController();
    const cancel = () => cancellation.abort();
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    try {
      terminal = await runPlanningSession({
        harnessUrl: runtimeUrl,
        agentHash,
        maxReconnects,
        executor,
        ...(event === undefined ? {} : { event }),
        signal: cancellation.signal,
        getOidcToken: (audience) => getIdTokenWithoutEnvironmentLeak(audience),
        onReconnect: (attempt, error) => {
          core.warning(`Gardener session disconnected; reconnecting (${attempt}/${maxReconnects}): ${message(error)}`);
        },
        onWarning: (warning) => core.warning(warning),
      });
    } finally {
      process.removeListener("SIGINT", cancel);
      process.removeListener("SIGTERM", cancel);
    }
    const outputs: Record<string, string> = {
      status: terminal.status,
      summary: terminal.summary,
      "last-server-sequence": String(terminal.lastServerSequence),
      "last-completed-sequence": String(terminal.lastCompletedSequence),
    };
    if (terminal.effectArtifact) {
      const bytes = Buffer.from(terminal.effectArtifact.bytesBase64, "base64");
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (digest !== terminal.effectArtifact.sha256) throw new Error("Gardener effect artifact digest mismatch");
      const directory = path.join(requiredEnvironment("RUNNER_TEMP"), "gardener-effect-plans");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      plan = taskEffectPlanV1Schema.parse(JSON.parse(bytes.toString("utf8")));
      const artifactPath = path.join(directory, `${digest}.json`);
      await writeFile(artifactPath, bytes, { mode: 0o600 });
      outputs["effect-artifact-path"] = artifactPath;
      outputs["effect-artifact-sha256"] = digest;
      outputs["effect-operation-count"] = String(plan.operations.length);
      // Verify the model-writable local artifact against the digest that the
      // trusted Worker independently derived before publishing any output.
      if (terminal.status === "completed" && terminal.effectArtifact.changesSha256) {
        const capture = await executor.verifiedCaptureArtifact(terminal.effectArtifact.changesSha256);
        outputs["capture-artifact-path"] = capture.directory;
        outputs["capture-id"] = capture.ref.captureId;
        outputs["capture-changes-sha256"] = capture.ref.changesSha256;
      }
    }
    for (const [name, value] of Object.entries(outputs)) core.setOutput(name, value);
    await writeJobSummary(() => renderPlanJobSummary({ terminal: terminal!, ...(plan ? { plan } : {}), context: jobSummaryContext() }));
    if (terminal.status !== "completed") core.setFailed(terminal.summary);
  } catch (error) {
    await writeJobSummary(() => renderPlanJobSummary({
      ...(terminal ? { terminal } : {}),
      ...(plan ? { plan } : {}),
      error: message(error),
      context: jobSummaryContext(),
    }));
    core.setFailed(message(error));
  }
}

/** Reads the Actions event file and normalizes it through the pure module. */
async function githubEvent(checkoutSha: string | undefined): Promise<RunnerEventV1 | undefined> {
  const eventName = process.env.GITHUB_EVENT_NAME;
  if (!eventName) return undefined;
  const raw: unknown = JSON.parse(await readFile(requiredEnvironment("GITHUB_EVENT_PATH"), "utf8"));
  // A manual run that names an issue or pull request is planned against that
  // resource as GitHub reports it now, read with the repository-scoped token.
  const target = dispatchTargetRequest(eventName, raw);
  const resolved = target === null
    ? undefined
    : await fetchDispatchTarget({ target, repository: requiredEnvironment("GITHUB_REPOSITORY"), token: providerReadToken });
  const normalized = await onCheckedOutHead(normalizeGitHubEvent(eventName, raw, resolved), checkoutSha);
  const event = withCheckoutSha(normalized, checkoutSha, await commentPullRequest(eventName, raw, checkoutSha));
  // GitHub reports a private org member as a non-member, so `authors:
  // maintainers` also accepts write access, looked up here before any task
  // command runs. Without it the run falls back to the association alone.
  const login = authorPermissionLogin(event);
  const authored = login === null ? null : await fetchAuthorPermission({
    repository: requiredEnvironment("GITHUB_REPOSITORY"),
    login,
    token: providerReadToken,
  });
  const withAuthor = authored === null ? event : withAuthorPermission(event, authored);
  // Whoever acted on someone else's issue or pull request (the labeller, say)
  // is trusted only with write access, looked up the same way. The Worker
  // decides from it; without it the run is confined to what triggered it.
  const actor = actorPermissionTarget(withAuthor, { login: process.env.GITHUB_ACTOR, id: process.env.GITHUB_ACTOR_ID });
  if (actor === null) return withAuthor;
  const permission = await fetchAuthorPermission({
    repository: requiredEnvironment("GITHUB_REPOSITORY"),
    login: actor.login,
    token: providerReadToken,
  });
  return permission === null ? withAuthor : withActorPermission(withAuthor, actor.id, permission);
}

/** Moves a queued run's event to the pull request head the workflow checked out. */
async function onCheckedOutHead(event: RunnerEventV1, checkoutSha: string | undefined): Promise<RunnerEventV1> {
  const pullRequest = "pullRequest" in event ? event.pullRequest : undefined;
  if (checkoutSha === undefined || pullRequest === undefined || pullRequest.head.sha === checkoutSha) return event;
  const current = await fetchCurrentPullRequest({
    repository: requiredEnvironment("GITHUB_REPOSITORY"),
    number: pullRequest.number,
    token: providerReadToken,
  });
  const moved = withCurrentPullRequestHead(event, checkoutSha, current);
  core.notice(`Pull request #${pullRequest.number} moved since this run was triggered; planning on its current head ${checkoutSha}.`);
  return moved;
}

/**
 * The pull request a comment was written on, read now, when the workflow
 * checked out a pull request head for that comment. Undefined when there is
 * none to read; null when it could not be read, which stops the run.
 */
async function commentPullRequest(eventName: string, raw: unknown, checkoutSha: string | undefined): Promise<Record<string, unknown> | null | undefined> {
  if (eventName !== "issue_comment" || checkoutSha === undefined) return undefined;
  const issue = raw !== null && typeof raw === "object" ? (raw as { issue?: { number?: unknown; pull_request?: unknown } }).issue : undefined;
  if (issue?.pull_request === undefined || issue.pull_request === null || typeof issue.number !== "number") return undefined;
  try {
    const { pull_request: value } = await fetchDispatchTarget({
      target: { kind: "pull_request", number: issue.number },
      repository: requiredEnvironment("GITHUB_REPOSITORY"),
      token: providerReadToken,
    });
    return normalizePullRequest(value);
  } catch {
    return null;
  }
}

/** Prepares the merge for an event whose pull request head the workflow checked out. */
async function mergePreparation(workspace: string, event: RunnerEventV1 | undefined): Promise<MergePreparation> {
  const pullRequest = event !== undefined && "pullRequest" in event ? event.pullRequest : undefined;
  if (event?.checkoutSha === undefined || pullRequest === undefined) {
    return {
      status: "unavailable",
      reason: "No merge was prepared: this run did not check out a pull request's head (the pull request is closed or from a fork, or the event names none).",
    };
  }
  return prepareMerge({
    workspace,
    repository: requiredEnvironment("GITHUB_REPOSITORY"),
    token: providerReadToken,
    pullRequest,
    checkoutSha: event.checkoutSha,
  });
}

/** The commit the workflow checked out instead of GITHUB_SHA, when it named one. */
function checkoutRef(value: string | undefined): string | undefined {
  const ref = value?.trim() ?? "";
  return ref === "" ? undefined : ref;
}

async function getIdTokenWithoutEnvironmentLeak(audience: string): Promise<string> {
  if (!oidcRequestUrl || !oidcRequestToken) throw new Error("GitHub Actions OIDC is unavailable; grant id-token: write");
  process.env.ACTIONS_ID_TOKEN_REQUEST_URL = oidcRequestUrl;
  process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = oidcRequestToken;
  try {
    const token = await core.getIDToken(audience);
    addSecret(token);
    return token;
  } finally {
    delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
    delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  }
}

function requiredInput(name: string): string {
  const value = core.getInput(name, { required: true }).trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function booleanInput(name: string): boolean {
  const raw = core.getInput(name).trim();
  if (raw === "" || raw === "false") return false;
  if (raw === "true") return true;
  throw new Error(`${name} must be true or false`);
}

function integerInput(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = core.getInput(name).trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown Gardener runner failure";
}

void main();
