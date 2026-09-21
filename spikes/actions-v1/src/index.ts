import { RpcTarget, newWorkersRpcResponse, type RpcStub } from "capnweb";
import { DurableObject } from "cloudflare:workers";
import {
  resumeCursorV1Schema,
  runnerActionResultV1Schema,
  runnerSessionId,
  runnerActionV1Schema,
  runnerHelloV1Schema,
  type AuthenticatedSessionCapability,
  type PublicSessionCapability,
  type ResumeCursorV1,
  type ResumeStateV1,
  type RunnerActionResultV1,
  type RunnerActionV1,
  type RunnerCapability,
  type RunnerEffectReceiptV1,
  type RunnerHelloV1,
  type RunnerTerminalV1,
} from "@gardener/protocol";
import { verifyGitHubActionsOidc } from "./github-oidc";

interface Env {
  SESSIONS: DurableObjectNamespace<SpikeSession>;
  GARDENER?: { fetch(request: Request): Promise<Response> };
  OIDC_MODE?: "github";
  OIDC_AUDIENCE?: string;
  ALLOWED_REPOSITORY_ID?: string;
  ALLOWED_OWNER_ID?: string;
  TRUSTED_JOB_WORKFLOW_REF?: string;
  EFFECTS_ENVIRONMENT?: string;
  SPIKE_COMMAND?: string;
}

interface StoredAction {
  canonicalAction: string;
  state: "running" | "ambiguous" | "completed";
  action: RunnerActionV1;
  result?: RunnerActionResultV1;
  canonicalResult?: string;
}

const ACTION_PREFIX = "action:";
const SESSION_PATH = /^\/session\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})$/;
const INVOKE_PATH = /^\/invoke\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})$/;
const STATE_PATH = /^\/state\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ ok: true, spike: "actions-v1" });
    const isSessionRoute = SESSION_PATH.test(url.pathname);
    const isLocalTestHost = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (isSessionRoute && env.GARDENER && !isLocalTestHost) return env.GARDENER.fetch(request);
    if (!isSessionRoute && !isLocalTestHost) return new Response("Not found", { status: 404 });
    const route = SESSION_PATH.exec(url.pathname) ?? INVOKE_PATH.exec(url.pathname) ?? STATE_PATH.exec(url.pathname);
    if (!route?.[1]) return new Response("Not found", { status: 404 });
    const stub = env.SESSIONS.get(env.SESSIONS.idFromName(route[1]));
    const forwarded = new URL(request.url);
    forwarded.pathname = isSessionRoute ? "/rpc" : INVOKE_PATH.test(url.pathname) ? "/invoke" : "/state";
    const forwardedRequest = new Request(forwarded, request);
    const headers = new Headers(forwardedRequest.headers);
    headers.set("x-gardener-session-id", route[1]);
    return stub.fetch(new Request(forwardedRequest, { headers }));
  },
} satisfies ExportedHandler<Env>;

export class SpikeSession extends DurableObject<Env> {
  #runner: RpcStub<RunnerCapability> | undefined;

