import http from "node:http";
import { RpcTarget, newWebSocketRpcSession, type RpcStub } from "capnweb";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import {
  ActionJournal,
  resumeCursorV1Schema,
  runnerActionResultV1Schema,
  runnerActionV1Schema,
  runnerHelloV1Schema,
  type AuthenticatedSessionCapability,
  type PublicSessionCapability,
  type ResumeCursorV1,
  type ResumeStateV1,
  type RunnerActionResultV1,
  type RunnerActionV1,
  type RunnerCapability,
  type RunnerHelloV1,
} from "../src";

const hello: RunnerHelloV1 = {
  schemaVersion: "gardener.runner.hello/v1",
  protocolVersion: "gardener.runner.rpc/v1",
  phase: "plan",
  repositoryId: "1318443351",
  ownerId: "45369682",
  runId: "123456789",
  runAttempt: 1,
  workflowRef: "scuffi/flue/.github/workflows/gardener.yml@refs/heads/main",
  jobWorkflowRef: "scuffi/gardener/.github/workflows/run.yml@0123456789012345678901234567890123456789",
  eventName: "workflow_dispatch",
  ref: "refs/heads/main",
  runnerEnvironment: "github-hosted",
  commitSha: "a".repeat(40),
  agentHash: "b".repeat(64),
};

const action: RunnerActionV1 = {
  schemaVersion: "gardener.runner.action/v1",
  sequence: 1,
  operationId: "operation-one",
  kind: "shell.exec",
  command: "printf gardener",
  cwd: "/workspace",
  timeoutMs: 30_000,
  maxOutputBytes: 64 * 1024,
};

class TestSession extends RpcTarget implements AuthenticatedSessionCapability {
  #runner: RpcStub<RunnerCapability>;

  constructor(
    runner: RpcStub<RunnerCapability>,
    readonly journal: ActionJournal,
  ) {
    super();
    this.#runner = runner.dup();
  }

  async run() {
    const lastSequence = this.journal.nextSequence() - 1;
    return {
      schemaVersion: "gardener.runner.terminal/v1" as const,
      status: "completed" as const,
      summary: "test session completed",
      lastServerSequence: lastSequence,
      lastCompletedSequence: lastSequence,
    };
  }

  async invoke(input: RunnerActionV1): Promise<RunnerActionResultV1> {
    const parsed = runnerActionV1Schema.parse(input);
    const registered = this.journal.register(parsed);
    if (registered.state === "completed" && registered.result) return registered.result;
    this.journal.claim(parsed.operationId);
    try {
      const result = runnerActionResultV1Schema.parse(await this.#runner.execute(parsed));
      return this.journal.complete(result).result!;
    } catch (error) {
      this.journal.markAmbiguous(parsed.operationId);
      throw error;
    }
  }

  async reconcile(input: RunnerActionResultV1): Promise<RunnerActionResultV1> {
    return this.journal.complete(runnerActionResultV1Schema.parse(input)).result!;
  }

  async resume(input: ResumeCursorV1, runner: RpcStub<RunnerCapability>): Promise<ResumeStateV1> {
    resumeCursorV1Schema.parse(input);
    this.#runner[Symbol.dispose]();
    this.#runner = runner.dup();
    for (const record of this.journal.unresolvedAfter(0)) {
      const result = await this.#runner.result(record.action.operationId);
      if (result) this.journal.complete(result);
    }
    return {
      schemaVersion: "gardener.runner.resume-state/v1",
      nextServerSequence: this.journal.nextSequence(),
      unresolvedOperationIds: this.journal
        .unresolvedAfter(0)
        .map((record) => record.action.operationId),
    };
  }

  [Symbol.dispose](): void {
    this.#runner[Symbol.dispose]();
  }
}

class TestPublicApi extends RpcTarget implements PublicSessionCapability {
  constructor(readonly journal: ActionJournal) {
    super();
  }

  async authenticate(input: RunnerHelloV1, oidcToken: string, runner: RpcStub<RunnerCapability>): Promise<TestSession> {
    runnerHelloV1Schema.parse(input);
    if (oidcToken !== "test-oidc-token") throw new Error("OIDC token rejected");
    return new TestSession(runner, this.journal);
  }
}

class ImmediateRunner extends RpcTarget implements RunnerCapability {
  readonly calls: RunnerActionV1[] = [];
  readonly results = new Map<string, RunnerActionResultV1>();

