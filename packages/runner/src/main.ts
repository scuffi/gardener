import * as core from "@actions/core";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { runnerEventV1Schema, type RunnerEventV1 } from "@gardener/protocol";
import { runPlanningSession } from "./session";

const oidcRequestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
const oidcRequestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;

async function main(): Promise<void> {
  try {
    const harnessUrl = requiredInput("harness-url");
    const agentHash = requiredInput("agent-hash");
    if (!/^[a-f0-9]{64}$/.test(agentHash)) throw new Error("agent-hash must be a lowercase SHA-256 digest");
    const maxReconnects = integerInput("max-reconnects", 5, 0, 20);
    const event = await githubEvent();
    const terminal = await runPlanningSession({
      harnessUrl,
      agentHash,
      maxReconnects,
      ...(event === undefined ? {} : { event }),
      getOidcToken: (audience) => getIdTokenWithoutEnvironmentLeak(audience),
      onReconnect: (attempt, error) => {
        core.warning(`Gardener session disconnected; reconnecting (${attempt}/${maxReconnects}): ${message(error)}`);
      },
    });
    core.setOutput("status", terminal.status);
    core.setOutput("summary", terminal.summary);
    core.setOutput("last-server-sequence", String(terminal.lastServerSequence));
    core.setOutput("last-completed-sequence", String(terminal.lastCompletedSequence));
    if (terminal.effectArtifact) {
      const bytes = Buffer.from(terminal.effectArtifact.bytesBase64, "base64");
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (digest !== terminal.effectArtifact.sha256) throw new Error("Gardener effect artifact digest mismatch");
      const directory = path.join(requiredEnvironment("RUNNER_TEMP"), "gardener-effects");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const artifactPath = path.join(directory, `${digest}.json`);
      await writeFile(artifactPath, bytes, { mode: 0o600 });
      core.setOutput("effect-artifact-path", artifactPath);
      core.setOutput("effect-artifact-sha256", digest);
    }
    if (terminal.status !== "completed") core.setFailed(terminal.summary);
  } catch (error) {
    core.setFailed(message(error));
  }
}

async function githubEvent(): Promise<RunnerEventV1 | undefined> {
  if (process.env.GITHUB_EVENT_NAME !== "issues") return undefined;
  const raw = JSON.parse(await readFile(requiredEnvironment("GITHUB_EVENT_PATH"), "utf8")) as Record<string, unknown>;
  if (raw.action !== "opened") throw new Error("Gardener v1 supports only issues: opened");
  const issue = raw.issue as Record<string, unknown> | undefined;
  const author = issue?.user as Record<string, unknown> | undefined;
  if (!issue || !author) throw new Error("GitHub issue event payload is incomplete");
  return runnerEventV1Schema.parse({
    schemaVersion: "gardener.runner.event/v1",
    kind: "github.issue.opened",
    issue: {
      id: String(issue.id ?? ""),
      number: issue.number,
      title: issue.title,
      body: issue.body ?? null,
      labels: Array.isArray(issue.labels) ? issue.labels.map((label) => String((label as Record<string, unknown>).name ?? "")) : [],
      author: { id: String(author.id ?? ""), login: author.login },
    },
  });
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
