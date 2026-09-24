import * as core from "@actions/core";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { taskEffectPlanV1Schema } from "@gardener/contracts";
import { type RunnerEventV1 } from "@gardener/protocol";
import { fetchDispatchTarget } from "./dispatch-target";
import { dispatchTargetRequest, normalizeGitHubEvent } from "./event";
import { createPlanningExecutor } from "./executor";
import { GitHubReadClient } from "./github-read";
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
  try {
    const runtimeUrl = requiredInput("runtime-url");
    const agentHash = requiredInput("task-bundle-hash");
    if (!/^[a-f0-9]{64}$/.test(agentHash)) throw new Error("task-bundle-hash must be a lowercase SHA-256 digest");
    const maxReconnects = integerInput("max-reconnects", 5, 0, 20);
    if (providerReadToken) core.setSecret(providerReadToken);
    // Built before the event is read and long before the session connects, so
    // the capture baseline is taken while the checkout is still exactly what
    // `actions/checkout` produced.
    const executor = await createPlanningExecutor({
      workspace: requiredEnvironment("GITHUB_WORKSPACE"),
      runnerTemp: process.env.RUNNER_TEMP,
      baseSha: process.env.GITHUB_SHA,
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
    const event = await githubEvent();
    const cancellation = new AbortController();
    const cancel = () => cancellation.abort();
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    let terminal: Awaited<ReturnType<typeof runPlanningSession>>;
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
      const plan = taskEffectPlanV1Schema.parse(JSON.parse(bytes.toString("utf8")));
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
    if (terminal.status !== "completed") core.setFailed(terminal.summary);
  } catch (error) {
    core.setFailed(message(error));
  }
}

/** Reads the Actions event file and normalizes it through the pure module. */
async function githubEvent(): Promise<RunnerEventV1 | undefined> {
  const eventName = process.env.GITHUB_EVENT_NAME;
  if (!eventName) return undefined;
  const raw: unknown = JSON.parse(await readFile(requiredEnvironment("GITHUB_EVENT_PATH"), "utf8"));
  // A manual run that names an issue or pull request is planned against that
  // resource as GitHub reports it now, read with the repository-scoped token.
  const target = dispatchTargetRequest(eventName, raw);
  const resolved = target === null
    ? undefined
    : await fetchDispatchTarget({ target, repository: requiredEnvironment("GITHUB_REPOSITORY"), token: providerReadToken });
  return normalizeGitHubEvent(eventName, raw, resolved);
}

async function getIdTokenWithoutEnvironmentLeak(audience: string): Promise<string> {
  if (!oidcRequestUrl || !oidcRequestToken) throw new Error("GitHub Actions OIDC is unavailable; grant id-token: write");
  process.env.ACTIONS_ID_TOKEN_REQUEST_URL = oidcRequestUrl;
  process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = oidcRequestToken;
  try {
    const token = await core.getIDToken(audience);
    core.setSecret(token);
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
