/**
 * Pure checks the task runner session applies at its trust boundary.
 *
 * Relocated verbatim from `session.ts`, which imports `cloudflare:workers` and
 * so cannot be loaded under vitest. Durable Object storage access stays in the
 * session; the decisions it makes over stored values live here so they can be
 * tested directly. Nothing here may grow behaviour the session does not have.
 *
 * The storage keys below are exported for those tests and for the session's
 * own reads; only the session writes them, through its Durable Object storage.
 */
import {
  runnerActionV1Schema,
  type RunnerActionV1,
  type RunnerHelloV1,
} from "@gardener/protocol";
import {
  eventHeadIsSameRepository,
  eventNameByTriggerKind,
  maintainerAssociations,
  maintainerPermissions,
  starterSubject,
  type AuthorPermissionV1,
  type NormalizedEventV1,
  type TaskRunRequestV1,
  type TaskRunStarterV1,
} from "@gardener/contracts";
import type { HarnessToolInvocation } from "../harness";
import { taskToolInputKeys } from "./tool-input-schemas";
import { listFilesPath, repositoryPath } from "./repository-paths";

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export const OIDC_PREFIX = "oidc:";
/**
 * Trusted repository capture admitted for this run.
 *
 * No planning path writes it, so a step that defers its contents to a capture
 * fails closed. Capture admission supplies it; planning never invents one.
 */
export const CAPTURE_KEY = "effect-capture";
export const CAPTURE_PENDING_KEY = "effect-capture-pending";
/** Incremented only after a terminal, non-captured attempt is released. */
export const CAPTURE_GENERATION_KEY = "effect-capture-generation";

export interface CapturePending {
  operationId: string;
  runId: string;
  generation: number;
}

/** The slice of a Durable Object storage transaction these checks read and write. */
export interface SessionCheckStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}

/** Records an OIDC token's `jti` once; a second use of the same token is refused. */
export async function consumeOidcTokenIn(transaction: SessionCheckStorage, jti: string, expiresAt: number): Promise<void> {
  const key = `${OIDC_PREFIX}${jti}`;
  if (await transaction.get(key)) throw new Error("OIDC token was already used");
  await transaction.put(key, expiresAt);
}

/**
 * Refuses once a working tree capture is pending or admitted. Read inside the
 * transaction that would admit the new proposal or action.
 */
export async function assertCaptureNotStarted(transaction: Pick<SessionCheckStorage, "get">, message: string): Promise<void> {
  if (await transaction.get(CAPTURE_PENDING_KEY) || await transaction.get(CAPTURE_KEY)) {
    throw new Error(message);
  }
}

/** Decides whether this capture attempt may mark itself pending. */
export function assertCaptureAdmissible(
  currentGeneration: number,
  generation: number,
  pending: CapturePending | undefined,
  operationId: string,
): void {
  if (currentGeneration !== generation) throw new Error("Repository capture generation changed; retry capture admission");
  if (pending && pending.operationId !== operationId) throw new Error("Repository capture admission conflict");
}

/** A run captures the working tree exactly once, for exactly one consuming step. */
export function assertSingleCaptureConsumer(consumers: readonly { stepName: string }[]): void {
  if (consumers.length === 0) {
    throw new Error("No step materializes repository changes, so there is nothing to capture");
  }
  if (consumers.length > 1) {
    throw new Error(
      `Steps ${consumers.map((step) => step.stepName).join(", ")} each materialize repository changes, `
      + "but a run captures the working tree once",
    );
  }
}

/**
 * The capture is issued by the runtime, never requested. Accepting one
 * here would let a runner decide when the working tree is photographed,
 * which is the single decision this whole boundary exists to keep away
 * from anything the task can influence.
 */
export function assertRunnerMayRequest(action: RunnerActionV1): void {
  if (action.kind === "repository.capture") {
    throw new Error("Repository capture cannot be requested by the runner");
  }
}

/**
 * The payload is untrusted. Its kind must agree with the event name GitHub
 * signed into the OIDC claims, so a caller cannot present a discussion
 * payload for an issues run and reach a trigger it was not granted.
 */
export function assertReportedEventMatchesOidc(kind: keyof typeof eventNameByTriggerKind, eventName: string): void {
  if (eventNameByTriggerKind[kind] !== eventName) {
    throw new Error(
      `Reported event ${kind} does not match the ${eventName} event in the verified OIDC claims`,
    );
  }
}

/** What `trustedStarter` decides from: the signed OIDC identity and the admitted event. */
export interface StarterEvidence {
  /** The event name GitHub signed into the OIDC token. */
  readonly eventName: string;
  /** The OIDC `actor_id` and `actor`, also signed. */
  readonly actor: { readonly id: string; readonly login: string };
  /** The normalized event, whose kind already agrees with `eventName`. */
  readonly event: NormalizedEventV1;
  /**
   * The actor's permission, when the bridge looked it up, with the id of the
   * actor it describes. Absent fails closed, and so does an id that is not
   * the signed actor's: it would be someone else's permission.
   */
  readonly actorPermission?: { readonly actorId: string; readonly permission: AuthorPermissionV1 } | undefined;
}