  override fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/rpc") {
      return newWorkersRpcResponse(request, new PublicApi(
        this,
        this.env,
        new URL(request.url).origin,
        request.headers.get("x-gardener-session-id") ?? "",
      ), {
        limits: { maxDepth: 64, maxMessageSize: 1024 * 1024, maxBigIntDigits: 128 },
        onSendError: (error) => new Error(error.message),
      });
    }
    if (path === "/invoke" && request.method === "POST") return this.#invokeFromHttp(request);
    if (path === "/state" && request.method === "GET") return this.#stateResponse();
    return Promise.resolve(new Response("Not found", { status: 404 }));
  }

  async consumeOidcToken(jti: string): Promise<void> {
    const key = `oidc:${jti}`;
    await this.ctx.storage.transaction(async (transaction) => {
      if (await transaction.get(key)) throw new Error("OIDC token was already used");
      await transaction.put(key, true);
    });
  }

  attachRunner(runner: RpcStub<RunnerCapability>): void {
    this.#runner?.[Symbol.dispose]();
    this.#runner = runner.dup();
  }

  async storedAction(operationId: string): Promise<RunnerActionV1 | undefined> {
    return (await this.ctx.storage.get<StoredAction>(`${ACTION_PREFIX}${operationId}`))?.action;
  }

  async invoke(input: RunnerActionV1): Promise<RunnerActionResultV1> {
    const action = runnerActionV1Schema.parse(input);
    const key = `${ACTION_PREFIX}${action.operationId}`;
    const canonicalAction = canonicalValue(action);
    const existing = await this.ctx.storage.get<StoredAction>(key);
    if (existing) {
      if (existing.canonicalAction !== canonicalAction) throw new Error("Operation ID conflict");
      if (existing.state === "completed" && existing.result) return existing.result;
      throw new Error(existing.state === "ambiguous" ? "Action outcome is ambiguous" : "Action is already running");
    }
    if (!this.#runner) throw new Error("No authenticated runner is connected");
    await this.ctx.storage.put<StoredAction>(key, { canonicalAction, state: "running", action });
    try {
      const result = runnerActionResultV1Schema.parse(await this.#runner.execute(action));
      return await this.reconcile(result);
    } catch (cause) {
      await this.ctx.storage.put<StoredAction>(key, { canonicalAction, state: "ambiguous", action });
      throw new Error("Runner action did not produce a durable result", { cause });
    }
  }

  async reconcile(input: RunnerActionResultV1): Promise<RunnerActionResultV1> {
    const result = runnerActionResultV1Schema.parse(input);
    const key = `${ACTION_PREFIX}${result.operationId}`;
    const existing = await this.ctx.storage.get<StoredAction>(key);
    if (!existing) throw new Error("Unknown operation result");
    if (existing.action.sequence !== result.sequence) throw new Error("Operation sequence mismatch");
    const outputBytes = new TextEncoder().encode(result.stdout).byteLength + new TextEncoder().encode(result.stderr).byteLength;
    if (outputBytes > existing.action.maxOutputBytes) throw new Error("Operation output exceeds its byte limit");
    const canonicalResult = canonicalValue(result);
    if (existing.state === "completed") {
      if (existing.canonicalResult !== canonicalResult) throw new Error("Operation result conflict");
      return existing.result!;
    }
    const completed: StoredAction = {
      ...existing,
      state: "completed",
      result,
      canonicalResult,
    };
    await this.ctx.storage.put(key, completed);
    return result;
  }

  async resume(input: ResumeCursorV1, runner: RpcStub<RunnerCapability>): Promise<ResumeStateV1> {
    const cursor = resumeCursorV1Schema.parse(input);
    this.attachRunner(runner);
    let actions = await this.ctx.storage.list<StoredAction>({ prefix: ACTION_PREFIX });
    for (const record of actions.values()) {
      if (record.state === "completed") continue;
      const localResult = await runner.result(record.action.operationId);
      if (localResult) await this.reconcile(localResult);
    }
    actions = await this.ctx.storage.list<StoredAction>({ prefix: ACTION_PREFIX });
    const unresolved = [...actions.values()]
      .filter((record) => record.state !== "completed")
      .sort((left, right) => left.action.sequence - right.action.sequence);
    const nextServerSequence = Math.max(0, ...[...actions.values()].map((record) => record.action.sequence)) + 1;
    if (cursor.lastServerSequence >= nextServerSequence) throw new Error("Resume cursor is ahead of the server");
    return {
      schemaVersion: "gardener.runner.resume-state/v1",
      nextServerSequence,
      unresolvedOperationIds: unresolved.map((record) => record.action.operationId),
    };
  }

  async #invokeFromHttp(request: Request): Promise<Response> {
    try {
      return Response.json(await this.invoke(await request.json() as RunnerActionV1));
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : "Unknown error" }, { status: 409 });
    }
  }

  async #stateResponse(): Promise<Response> {
    const actions = await this.ctx.storage.list<StoredAction>({ prefix: ACTION_PREFIX });
    return Response.json([...actions.values()].map((record) => ({
      operationId: record.action.operationId,
      sequence: record.action.sequence,
      state: record.state,
      result: record.result ?? null,
    })));
  }
}

