import { RpcTarget, newWebSocketRpcSession } from "capnweb";
import {
  runnerSessionId,
  type PublicSessionCapability,
  type RunnerActionResultV1,
  type RunnerActionV1,
  type RunnerCapability,
  type RunnerHelloV1,
} from "@gardener/protocol";

const baseUrl = process.env.GARDENER_SPIKE_URL;
if (!baseUrl) throw new Error("GARDENER_SPIKE_URL is required");

const hello: RunnerHelloV1 = {
  schemaVersion: "gardener.runner.hello/v1",
  protocolVersion: "gardener.runner.rpc/v1",
  phase: "plan",
  repositoryId: "1374701263",
  ownerId: "45369682",
  runId: String(Date.now()),
  runAttempt: 1,
  workflowRef: "scuffi/gardener-actions-v1-private-smoke/.github/workflows/gardener.yml@refs/heads/main",
  jobWorkflowRef: "scuffi/gardener/.github/workflows/gardener-reusable-spike.yml@bd6ac76f84e5969797507bd8ab52b97afceac05b",
  eventName: "workflow_dispatch",
  ref: "refs/heads/main",
  runnerEnvironment: "github-hosted",
  commitSha: "a".repeat(40),
  agentHash: "b".repeat(64),
};

class NullRunner extends RpcTarget implements RunnerCapability {
  async execute(_action: RunnerActionV1): Promise<RunnerActionResultV1> {
    throw new Error("Unauthenticated runner must never receive an action");
  }
  async result(): Promise<RunnerActionResultV1 | null> { return null; }
  async cancel(): Promise<void> {}
}

const socketOrigin = baseUrl.replace(/^http/, "ws");
await rejectedAuthentication(`${socketOrigin}/session/${runnerSessionId(hello)}`, "unsigned-token");
await rejectedAuthentication(`${socketOrigin}/session/wrong-session`, "unsigned-token");
console.log(JSON.stringify({ ok: true, rejected: ["invalid-signature", "wrong-session"] }));

async function rejectedAuthentication(url: string, token: string): Promise<void> {
  const root = newWebSocketRpcSession<PublicSessionCapability>(url);
  try {
    await root.authenticate(hello, token, new NullRunner());
    throw new Error("Worker accepted an invalid OIDC token");
  } catch (error) {
    if (error instanceof Error && error.message === "Worker accepted an invalid OIDC token") throw error;
  } finally {
    root[Symbol.dispose]();
  }
}