const isBot = (login: string): boolean => login.endsWith("[bot]");

/**
 * Whether the person (or thing) that started this run is trusted, decided once
 * at admission and frozen in the request. Trusted runs may act anywhere their
 * declared effects allow; every other run is confined to what triggered it.
 *
 * 1. A schedule or manual run is trusted: dispatching needs write access.
 * 2. A push, or a `synchronize` whose head is in this repository, by anyone
 *    but a bot: producing it needed a push here. A bot is untrusted on
 *    purpose, because Dependabot's commits carry upstream release notes.
 * 3. The subject's own author, when they count as a maintainer exactly as
 *    `authors: maintainers` counts them, and are not a bot.
 * 4. Someone acting on another's subject (the labeller, say), with write or
 *    admin permission as the bridge looked it up.
 *
 * Everything else is untrusted, including a lookup that failed or never
 * happened, because failing closed only narrows what the run may do.
 */
export function trustedStarter(evidence: StarterEvidence): TaskRunStarterV1 {
  const { eventName, actor, event } = evidence;
  if (eventName === "schedule") return { trusted: true, reason: "schedule" };
  if (eventName === "workflow_dispatch") return { trusted: true, reason: "manual" };
  if (isBot(actor.login)) return { trusted: false, reason: "bot" };
  if (eventName === "push") return { trusted: true, reason: "push" };
  if (event.kind === "github.pull_request.synchronize") {
    // Checked here, before the decision is frozen, rather than trusting the
    // generated workflow's fork guard or the later re-check.
    return eventHeadIsSameRepository(event)
      ? { trusted: true, reason: "synchronize" }
      : { trusted: false, reason: "fork_head" };
  }
  const key = (starterSubject as Record<string, string | undefined>)[event.kind];
  const value = key === undefined ? undefined : (event as Record<string, unknown>)[key];
  if (value === null || typeof value !== "object") return { trusted: false, reason: "actor_unknown" };
  const subject = value as {
    author: { id: string; login: string };
    authorAssociation?: string;
    authorPermission?: string;
  };
  if (subject.author.id === actor.id) {
    if (isBot(subject.author.login)) return { trusted: false, reason: "bot" };
    const maintainer = (subject.authorAssociation !== undefined
      && (maintainerAssociations as readonly string[]).includes(subject.authorAssociation))
      || (subject.authorPermission !== undefined
        && (maintainerPermissions as readonly string[]).includes(subject.authorPermission));
    return maintainer ? { trusted: true, reason: "maintainer_author" } : { trusted: false, reason: "author_not_maintainer" };
  }
  const looked = evidence.actorPermission;
  if (looked === undefined || looked.actorId !== actor.id) return { trusted: false, reason: "actor_unknown" };
  return (maintainerPermissions as readonly string[]).includes(looked.permission)
    ? { trusted: true, reason: "maintainer_actor" }
    : { trusted: false, reason: "actor_not_maintainer" };
}

/** An effects session applies only the plan its own workflow run and attempt produced. */
export function assertEffectPlanBoundToHello(request: TaskRunRequestV1, hello: RunnerHelloV1): void {
  const original = request.event;
  if (original.workflow.runId !== hello.runId
    || original.workflow.runAttempt > hello.runAttempt
    || original.repository.id !== hello.repositoryId
    || original.repository.commitSha !== hello.commitSha
    || original.workflow.workflowRef !== hello.workflowRef
    || original.workflow.eventName !== hello.eventName
    || request.bundleHash !== hello.agentHash) {
    throw new Error("Effect plan is not bound to this repository workflow run and attempt");
  }
}

export function toolAction(sequence: number, operationId: string, invocation: HarnessToolInvocation): RunnerActionV1 {
  const input = invocation.input;
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new Error("Repository tool input must be an object");
  const value = input as Record<string, JsonValue>;
  if (invocation.toolName === "provider_api_read") return providerReadAction(sequence, operationId, value);
  if (invocation.toolName === "repository_merge_base") {
    // No field at all: the runner writes the merge it prepared before the
    // session, so there is nothing for the model to choose.
    exactKeys(value, taskToolInputKeys("repository_merge_base"));
    // Writing a large merge runs the repository's filters over every changed
    // file, so it gets more time than a default command.
    return runnerActionV1Schema.parse({
      schemaVersion: "gardener.runner.action/v1", sequence, operationId, kind: "repository.merge_base", timeoutMs: 5 * 60_000,
    });
  }
  let command: string;
  let cwd = "/workspace";
  let timeoutMs = 30_000;
  let maxOutputBytes = 256 * 1_024;
  if (invocation.toolName === "repository_read_file") {
    exactKeys(value, taskToolInputKeys("repository_read_file"));
    const path = repositoryPath(value.path);
    command = `python3 -c 'import pathlib,sys; root=pathlib.Path.cwd().resolve(); target=pathlib.Path(sys.argv[1]).resolve(); target.relative_to(root); print(target.read_text(encoding="utf-8"), end="")' ${shellQuote(path)}`;
  } else if (invocation.toolName === "repository_list_files") {
    exactKeys(value, taskToolInputKeys("repository_list_files"), true);
    const path = listFilesPath(value.path);
    const maxEntries = integer(value.maxEntries ?? 1_000, 1, 10_000, "maxEntries");
    command = `git ls-files --cached --others --exclude-standard -- ${shellQuote(path)} | sed -n '1,${maxEntries}p'`;
  } else if (invocation.toolName === "repository_exec") {
    exactKeys(value, taskToolInputKeys("repository_exec"), true);
    if (typeof value.command !== "string" || value.command.length < 1 || value.command.length > 64 * 1_024) throw new Error("Invalid repository command");
    command = value.command;
    if (value.cwd !== undefined) cwd = `/workspace/${repositoryPath(value.cwd)}`.replace(/\/$/, "");
    if (value.timeoutMs !== undefined) timeoutMs = integer(value.timeoutMs, 1, 10 * 60_000, "timeoutMs");
    if (value.maxOutputBytes !== undefined) maxOutputBytes = integer(value.maxOutputBytes, 1, 4 * 1_024 * 1_024, "maxOutputBytes");
  } else {
    throw new Error("Unknown repository tool");
  }
  return runnerActionV1Schema.parse({ schemaVersion: "gardener.runner.action/v1", sequence, operationId, kind: "shell.exec", command, cwd, timeoutMs, maxOutputBytes });
}

