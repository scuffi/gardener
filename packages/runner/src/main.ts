import * as core from "@actions/core";
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
    const terminal = await runPlanningSession({
      harnessUrl,
      agentHash,
      maxReconnects,
      getOidcToken: (audience) => getIdTokenWithoutEnvironmentLeak(audience),
      onReconnect: (attempt, error) => {
        core.warning(`Gardener session disconnected; reconnecting (${attempt}/${maxReconnects}): ${message(error)}`);
      },
    });
    core.setOutput("status", terminal.status);
    core.setOutput("summary", terminal.summary);
    core.setOutput("last-server-sequence", String(terminal.lastServerSequence));
    core.setOutput("last-completed-sequence", String(terminal.lastCompletedSequence));
    if (terminal.status !== "completed") core.setFailed(terminal.summary);
  } catch (error) {
    core.setFailed(message(error));
  }
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

function message(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown Gardener runner failure";
}

void main();
