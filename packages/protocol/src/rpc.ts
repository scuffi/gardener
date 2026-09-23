import type { RpcStub, RpcTarget } from "capnweb";
import type {
  ResumeCursorV1,
  RunnerActionResultV1,
  RunnerActionV1,
  RunnerEffectReceiptV1,
  RunnerEventV1,
  RunnerHelloV1,
  RunnerTerminalV1,
} from "./schema";

export interface RunnerCapability extends RpcTarget {
  execute(action: RunnerActionV1): Promise<RunnerActionResultV1>;
  result(operationId: string): Promise<RunnerActionResultV1 | null>;
  cancel(operationId: string): Promise<void>;
}

export interface ResumeStateV1 {
  schemaVersion: "gardener.runner.resume-state/v1";
  nextServerSequence: number;
  unresolvedOperationIds: string[];
}

export interface AuthenticatedSessionCapability extends RpcTarget {
  run(event?: RunnerEventV1): Promise<RunnerTerminalV1>;
  cancelRun(reason: string): Promise<void>;
  invoke(action: RunnerActionV1): Promise<RunnerActionResultV1>;
  reconcile(result: RunnerActionResultV1): Promise<RunnerActionResultV1>;
  resume(cursor: ResumeCursorV1, runner: RpcStub<RunnerCapability>): Promise<ResumeStateV1>;
  recordEffect(receipt: RunnerEffectReceiptV1): Promise<RunnerEffectReceiptV1>;
  /**
   * Returns the receipt already recorded for this exact plan, if any.
   *
   * The apply job needs this before it writes anything. A plan that halted
   * partway leaves real effects behind, and "Re-run failed jobs" gives the
   * retry a fresh attempt with no memory of them; without this call the retry
   * would re-execute writes that already succeeded. Both arguments are exact:
   * the plan's own run id and the digest of the plan artifact, so a receipt
   * from any other plan — or any other run — cannot be returned.
   */
  priorEffectReceipt(planRunId: string, artifactSha256: string): Promise<RunnerEffectReceiptV1 | null>;
}

export interface PublicSessionCapability extends RpcTarget {
  authenticate(
    hello: RunnerHelloV1,
    oidcToken: string,
    runner: RpcStub<RunnerCapability>,
  ): Promise<AuthenticatedSessionCapability>;
}