/** Matches the bridge-side `maxVariablesBytes` limit in `github-read.ts`. */
export const MAX_GRAPHQL_VARIABLES_BYTES = 32 * 1_024;
export const MAX_GRAPHQL_VARIABLES = 64;

/**
 * Builds the read-only provider action. Only GET/HEAD REST reads and GraphQL
 * query documents are representable; the bridge enforces the same rules again
 * before any request leaves the runner.
 */
export function providerReadAction(sequence: number, operationId: string, value: Record<string, JsonValue>): RunnerActionV1 {
  exactKeys(value, taskToolInputKeys("provider_api_read"), true);
  const timeoutMs = value.timeoutMs === undefined ? 30_000 : integer(value.timeoutMs, 1, 10 * 60_000, "timeoutMs");
  const maxOutputBytes = value.maxOutputBytes === undefined
    ? 256 * 1_024
    : integer(value.maxOutputBytes, 1, 1_024 * 1_024, "maxOutputBytes");
  const transport = value.transport ?? "rest";
  let request: JsonValue;
  if (transport === "rest") {
    if (value.query !== undefined || value.variables !== undefined || value.operationName !== undefined) {
      throw new Error("REST provider reads cannot carry GraphQL fields");
    }
    const method = value.method === undefined ? "GET" : value.method;
    if (method !== "GET" && method !== "HEAD") throw new Error("The provider read tool permits only GET and HEAD");
    if (typeof value.path !== "string" || value.path.length < 1 || value.path.length > 2_048) {
      throw new Error("Invalid provider read path");
    }
    request = { transport: "rest", method, path: value.path };
  } else if (transport === "graphql") {
    if (value.method !== undefined || value.path !== undefined) {
      throw new Error("GraphQL provider reads cannot carry REST fields");
    }
    if (typeof value.query !== "string" || value.query.length < 1 || value.query.length > 32 * 1_024) {
      throw new Error("Invalid provider read query");
    }
    const graphql: Record<string, JsonValue> = { transport: "graphql", query: value.query };
    if (value.variables !== undefined) {
      if (value.variables === null || typeof value.variables !== "object" || Array.isArray(value.variables)) {
        throw new Error("Provider read variables must be an object");
      }
      // Bound before the action is canonicalized into durable storage, so a
      // model cannot grow the Durable Object record with arbitrary payloads.
      const serialized = JSON.stringify(value.variables);
      if (serialized === undefined || new TextEncoder().encode(serialized).byteLength > MAX_GRAPHQL_VARIABLES_BYTES) {
        throw new Error("Provider read variables exceed the size limit");
      }
      if (Object.keys(value.variables).length > MAX_GRAPHQL_VARIABLES) {
        throw new Error("Provider read variables exceed the count limit");
      }
      graphql.variables = value.variables;
    }
    if (value.operationName !== undefined) {
      if (typeof value.operationName !== "string") throw new Error("Invalid provider read operationName");
      graphql.operationName = value.operationName;
    }
    request = graphql;
  } else {
    throw new Error("Provider read transport must be rest or graphql");
  }
  return runnerActionV1Schema.parse({
    schemaVersion: "gardener.runner.action/v1",
    sequence,
    operationId,
    kind: "github.read",
    request,
    timeoutMs,
    maxOutputBytes,
  });
}

export function exactKeys(value: Record<string, JsonValue>, allowed: readonly string[], optional = false): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`Unknown repository tool input ${key}`);
  if (!optional) for (const key of allowed) if (!(key in value)) throw new Error(`Missing repository tool input ${key}`);
}

export function integer(value: JsonValue, min: number, max: number, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
  return value;
}

export function shellQuote(value: string): string { return `'${value.replaceAll("'", `'"'"'`)}'`; }
