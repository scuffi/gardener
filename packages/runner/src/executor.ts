import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  runnerActionV1Schema,
  runnerCaptureResultV1Schema,
  type RunnerActionResultV1,
  type RunnerActionV1,
  type RunnerCaptureActionV1,
  type RunnerCaptureResultV1,
  type RunnerGitHubReadActionV1,
  type RunnerShellActionV1,
} from "@gardener/protocol";
import type { TaskCaptureRefV1 } from "@gardener/contracts";
import { WorkingTreeCapture, verifyCaptureArtifact } from "./capture";
import type { GitHubReadClient } from "./github-read";

interface LocalRecord {
  canonicalAction: string;
  result?: RunnerActionResultV1;
  promise?: Promise<RunnerActionResultV1>;
}

/**
 * Whether this run can capture a working tree, decided *before* the executor
 * exists.
 *
 * Modelled as a value rather than a nullable field so the failure is carried
 * with its reason instead of being indistinguishable from "not asked for".
 * There is deliberately no setter: a baseline installed after the first task
 * command would be a baseline the model helped choose, so the only way to get
 * a capture-capable executor is to hand one to the constructor.
 */
export type PlanningCaptureAvailability =
  | { status: "ready"; capture: WorkingTreeCapture }
  | { status: "unavailable"; reason: string };

/** Verified capture the runner holds locally. The directory never leaves this process. */
export interface LocalCaptureArtifact {
  directory: string;
  ref: TaskCaptureRefV1;
}

export interface PlanningExecutorOptions {
  /**
   * Builds a read client bound to this action's abort signal and output
   * budget. `maxResponseBytes` is derived per action so a small
   * `maxOutputBytes` cannot pull a megabyte off the wire before truncation.
   *
   * The repository-scoped token stays captured in the bridge process; it never
   * enters the shell environment, the runtime, or the model.
   */
  createReadClient?: (signal: AbortSignal, maxResponseBytes: number) => GitHubReadClient;
  /**
   * Pre-execution capture baseline, or the reason there is none. Omitting it
   * fails capture closed rather than capturing against an unknown baseline.
   */
  capture?: PlanningCaptureAvailability;
}

export interface CreatePlanningExecutorOptions extends PlanningExecutorOptions {
  workspace: string;
  /** `RUNNER_TEMP`. Absent means no capture is possible on this runner. */
  runnerTemp?: string | undefined;
  /** `GITHUB_SHA`. Absent means nothing can bind a capture to a commit. */
  baseSha?: string | undefined;
}

/**
 * Builds a planning executor with its capture baseline already taken.
 *
 * This ordering is the whole point. `WorkingTreeCapture.initialize` digests
 * the index, the effective Git configuration, the exclude file, and every
 * attributes file, and the executor — the only thing that can run a task
 * command — does not exist until that has happened. A baseline taken later
 * would be taken through whatever Git state the model had already arranged.
 *
 * Initialization failure is recorded, not thrown. A task that never commits
 * must still run on a checkout that cannot be captured, and a task that does
 * commit gets the recorded reason back as an explicit capture failure that
 * fails its plan closed.
 */
export async function createPlanningExecutor(
  options: CreatePlanningExecutorOptions,
): Promise<PlanningShellExecutor> {
  const { workspace, runnerTemp, baseSha, ...rest } = options;
  return new PlanningShellExecutor(workspace, {
    ...rest,
    capture: await captureAvailability(workspace, runnerTemp, baseSha),
  });
}

async function captureAvailability(
  workspace: string,
  runnerTemp: string | undefined,
  baseSha: string | undefined,
): Promise<PlanningCaptureAvailability> {
  if (!workspace) return { status: "unavailable", reason: "GITHUB_WORKSPACE is required to capture repository changes" };
  if (!runnerTemp) return { status: "unavailable", reason: "RUNNER_TEMP is required to capture repository changes" };
  if (!baseSha) return { status: "unavailable", reason: "GITHUB_SHA is required to bind a repository capture to a commit" };
  try {
    return { status: "ready", capture: await WorkingTreeCapture.initialize({ workspace, runnerTemp, baseSha }) };
  } catch (error) {
    return { status: "unavailable", reason: redactCaptureDiagnostic(captureMessage(error), workspace, runnerTemp) };
  }
}

