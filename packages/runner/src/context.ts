import { runnerHelloV1Schema, runnerSessionId, type RunnerHelloV1 } from "@gardener/protocol";

export function helloFromOidcToken(token: string, agentHash: string, phase: "plan" | "effects"): RunnerHelloV1 {
  if (Buffer.byteLength(token, "utf8") > 16 * 1024) throw new Error("GitHub OIDC token is too large");
  const segments = token.split(".");
  if (segments.length !== 3 || !segments[1]) throw new Error("GitHub OIDC token is not a JWT");
  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(Buffer.from(segments[1], "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new Error("GitHub OIDC token payload is invalid");
  }
  return runnerHelloV1Schema.parse({
    schemaVersion: "gardener.runner.hello/v1",
    protocolVersion: "gardener.runner.rpc/v1",
    phase,
    repositoryId: claim(claims, "repository_id"),
    ownerId: claim(claims, "repository_owner_id"),
    runId: claim(claims, "run_id"),
    runAttempt: Number(claim(claims, "run_attempt")),
    workflowRef: claim(claims, "workflow_ref"),
    jobWorkflowRef: claim(claims, "job_workflow_ref"),
    eventName: claim(claims, "event_name"),
    ref: claim(claims, "ref"),
    runnerEnvironment: claim(claims, "runner_environment"),
    commitSha: claim(claims, "sha"),
    agentHash,
  });
}

export function sessionSocketUrl(harnessUrl: string, hello: RunnerHelloV1, phase: "plan" | "effects"): string {
  const origin = new URL(harnessUrl);
  if (origin.protocol !== "https:" && origin.protocol !== "http:") throw new Error("Gardener harness URL must use HTTP or HTTPS");
  origin.protocol = origin.protocol === "https:" ? "wss:" : "ws:";
  if (origin.protocol === "ws:" && origin.hostname !== "localhost" && origin.hostname !== "127.0.0.1") {
    throw new Error("Gardener harness URL must use HTTPS outside local development");
  }
  if (phase !== hello.phase) throw new Error("Runner session phase does not match its hello");
  origin.pathname = `/session/${runnerSessionId(hello)}`;
  origin.search = "";
  origin.hash = "";
  return origin.href;
}

function claim(claims: Record<string, unknown>, name: string): string {
  const value = claims[name];
  if ((typeof value !== "string" && typeof value !== "number") || String(value).length === 0) {
    throw new Error(`GitHub OIDC token has no usable ${name} claim`);
  }
  return String(value);
}
