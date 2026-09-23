import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { RpcTarget, newWebSocketRpcSession } from "capnweb";
import {
  runnerActionV1Schema,
  runnerSessionId,
  type PublicSessionCapability,
  type RunnerActionResultV1,
  type RunnerActionV1,
  type RunnerCapability,
  type RunnerHelloV1,
} from "@gardener/protocol";

const executeFile = promisify(execFile);
const baseUrl = process.env.GARDENER_SPIKE_URL ?? "http://127.0.0.1:8787";

const hello: RunnerHelloV1 = {
  schemaVersion: "gardener.runner.hello/v1",
  protocolVersion: "gardener.runner.rpc/v1",
  phase: "plan",
  repositoryId: "1318443351",
  ownerId: "45369682",
  runId: String(Date.now()),
  runAttempt: 1,
  workflowRef: "scuffi/flue/.github/workflows/gardener.yml@refs/heads/main",
  jobWorkflowRef: "scuffi/gardener/.github/workflows/run.yml@0123456789012345678901234567890123456789",
  eventName: "workflow_dispatch",
  ref: "refs/heads/main",
  runnerEnvironment: "github-hosted",
  commitSha: "a".repeat(40),
  agentHash: "b".repeat(64),
};
const sessionId = runnerSessionId(hello);
const socketUrl = `${baseUrl.replace(/^http/, "ws")}/session/${sessionId}`;
const localOidcToken = unsignedOidcToken(hello);

class LocalRunner extends RpcTarget implements RunnerCapability {
  readonly results = new Map<string, RunnerActionResultV1>();

  async execute(input: RunnerActionV1): Promise<RunnerActionResultV1> {
    const action = runnerActionV1Schema.parse(input);
    if (action.kind !== "shell.exec") throw new Error(`The spike client executes only shell.exec, not ${action.kind}`);
    let result: RunnerActionResultV1;
    try {
      const executed = await executeFile("/bin/sh", ["-lc", action.command], {
        cwd: process.cwd(),
        timeout: action.timeoutMs,
        maxBuffer: action.maxOutputBytes,
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      });
      result = {
        schemaVersion: "gardener.runner.action-result/v1",
        sequence: action.sequence,
        operationId: action.operationId,
        status: "completed",
        exitCode: 0,
        stdout: executed.stdout,
        stderr: executed.stderr,
        outputTruncated: false,
      };
    } catch (error) {
      const failure = error as Error & { code?: number | string; stdout?: string; stderr?: string; killed?: boolean };
      const timedOut = failure.killed === true;
      result = {
        schemaVersion: "gardener.runner.action-result/v1",
        sequence: action.sequence,
        operationId: action.operationId,
        status: timedOut ? "timed_out" : "failed",
        exitCode: timedOut ? null : typeof failure.code === "number" ? failure.code : 1,
        stdout: failure.stdout ?? "",
        stderr: failure.stderr ?? failure.message,
        outputTruncated: false,
      };
    }
    this.results.set(action.operationId, result);
    return result;
  }

  async result(operationId: string): Promise<RunnerActionResultV1 | null> {
    return this.results.get(operationId) ?? null;
  }

  async cancel(): Promise<void> {}
}

const wrongRoot = newWebSocketRpcSession<PublicSessionCapability>(`${baseUrl.replace(/^http/, "ws")}/session/wrong-session`);
await expectRejected(wrongRoot.authenticate(hello, localOidcToken, new LocalRunner()));
wrongRoot[Symbol.dispose]();

const firstRoot = newWebSocketRpcSession<PublicSessionCapability>(socketUrl);
const firstRunner = new LocalRunner();
const firstSession = firstRoot.authenticate(hello, localOidcToken, firstRunner);
await firstSession.resume(cursor(0), firstRunner);
const firstAction = action(1, "live-first", "printf 'worker-callback-ok'");
const firstResult = await invokeOverHttp(firstAction);
if (firstResult.stdout !== "worker-callback-ok") throw new Error(`Unexpected first output: ${firstResult.stdout}`);
firstRoot[Symbol.dispose]();
await expectRejected(firstSession.resume(cursor(1), new LocalRunner()));

const secondRoot = newWebSocketRpcSession<PublicSessionCapability>(socketUrl);
const secondSession = secondRoot.authenticate(hello, localOidcToken, new LocalRunner());
const resumed = await secondSession.resume(cursor(1), new LocalRunner());
if (resumed.nextServerSequence !== 2 || resumed.unresolvedOperationIds.length !== 0) {
  throw new Error(`Unexpected resume state: ${JSON.stringify(resumed)}`);
}
const secondResult = await invokeOverHttp(action(2, "live-second", "printf 'worker-reconnect-ok'"));
if (secondResult.stdout !== "worker-reconnect-ok") throw new Error(`Unexpected second output: ${secondResult.stdout}`);

const stateResponse = await fetch(`${baseUrl}/state/${sessionId}`);
if (!stateResponse.ok) throw new Error(`State request failed: ${stateResponse.status}`);
const state = await stateResponse.json() as Array<{ state: string }>;
if (state.length !== 2 || state.some((record) => record.state !== "completed")) {
  throw new Error(`Unexpected durable state: ${JSON.stringify(state)}`);
}

secondSession[Symbol.dispose]();
secondRoot[Symbol.dispose]();
console.log(JSON.stringify({ ok: true, sessionId, first: firstResult.stdout, second: secondResult.stdout, state }));

function action(sequence: number, operationId: string, command: string): RunnerActionV1 {
  return {
    schemaVersion: "gardener.runner.action/v1",
    sequence,
    operationId,
    kind: "shell.exec",
    command,
    cwd: process.cwd(),
    timeoutMs: 30_000,
    maxOutputBytes: 64 * 1024,
  };
}

function unsignedOidcToken(value: RunnerHelloV1): string {
  const claims = {
    repository_id: value.repositoryId,
    repository_owner_id: value.ownerId,
    run_id: value.runId,
    run_attempt: String(value.runAttempt),
    workflow_ref: value.workflowRef,
    job_workflow_ref: value.jobWorkflowRef,
    event_name: value.eventName,
    ref: value.ref,
    runner_environment: value.runnerEnvironment,
    sha: value.commitSha,
  };
  return `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.local`;
}

function cursor(lastCompletedSequence: number) {
  return {
    schemaVersion: "gardener.runner.cursor/v1" as const,
    lastServerSequence: lastCompletedSequence,
    lastCompletedSequence,
  };
}

async function invokeOverHttp(input: RunnerActionV1): Promise<RunnerActionResultV1> {
  const response = await fetch(`${baseUrl}/invoke/${sessionId}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(`Invoke failed (${response.status}): ${JSON.stringify(value)}`);
  return value as RunnerActionResultV1;
}

async function expectRejected(value: Promise<unknown>): Promise<void> {
  try {
    await value;
  } catch {
    return;
  }
  throw new Error("A capability from the closed session unexpectedly remained usable");
}