export class PlanningShellExecutor {
  readonly #workspace: string;
  readonly #records = new Map<string, LocalRecord>();
  readonly #active = new Map<string, ChildProcess>();
  readonly #activeReads = new Map<string, AbortController>();
  readonly #cancelled = new Set<string>();
  readonly #createReadClient: ((signal: AbortSignal, maxResponseBytes: number) => GitHubReadClient) | undefined;
  readonly #capture: PlanningCaptureAvailability;
  /** Memoized so one run captures exactly once, whatever the runtime asks. */
  #capturePromise: Promise<RunnerCaptureResultV1> | undefined;
  #captureArtifact: LocalCaptureArtifact | undefined;

  constructor(workspace = requiredEnvironment("GITHUB_WORKSPACE"), options: PlanningExecutorOptions = {}) {
    this.#workspace = path.resolve(workspace);
    this.#createReadClient = options.createReadClient;
    this.#capture = options.capture
      ?? { status: "unavailable", reason: "This run took no pre-execution capture baseline" };
  }

  /**
   * The verified capture this run produced, if any.
   *
   * Runner-process only: the directory is local state the bridge uploads after
   * planning succeeds, and it is never returned to the runtime or the model.
   */
  captureArtifact(): LocalCaptureArtifact | undefined {
    return this.#captureArtifact;
  }

  /**
   * Re-proves the local artifact is still the capture the plan was built from.
   *
   * The artifact lives on a filesystem the model could write, so the binding
   * that matters is the plan-bound changes digest, which came back through the
   * runtime out of the model's reach. Call this immediately before publishing
   * the artifact to anything.
   */
  async verifiedCaptureArtifact(planChangesSha256: string): Promise<LocalCaptureArtifact> {
    const artifact = this.#captureArtifact;
    if (!artifact) throw new Error("The plan binds a repository capture this runner did not produce");
    if (artifact.ref.changesSha256 !== planChangesSha256) {
      throw new Error("The plan binds a different repository capture than this runner produced");
    }
    await verifyCaptureArtifact(artifact.directory, artifact.ref);
    return artifact;
  }

