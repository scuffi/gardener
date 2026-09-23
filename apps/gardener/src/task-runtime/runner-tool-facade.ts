import { taskEffectProposalV1Schema, taskToolResultV1Schema, type TaskEffectProposalV1 } from "@gardener/contracts";
import { TASK_TOOL_BY_HARNESS_NAME } from "./tool-authority";
import type { RunnerActionResultV1 } from "@gardener/protocol";
import type { HarnessToolFacade, HarnessToolInvocation, JsonValue } from "../harness";
import type {
  TaskCaptureAdmissionAckV1,
  TaskCaptureAdmissionInvocationV1,
  TaskEffectProposalAckV1,
  TaskEffectProposalInvocationV1,
  TaskPlanFacade,
} from "./effect-plan";
import type { TaskRunnerSession } from "./session";

/**
 * The complete trusted seam the task agent is given: bounded repository/
 * provider tools plus the durable ordered-proposal channel.
 */
export type TaskRuntimeFacade = HarnessToolFacade & TaskPlanFacade;

/**
 * Narrow view of the session stub used for the plan channel.
 *
 * The generated `DurableObjectNamespace<TaskRunnerSession>` stub type maps
 * every method, and a proposal is a recursive JSON value, so resolving the
 * full stub exceeds TypeScript's instantiation depth. Narrowing to the two
 * methods this facade calls keeps the boundary typed; the proposals coming
 * back are re-parsed against the contract, which is the check that matters.
 */
interface TaskSessionPlanStub {
  recordProposal(invocation: TaskEffectProposalInvocationV1): Promise<TaskEffectProposalAckV1>;
  listProposals(runId: string): Promise<unknown>;
  admitCapture(invocation: TaskCaptureAdmissionInvocationV1): Promise<TaskCaptureAdmissionAckV1>;
}

/** Trusted Flue-to-session adapter. The model never chooses a session id. */
export class RunnerSessionToolFacade implements TaskRuntimeFacade {
  constructor(private readonly sessions: DurableObjectNamespace<TaskRunnerSession>) {}

  /**
   * Forwards one proposal to the session, which owns ordering, idempotency,
   * the declared-effect allowlist, and the shared tool budget. Nothing is
   * accumulated here: this object is recreated per Durable Object instance
   * and would lose the plan across a replay.
   */
  async proposeEffect(invocation: TaskEffectProposalInvocationV1): Promise<TaskEffectProposalAckV1> {
    return this.planStub(invocation.runId).recordProposal(invocation);
  }

  async listProposals(runId: string): Promise<readonly TaskEffectProposalV1[]> {
    const proposals = await this.planStub(runId).listProposals(runId);
    if (!Array.isArray(proposals)) throw new Error("Task session returned a malformed proposal list");
    return proposals.map((proposal) => taskEffectProposalV1Schema.parse(proposal));
  }

  /**
   * Asks the session to admit this run's working-tree capture.
   *
   * Nothing about the capture is decided here: the session owns whether one
   * is wanted, which commit it binds to, and whether the runner's answer is
   * coherent. This is only the trusted path from the terminal to that check,
   * and it is deliberately not reachable from any mounted tool.
   */
  async captureRepository(invocation: TaskCaptureAdmissionInvocationV1): Promise<TaskCaptureAdmissionAckV1> {
    return this.planStub(invocation.runId).admitCapture(invocation);
  }

  private planStub(runId: string): TaskSessionPlanStub {
    return this.sessions.get(this.sessions.idFromName(runId)) as unknown as TaskSessionPlanStub;
  }

  async invoke(invocation: HarnessToolInvocation): Promise<JsonValue> {
    const tool = TASK_TOOL_BY_HARNESS_NAME[invocation.toolName as keyof typeof TASK_TOOL_BY_HARNESS_NAME];
    if (!tool) throw new Error("Unknown task runner tool");
    const session = this.sessions.get(this.sessions.idFromName(invocation.runId));
    const result = await session.invokeHarnessTool(invocation) as RunnerActionResultV1;
    const parsed = taskToolResultV1Schema.parse({
      schemaVersion: "gardener.task-tool-result/v1",
      operationId: result.operationId,
      tool,
      status: result.status,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      outputTruncated: result.outputTruncated,
    });
    return JSON.parse(JSON.stringify(parsed)) as JsonValue;
  }
}
