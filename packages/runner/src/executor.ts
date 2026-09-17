import { spawn, type ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  runnerActionV1Schema,
  type RunnerActionResultV1,
  type RunnerActionV1,
} from "@gardener/protocol";

interface LocalRecord {
  canonicalAction: string;
  result?: RunnerActionResultV1;
  promise?: Promise<RunnerActionResultV1>;
}

export class PlanningShellExecutor {
  readonly #workspace: string;
  readonly #records = new Map<string, LocalRecord>();
  readonly #active = new Map<string, ChildProcess>();
  readonly #cancelled = new Set<string>();

  constructor(workspace = requiredEnvironment("GITHUB_WORKSPACE")) {
    this.#workspace = path.resolve(workspace);
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
    const child = this.#active.get(operationId);
    if (!child?.pid) return;
    this.#cancelled.add(operationId);
    killProcessGroup(child.pid, "SIGTERM");
    const timer = setTimeout(() => {
      if (this.#active.has(operationId)) killProcessGroup(child.pid!, "SIGKILL");
    }, 2_000);
    timer.unref();
  }

  result(operationId: string): RunnerActionResultV1 | undefined {
    return this.#records.get(operationId)?.result;
  }

  cursor(): { lastServerSequence: number; lastCompletedSequence: number } {
    const completed = [...this.#records.values()]
      .map((record) => record.result?.sequence ?? 0);
    const sequence = Math.max(0, ...completed);
    return { lastServerSequence: sequence, lastCompletedSequence: sequence };
  }

  async #run(action: RunnerActionV1): Promise<RunnerActionResultV1> {
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