  async execute(input: RunnerActionV1): Promise<RunnerActionResultV1> {
    const action = runnerActionV1Schema.parse(input);
    const canonicalAction = canonicalValue(action);
    const existing = this.#records.get(action.operationId);
    if (existing) {
      if (existing.canonicalAction !== canonicalAction) throw new Error("Operation ID was reused for different shell input");
      if (existing.result) return existing.result;
      if (existing.promise) return existing.promise;
    }
    const record: LocalRecord = { canonicalAction };
    const promise = this.#run(action).then((result) => {
      record.result = result;
      delete record.promise;
      return result;
    }).catch((error) => {
      this.#records.delete(action.operationId);
      throw error;
    });
    record.promise = promise;
    this.#records.set(action.operationId, record);
    return promise;
  }

  async cancel(operationId: string): Promise<void> {
    const read = this.#activeReads.get(operationId);
    if (read) {
      this.#cancelled.add(operationId);
      read.abort(new Error("Gardener cancelled the provider read"));
      return;
    }
    const child = this.#active.get(operationId);
    if (!child?.pid) return;
    this.#cancelled.add(operationId);
    killProcessGroup(child.pid, "SIGTERM");
    const timer = setTimeout(() => {
      if (this.#active.has(operationId)) killProcessGroup(child.pid!, "SIGKILL");
    }, 2_000);
    timer.unref();
  }

  async result(operationId: string): Promise<RunnerActionResultV1 | undefined> {
    const record = this.#records.get(operationId);
    if (record?.result) return record.result;
    return record?.promise;
  }

  cursor(): { lastServerSequence: number; lastCompletedSequence: number } {
    const completed = [...this.#records.values()]
      .map((record) => record.result?.sequence ?? 0);
    const sequence = Math.max(0, ...completed);
    return { lastServerSequence: sequence, lastCompletedSequence: sequence };
  }

  async #run(action: RunnerActionV1): Promise<RunnerActionResultV1> {
    if (action.kind === "github.read") return this.#runRead(action);
    if (action.kind === "repository.capture") return this.#runCapture(action);
    return this.#runShell(action);
  }

  /**
   * Serves the trusted capture action.
   *
   * Capture happens at most once per run, memoized here rather than left to
   * the caller: the durable action journal already makes one operation id
   * idempotent, and this closes the remaining gap where two distinct ids would
   * otherwise photograph the tree twice and disagree.
   *
   * Every failure is returned as a failed action result, never as a fabricated
   * capture. A plan that needed one then fails closed in the runtime, which is
   * the only safe outcome: committing an uncaptured tree is exactly what this
   * boundary exists to prevent.
   */
  async #runCapture(action: RunnerCaptureActionV1): Promise<RunnerActionResultV1> {
    if (this.#capture.status !== "ready") return captureResult(action, "failed", 1, "", this.#capture.reason);
    if (this.#capture.capture.baseSha !== action.baseSha) {
      return captureResult(
        action,
        "failed",
        1,
        "",
        `Capture baseline is bound to ${this.#capture.capture.baseSha} but the runtime asked for ${action.baseSha}`,
      );
    }
    let envelope: RunnerCaptureResultV1;
    try {
      this.#capturePromise ??= this.#performCapture(this.#capture.capture);
      envelope = await this.#capturePromise;
    } catch (error) {
      // Leave the memo cleared so a retried capture can succeed once the cause
      // is gone; a failure must never become a permanently cached answer.
      this.#capturePromise = undefined;
      this.#captureArtifact = undefined;
      return captureResult(action, "failed", 1, "", redactCaptureDiagnostic(captureMessage(error), this.#workspace));
    }
    const stdout = JSON.stringify(envelope);
    if (envelope.status !== "captured" || Buffer.byteLength(stdout, "utf8") > action.maxOutputBytes) {
      // `unchanged` and transport-budget failures are repairable. Keeping the
      // resolved promise would make the next durable capture generation replay
      // the old answer even after repository.exec changed the tree.
      this.#capturePromise = undefined;
      this.#captureArtifact = undefined;
    }
    if (Buffer.byteLength(stdout, "utf8") > action.maxOutputBytes) {
      return captureResult(
        action,
        "failed",
        1,
        "",
        "The capture manifest is larger than the runtime's transport budget; the change set is too large to plan",
      );
    }
    return captureResult(action, "completed", 0, stdout, "");
  }

  /** Captures once and proves the artifact before its reference leaves the runner. */
  async #performCapture(capture: WorkingTreeCapture): Promise<RunnerCaptureResultV1> {
    const result = await capture.capture();
    if (result.status === "unchanged") {
      return { schemaVersion: "gardener.runner.capture-result/v1", status: "unchanged" };
    }
    // Verified here, immediately, rather than trusted from `capture()`. The
    // canonical manifest bytes are then read straight off the artifact, so the
    // text the runtime digests is the same text `manifestSha256` covers.
    const { ref, manifest } = await verifyCaptureArtifact(result.directory, result.ref);
    const manifestJson = await readFile(path.join(result.directory, "manifest.json"), "utf8");
    this.#captureArtifact = { directory: result.directory, ref };
    return runnerCaptureResultV1Schema.parse({
      schemaVersion: "gardener.runner.capture-result/v1",
      status: "captured",
      ref: { ...ref, fileCount: manifest.files.length },
      manifestJson,
    });
  }

  /**
   * Reads reuse the same durable operation record, cancellation, and reconnect
   * machinery as shell actions so replay and reconciliation stay identical.
   */
  async #runRead(action: RunnerGitHubReadActionV1): Promise<RunnerActionResultV1> {
    if (!this.#createReadClient) {
      return readResult(action, "failed", 1, "", "The read-only provider API is not configured for this run", false);
    }
    const controller = new AbortController();
    this.#activeReads.set(action.operationId, controller);
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error("Provider read exceeded its timeout"));
    }, action.timeoutMs);
    timeout.unref?.();
    try {
      const client = this.#createReadClient(controller.signal, action.maxOutputBytes);
      const request = action.request;
      const result = request.transport === "rest"
        ? await client.rest({ path: request.path, method: request.method })
        : await client.graphql({
          query: request.query,
          ...(request.variables === undefined ? {} : { variables: request.variables }),
          ...(request.operationName === undefined ? {} : { operationName: request.operationName }),
        });
      const bounded = boundedReadPayload(result, action.maxOutputBytes);
      if (bounded === undefined) {
        // The budget cannot hold even a minimal JSON envelope. Fail explicitly
        // rather than return output the model cannot parse.
        return readResult(action, "failed", 1, "", "Provider read output budget is too small to return a response", true);
      }
      return readResult(action, "completed", 0, bounded.stdout, "", bounded.outputTruncated);
    } catch (error) {
      if (timedOut) return readResult(action, "timed_out", null, "", "Provider read exceeded its timeout", false);
      if (this.#cancelled.has(action.operationId)) {
        return readResult(action, "cancelled", null, "", "Provider read was cancelled", false);
      }
      return readResult(action, "failed", 1, "", redactedReadError(error), false);
    } finally {
      clearTimeout(timeout);
      this.#activeReads.delete(action.operationId);
      this.#cancelled.delete(action.operationId);
    }
  }

  async #runShell(action: RunnerShellActionV1): Promise<RunnerActionResultV1> {
    if (this.#capturePromise || this.#captureArtifact) {
      return {
        schemaVersion: "gardener.runner.action-result/v1",
        sequence: action.sequence,
        operationId: action.operationId,
        status: "failed",
        exitCode: 1,
        stdout: "",
        stderr: "The working tree capture has started; no later shell command may run",
        outputTruncated: false,
      };
    }
    const cwd = localWorkspacePath(this.#workspace, action.cwd);
    const home = path.join(this.#workspace, ".gardener", "runner-home");
    await mkdir(home, { recursive: true, mode: 0o700 });
    const child = spawn("/bin/bash", ["--noprofile", "--norc", "-o", "pipefail", "-c", action.command], {
      cwd,
      detached: true,
      env: safePlannerEnvironment(this.#workspace, home),
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.#active.set(action.operationId, child);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let capturedBytes = 0;
    let outputTruncated = false;
    const capture = (target: Buffer[]) => (chunk: Buffer) => {
      const remaining = action.maxOutputBytes - capturedBytes;
      if (remaining > 0) {
        const accepted = chunk.subarray(0, remaining);
        target.push(accepted);
        capturedBytes += accepted.byteLength;
      }
      if (chunk.byteLength > remaining) outputTruncated = true;
    };
    child.stdout!.on("data", capture(stdout));
    child.stderr!.on("data", capture(stderr));
    let timedOut = false;
    let forceKill: NodeJS.Timeout | undefined;
    const timeout = setTimeout(() => {
      timedOut = true;
      if (child.pid) {
        killProcessGroup(child.pid, "SIGTERM");
        forceKill = setTimeout(() => killProcessGroup(child.pid!, "SIGKILL"), 2_000);
        forceKill.unref();
      }
    }, action.timeoutMs);
    timeout.unref();

    const exit = await new Promise<{ code: number | null; error?: Error }>((resolve) => {
      child.once("error", (error) => resolve({ code: null, error }));
      child.once("close", (code) => resolve({ code }));
    });
    clearTimeout(timeout);
    if (forceKill) clearTimeout(forceKill);
    // A shell can daemonize a child and let the direct process exit. Because
    // commands run in a detached process group, terminate that whole group
    // before the action becomes terminal; capture waits for terminal actions,
    // so no background writer survives past the durable barrier.
    if (child.pid) {
      killProcessGroup(child.pid, "SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 25));
      killProcessGroup(child.pid, "SIGKILL");
    }
    this.#active.delete(action.operationId);
    const cancelled = this.#cancelled.delete(action.operationId);
    const status = timedOut ? "timed_out" : cancelled ? "cancelled" : exit.code === 0 ? "completed" : "failed";
    return {
      schemaVersion: "gardener.runner.action-result/v1",
      sequence: action.sequence,
      operationId: action.operationId,
      status,
      exitCode: status === "completed" || status === "failed" ? exit.code ?? 1 : null,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8") || exit.error?.message || "",
      outputTruncated,
    };
  }
}

/**
 * Builds a read result and enforces the action's byte budget centrally, so
 * every read outcome — success, timeout, cancellation, and failure — obeys the
 * same invariant: `stdout` plus `stderr` never exceed `maxOutputBytes`.
 */
function readResult(
  action: RunnerGitHubReadActionV1,
  status: RunnerActionResultV1["status"],
  exitCode: number | null,
  stdout: string,
  stderr: string,
  outputTruncated: boolean,
): RunnerActionResultV1 {
  // Diagnostics are bounded first so a failure reason is never lost entirely,
  // then stdout takes whatever remains.
  const boundedStderr = truncateUtf8(stderr, action.maxOutputBytes);
  const boundedStdout = truncateUtf8(stdout, action.maxOutputBytes - Buffer.byteLength(boundedStderr, "utf8"));
  return {
    schemaVersion: "gardener.runner.action-result/v1",
    sequence: action.sequence,
    operationId: action.operationId,
    status,
    exitCode,
    stdout: boundedStdout,
    stderr: boundedStderr,
    outputTruncated: outputTruncated
      || boundedStdout.length !== stdout.length
      || boundedStderr.length !== stderr.length,
  };
}

/**
 * Builds a capture result under the same byte budget every other action obeys.
 *
 * Failure diagnostics are bounded first so the reason a capture failed is
 * never the part that gets dropped.
 */
function captureResult(
  action: RunnerCaptureActionV1,
  status: RunnerActionResultV1["status"],
  exitCode: number | null,
  stdout: string,
  stderr: string,
): RunnerActionResultV1 {
  const boundedStderr = truncateUtf8(stderr, action.maxOutputBytes);
  const boundedStdout = truncateUtf8(stdout, action.maxOutputBytes - Buffer.byteLength(boundedStderr, "utf8"));
  return {
    schemaVersion: "gardener.runner.action-result/v1",
    sequence: action.sequence,
    operationId: action.operationId,
    status,
    exitCode,
    stdout: boundedStdout,
    stderr: boundedStderr,
    outputTruncated: boundedStdout.length !== stdout.length || boundedStderr.length !== stderr.length,
  };
}

/** Capture diagnostics are runner-authored prose, but still bounded. */
function redactCaptureDiagnostic(message: string, ...roots: (string | undefined)[]): string {
  let redacted = message;
  for (const root of roots) {
    if (root) redacted = redacted.split(path.resolve(root)).join("<runner-path>");
  }
  return redacted
    .replace(/(?:\/home\/runner|\/Users\/runner|[A-Za-z]:\\)[^\s'\"`]*/g, "<runner-path>")
    .slice(0, 2_000);
}

function captureMessage(error: unknown): string {
  return (error instanceof Error ? error.message : "Repository capture failed").slice(0, 2_000);
}

/** Truncates on a UTF-8 character boundary so output is never mojibake. */
function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maxBytes) return value;
  let end = maxBytes;
  // Walk back off any continuation byte so a multi-byte sequence stays whole.
  while (end > 0 && (bytes[end]! & 0b1100_0000) === 0b1000_0000) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

interface ReadPayloadSource {
  transport: string;
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  json: unknown;
  body: string;
  bodyBytes: number;
  truncated: boolean;
}

/**
 * Serializes a provider read so the model always receives parseable JSON that
 * fits the action budget. Candidates degrade in fidelity — full payload, then
 * without the parsed body, then without headers, then body-free, then a
 * minimal envelope — and the first that fits is returned. Truncating the
 * serialized JSON directly is never acceptable because it would hand the model
 * a syntactically invalid document.
 *
 * Returns `undefined` when even the minimal envelope cannot fit, which the
 * caller turns into an explicit failure rather than an ambiguous empty result.
 */
function boundedReadPayload(
  result: ReadPayloadSource,
  maxOutputBytes: number,
): { stdout: string; outputTruncated: boolean } | undefined {
  const base = {
    transport: result.transport,
    status: result.status,
    ok: result.ok,
    bodyBytes: result.bodyBytes,
  };
  // Reserve room for the JSON scaffolding around a truncated body so the
  // escaped string cannot push the document past the budget.
  const bodyBudget = (overhead: number) => {
    let candidate = Math.max(0, maxOutputBytes - overhead);
    while (candidate > 0) {
      const text = truncateUtf8(result.body, candidate);
      const encoded = JSON.stringify(text);
      if (Buffer.byteLength(encoded, "utf8") + overhead <= maxOutputBytes) return text;
      candidate = Math.floor(candidate / 2);
    }
    return "";
  };

  const candidates: Array<() => Record<string, unknown>> = [
    () => ({ ...base, headers: result.headers, json: result.json, body: result.body, truncated: result.truncated }),
    () => ({ ...base, headers: result.headers, json: null, body: result.body, truncated: true }),
    () => ({ ...base, headers: result.headers, json: null, body: bodyBudget(overheadOf({ ...base, headers: result.headers, json: null, truncated: true })), truncated: true }),
    () => ({ ...base, json: null, body: bodyBudget(overheadOf({ ...base, json: null, truncated: true })), truncated: true }),
    () => ({ ...base, json: null, body: "", truncated: true }),
    () => ({ status: result.status, ok: result.ok, truncated: true }),
  ];

  for (const [index, build] of candidates.entries()) {
    const serialized = JSON.stringify(build());
    if (Buffer.byteLength(serialized, "utf8") <= maxOutputBytes) {
      return { stdout: serialized, outputTruncated: index > 0 || result.truncated };
    }
  }
  return undefined;
}

/** Serialized size of a payload shape with an empty body placeholder. */
function overheadOf(shape: Record<string, unknown>): number {
  return Buffer.byteLength(JSON.stringify({ ...shape, body: "" }), "utf8");
}

/** Never surfaces a token, header, or raw transport error to the runtime. */
function redactedReadError(error: unknown): string {
  const text = error instanceof Error ? error.message : "Provider read failed";
  return text.slice(0, 1_000);
}

function localWorkspacePath(workspace: string, virtualPath: string): string {
  const relative = path.posix.relative("/workspace", path.posix.normalize(virtualPath));
  if (relative.startsWith("..") || path.posix.isAbsolute(relative)) throw new Error("Shell cwd escapes /workspace");
  const resolved = path.resolve(workspace, relative);
  if (resolved !== workspace && !resolved.startsWith(`${workspace}${path.sep}`)) throw new Error("Shell cwd escapes the Actions workspace");
  return resolved;
}

function safePlannerEnvironment(workspace: string, home: string): NodeJS.ProcessEnv {
  const allowed = [
    "PATH", "LANG", "LC_ALL", "CI", "RUNNER_OS", "RUNNER_ARCH",
    "GITHUB_REPOSITORY", "GITHUB_SHA", "GITHUB_REF", "GITHUB_EVENT_NAME",
  ];
  const environment: NodeJS.ProcessEnv = { GITHUB_WORKSPACE: workspace, HOME: home };
  for (const name of allowed) if (process.env[name] !== undefined) environment[name] = process.env[name];
  return environment;
}

function killProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH") throw error;
  }
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function canonicalValue(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalValue(record[key])}`).join(",")}}`;
}
