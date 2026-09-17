import { RpcTarget, newWebSocketRpcSession } from "capnweb";
import {
  runnerTerminalV1Schema,
  type PublicSessionCapability,
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
  onReconnect?(attempt: number, error: unknown): void;
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
    let root: ReturnType<typeof newWebSocketRpcSession<PublicSessionCapability>> | undefined;
    try {
      const oidcToken = await options.getOidcToken(audience);
      const hello = helloFromOidcToken(oidcToken, options.agentHash, "plan");
      root = newWebSocketRpcSession<PublicSessionCapability>(sessionSocketUrl(options.harnessUrl, hello, "plan"));
      const session = root.authenticate(hello, oidcToken, runner);
      const cursor = executor.cursor();
      await session.resume({ schemaVersion: "gardener.runner.cursor/v1", ...cursor }, runner);
      return runnerTerminalV1Schema.parse(await session.run());
    } catch (error) {
      lastError = error;
      if (attempt >= options.maxReconnects) break;
      attempt += 1;
      options.onReconnect?.(attempt, error);
      await delay(Math.min(5_000, 250 * 2 ** (attempt - 1)));
    } finally {
      root?.[Symbol.dispose]();
    }
  }
  throw new Error(`Gardener session failed after ${attempt + 1} connection attempts`, { cause: lastError });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
