import type { RpcStub, RpcTarget } from "capnweb";
import type {
  ResumeCursorV1,
  RunnerActionResultV1,
  RunnerActionV1,
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
  run(): Promise<RunnerTerminalV1>;
  invoke(action: RunnerActionV1): Promise<RunnerActionResultV1>;
  reconcile(result: RunnerActionResultV1): Promise<RunnerActionResultV1>;
  resume(cursor: ResumeCursorV1, runner: RpcStub<RunnerCapability>): Promise<ResumeStateV1>;
}

export interface PublicSessionCapability extends RpcTarget {
  authenticate(
    hello: RunnerHelloV1,
    oidcToken: string,
    runner: RpcStub<RunnerCapability>,
  ): Promise<AuthenticatedSessionCapability>;
}