class PublicApi extends RpcTarget implements PublicSessionCapability {
  constructor(
    readonly session: SpikeSession,
    readonly env: Env,
    readonly requestOrigin: string,
    readonly routedSessionId: string,
  ) {
    super();
  }

  async authenticate(input: RunnerHelloV1, oidcToken: string, runner: RpcStub<RunnerCapability>): Promise<AuthenticatedApi> {
    const hello = runnerHelloV1Schema.parse(input);
    if (this.routedSessionId !== runnerSessionId(hello)) {
      throw new Error("Runner identity does not match the routed durable session");
    }
    if (this.env.OIDC_MODE === "github") {
      const identity = await verifyGitHubActionsOidc(oidcToken, hello, {
        audience: requiredSetting(this.env.OIDC_AUDIENCE, "OIDC_AUDIENCE"),
        repositoryId: requiredSetting(this.env.ALLOWED_REPOSITORY_ID, "ALLOWED_REPOSITORY_ID"),
        ownerId: requiredSetting(this.env.ALLOWED_OWNER_ID, "ALLOWED_OWNER_ID"),
        jobWorkflowRef: requiredSetting(this.env.TRUSTED_JOB_WORKFLOW_REF, "TRUSTED_JOB_WORKFLOW_REF"),
        ...(this.env.EFFECTS_ENVIRONMENT ? { effectsEnvironment: this.env.EFFECTS_ENVIRONMENT } : {}),
      });
      await this.session.consumeOidcToken(identity.jti);
    } else {
      const host = new URL(this.requestOrigin).hostname;
      if (host !== "localhost" && host !== "127.0.0.1") throw new Error("Fake OIDC mode is local-only");
      if (oidcToken.length > 16 * 1024 || oidcToken.split(".").length !== 3) throw new Error("OIDC token was rejected");
    }
    this.session.attachRunner(runner);
    return new AuthenticatedApi(this.session, this.env);
  }
}

class AuthenticatedApi extends RpcTarget implements AuthenticatedSessionCapability {
  constructor(
    readonly session: SpikeSession,
    readonly env: Env,
  ) {
    super();
  }

  async run(): Promise<RunnerTerminalV1> {
    const operationId = "spike-run-command";
    const action = await this.session.storedAction(operationId) ?? {
      schemaVersion: "gardener.runner.action/v1" as const,
      sequence: 1,
      operationId,
      kind: "shell.exec" as const,
      command: this.env.SPIKE_COMMAND ?? "test -z \"${GITHUB_TOKEN-}\" && test -z \"${ACTIONS_ID_TOKEN_REQUEST_TOKEN-}\" && printf 'github-actions-capnweb-ok'",
      cwd: "/workspace",
      timeoutMs: 30_000,
      maxOutputBytes: 64 * 1024,
    };
    const result = await this.session.invoke(action);
    return {
      schemaVersion: "gardener.runner.terminal/v1",
      status: result.status === "completed" ? "completed" : "failed",
      summary: boundedSummary(result.stdout || result.stderr || result.status),
      lastServerSequence: 1,
      lastCompletedSequence: 1,
    };
  }

  cancelRun(_reason: string): Promise<void> {
    return Promise.resolve();
  }

  invoke(input: RunnerActionV1): Promise<RunnerActionResultV1> {
    return this.session.invoke(input);
  }

  reconcile(input: RunnerActionResultV1): Promise<RunnerActionResultV1> {
    return this.session.reconcile(input);
  }

  resume(input: ResumeCursorV1, runner: RpcStub<RunnerCapability>): Promise<ResumeStateV1> {
    return this.session.resume(input, runner);
  }

  recordEffect(_receipt: RunnerEffectReceiptV1): Promise<RunnerEffectReceiptV1> {
    return Promise.reject(new Error("The transport spike does not accept product effect receipts"));
  }
}

function boundedSummary(value: string): string {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength <= 16 * 1024) return value;
  return new TextDecoder().decode(bytes.slice(0, 16 * 1024));
}

function requiredSetting(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required in GitHub OIDC mode`);
  return value;
}

function canonicalValue(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalValue(record[key])}`).join(",")}}`;
}
