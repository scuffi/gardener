import * as core from "@actions/core";
import { RpcTarget, newWebSocketRpcSession } from "capnweb";
import {
  type PublicSessionCapability,
  type RunnerActionResultV1,
  type RunnerActionV1,
  type RunnerCapability,
} from "@gardener/protocol";
import { helloFromOidcToken, sessionSocketUrl } from "./context";

class NullRunner extends RpcTarget implements RunnerCapability {
  async execute(_action: RunnerActionV1): Promise<RunnerActionResultV1> {
    throw new Error("Replay probe must never receive an action");
  }
  async result(): Promise<RunnerActionResultV1 | null> { return null; }
  async cancel(): Promise<void> {}
}

async function main(): Promise<void> {
  let firstRoot: ReturnType<typeof newWebSocketRpcSession<PublicSessionCapability>> | undefined;
  let replayRoot: ReturnType<typeof newWebSocketRpcSession<PublicSessionCapability>> | undefined;
  try {
    const harnessUrl = core.getInput("harness-url", { required: true });
    const agentHash = core.getInput("agent-hash", { required: true });
    const phaseInput = core.getInput("phase") || "plan";
    if (phaseInput !== "plan" && phaseInput !== "effects") throw new Error("phase must be plan or effects");
    const phase: "plan" | "effects" = phaseInput;
    const audience = new URL(harnessUrl).origin;
    const token = await core.getIDToken(audience);
    core.setSecret(token);
    const hello = helloFromOidcToken(token, agentHash, phase);
    const url = sessionSocketUrl(harnessUrl, hello, phase);
    const runner = new NullRunner();
    const cursor = {
      schemaVersion: "gardener.runner.cursor/v1" as const,
      lastServerSequence: 0,
      lastCompletedSequence: 0,
    };

    firstRoot = newWebSocketRpcSession<PublicSessionCapability>(url);
    const accepted = firstRoot.authenticate(hello, token, runner);
    await accepted.resume(cursor, runner);
    firstRoot[Symbol.dispose]();
    firstRoot = undefined;

    replayRoot = newWebSocketRpcSession<PublicSessionCapability>(url);
    const replayed = replayRoot.authenticate(hello, token, runner);
    try {
      await replayed.resume(cursor, runner);
      throw new Error("Gardener accepted a replayed GitHub OIDC token");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === "Gardener accepted a replayed GitHub OIDC token") throw error;
      if (!message.includes("already used")) throw new Error(`Unexpected replay rejection: ${message}`);
    }
    core.setOutput("replay-rejected", "true");
    core.info("Gardener rejected reuse of the same GitHub OIDC token.");
  } catch (error) {
    core.setFailed(error instanceof Error ? error.message : "Unknown replay-probe failure");
  } finally {
    firstRoot?.[Symbol.dispose]();
    replayRoot?.[Symbol.dispose]();
  }
}

void main();
