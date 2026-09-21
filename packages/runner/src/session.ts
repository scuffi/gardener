import { RpcTarget, newWebSocketRpcSession } from "capnweb";
import {
  runnerTerminalV1Schema,
  type PublicSessionCapability,
  type RunnerEventV1,
  type RunnerActionResultV1,
  type RunnerActionV1,
  type RunnerCapability,
  type RunnerTerminalV1,
} from "@gardener/protocol";
import { helloFromOidcToken, sessionSocketUrl } from "./context";
import { PlanningShellExecutor } from "./executor";

export interface RunPlanningSessionOptions {
  harnessUrl: string;
  agentHash: string;
  maxReconnects: number;
  getOidcToken(audience: string): Promise<string>;
  executor?: PlanningShellExecutor;
  event?: RunnerEventV1;
  signal?: AbortSignal;
  onReconnect?(attempt: number, error: unknown): void;
  onWarning?(message: string): void;
}

class RunnerApi extends RpcTarget implements RunnerCapability {
  constructor(readonly executor: PlanningShellExecutor) {
    super();
  }

  execute(action: RunnerActionV1): Promise<RunnerActionResultV1> {
    return this.executor.execute(action);
  }

  async result(operationId: string): Promise<RunnerActionResultV1 | null> {
    return await this.executor.result(operationId) ?? null;
  }

  cancel(operationId: string): Promise<void> {
    return this.executor.cancel(operationId);
  }
}

export async function runPlanningSession(options: RunPlanningSessionOptions): Promise<RunnerTerminalV1> {
  const audience = new URL(options.harnessUrl).origin;
  const executor = options.executor ?? new PlanningShellExecutor();
  const runner = new RunnerApi(executor);
  let attempt = 0;
  let lastError: unknown;

  while (attempt <= options.maxReconnects) {
    if (options.signal?.aborted) throw new Error("Gardener planning was cancelled");
    let root: ReturnType<typeof newWebSocketRpcSession<PublicSessionCapability>> | undefined;
    try {
      const oidcToken = await options.getOidcToken(audience);
      const hello = helloFromOidcToken(oidcToken, options.agentHash, "plan");
      root = newWebSocketRpcSession<PublicSessionCapability>(sessionSocketUrl(options.harnessUrl, hello, "plan"));
      const session = root.authenticate(hello, oidcToken, runner);
      const cursor = executor.cursor();
      await session.resume({ schemaVersion: "gardener.runner.cursor/v1", ...cursor }, runner);
      if (options.signal?.aborted) throw new Error("Gardener planning was cancelled before execution");
      let cancellationTimer: ReturnType<typeof setTimeout> | undefined;
      let cancelListener: (() => void) | undefined;
      const cancelled = options.signal
        ? new Promise<never>((_, reject) => {
            cancelListener = () => {
              try {
                Promise.resolve(session.cancelRun("GitHub Actions planning job was cancelled"))
                  .catch((error) => options.onWarning?.(`Gardener cancellation RPC failed: ${message(error)}`));
              } catch (error) {
                options.onWarning?.(`Gardener cancellation RPC failed: ${message(error)}`);
              }
              cancellationTimer = setTimeout(
                () => reject(new Error("Gardener cancellation did not settle within 5 seconds")),
                5_000,
              );
              cancellationTimer.unref?.();
            };
            options.signal!.addEventListener("abort", cancelListener, { once: true });
          })
        : new Promise<never>(() => undefined);
      try {
        const terminal = await Promise.race([session.run(options.event), cancelled]);
        return runnerTerminalV1Schema.parse(terminal);
      } finally {
        if (cancellationTimer) clearTimeout(cancellationTimer);
        if (cancelListener) options.signal?.removeEventListener("abort", cancelListener);
      }
    } catch (error) {
      lastError = error;
      if (options.signal?.aborted || attempt >= options.maxReconnects) break;
      attempt += 1;
      options.onReconnect?.(attempt, error);
      await delay(Math.min(5_000, 250 * 2 ** (attempt - 1)), options.signal);
    } finally {
      root?.[Symbol.dispose]();
    }
  }
  if (options.signal?.aborted) throw new Error("Gardener planning was cancelled", { cause: lastError });
  throw new Error(`Gardener session failed after ${attempt + 1} connection attempts`, { cause: lastError });
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error("Gardener planning was cancelled"));
  return new Promise((resolve, reject) => {
    const cancel = () => {
      clearTimeout(timer);
      reject(new Error("Gardener planning was cancelled"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", cancel);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", cancel, { once: true });
  });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