  async execute(input: RunnerActionV1): Promise<RunnerActionResultV1> {
    const parsed = runnerActionV1Schema.parse(input);
    this.calls.push(parsed);
    const result: RunnerActionResultV1 = {
      schemaVersion: "gardener.runner.action-result/v1",
      sequence: parsed.sequence,
      operationId: parsed.operationId,
      status: "completed",
      exitCode: 0,
      stdout: "gardener",
      stderr: "",
      outputTruncated: false,
    };
    this.results.set(parsed.operationId, result);
    return result;
  }

  async result(operationId: string): Promise<RunnerActionResultV1 | null> {
    return this.results.get(operationId) ?? null;
  }

  async cancel(): Promise<void> {}
}

class DeferredRunner extends RpcTarget implements RunnerCapability {
  readonly localResults = new Map<string, RunnerActionResultV1>();
  started: Promise<void>;
  #markStarted!: () => void;
  #release!: () => void;

  constructor() {
    super();
    this.started = new Promise((resolve) => {
      this.#markStarted = resolve;
    });
  }

  async execute(input: RunnerActionV1): Promise<RunnerActionResultV1> {
    const parsed = runnerActionV1Schema.parse(input);
    const result: RunnerActionResultV1 = {
      schemaVersion: "gardener.runner.action-result/v1",
      sequence: parsed.sequence,
      operationId: parsed.operationId,
      status: "completed",
      exitCode: 0,
      stdout: "completed-before-ack",
      stderr: "",
      outputTruncated: false,
    };
    this.localResults.set(parsed.operationId, result);
    this.#markStarted();
    await new Promise<void>((resolve) => {
      this.#release = resolve;
    });
    return result;
  }

  release(): void {
    this.#release();
  }

  async result(operationId: string): Promise<RunnerActionResultV1 | null> {
    return this.localResults.get(operationId) ?? null;
  }

  async cancel(): Promise<void> {}
}

interface TestServer {
  url: string;
  close(): Promise<void>;
}

const servers: TestServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("Cap'n Web runner session spike", () => {
  it("invokes a runner callback over a real WebSocket", async () => {
    const journal = new ActionJournal();
    const server = await startServer(journal);
    const root = newWebSocketRpcSession<PublicSessionCapability>(server.url);
    const runner = new ImmediateRunner();
    const session = root.authenticate(hello, "test-oidc-token", runner);

    await expect(session.invoke(action)).resolves.toMatchObject({ stdout: "gardener", exitCode: 0 });
    expect(runner.calls).toEqual([action]);
    expect(journal.get(action.operationId)?.state).toBe("completed");

    session[Symbol.dispose]();
    root[Symbol.dispose]();
  });

  it("reacquires capabilities and reconciles a local result after disconnect", async () => {
    const journal = new ActionJournal();
    const server = await startServer(journal);
    const firstRoot = newWebSocketRpcSession<PublicSessionCapability>(server.url);
    const runner = new DeferredRunner();
    const firstSession = firstRoot.authenticate(hello, "test-oidc-token", runner);
    const pending = Promise.resolve(firstSession.invoke(action));
    await runner.started;

    firstRoot[Symbol.dispose]();
    runner.release();
    await expect(pending).rejects.toBeDefined();
    await eventually(() => journal.get(action.operationId)?.state === "ambiguous");
    await expect(firstSession.invoke(action)).rejects.toBeDefined();

    const secondRoot = newWebSocketRpcSession<PublicSessionCapability>(server.url);
    const secondSession = secondRoot.authenticate(hello, "test-oidc-token", runner);
    const resume = await secondSession.resume({
      schemaVersion: "gardener.runner.cursor/v1",
      lastServerSequence: 1,
      lastCompletedSequence: 0,
    }, runner);
    expect(resume.unresolvedOperationIds).toEqual([]);
    expect(journal.get(action.operationId)).toMatchObject({
      state: "completed",
      result: runner.localResults.get(action.operationId),
    });

    secondSession[Symbol.dispose]();
    secondRoot[Symbol.dispose]();
  });
});

async function startServer(journal: ActionJournal): Promise<TestServer> {
  const httpServer = http.createServer((_request, response) => {
    response.writeHead(404).end();
  });
  const wsServer = new WebSocketServer({ server: httpServer, maxPayload: 1024 * 1024 });
  wsServer.on("connection", (socket) => {
    newWebSocketRpcSession(socket as unknown as WebSocket, new TestPublicApi(journal));
  });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind a TCP port");
  const server: TestServer = {
    url: `ws://127.0.0.1:${address.port}`,
    close: async () => {
      for (const client of wsServer.clients) client.terminate();
      await new Promise<void>((resolve) => wsServer.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
  servers.push(server);
  return server;
}

async function eventually(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Condition did not become true before timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
