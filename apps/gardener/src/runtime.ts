import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { getRun, updateRunState } from "./persistence";
import type { Env } from "./env";

export interface AgentRunWorkflowPayload {
  runId: string;
  runSnapshotHash: string;
}

/**
 * Fail-closed durable entrypoint for the Agent-native runtime.
 *
 * Authoring, publication, activation, and event admission are wired, but the
 * trusted tool facade, Connect V2 live-state observation, and exact-effect
 * executor are not yet integrated. Until all three exist this workflow records
 * a terminal failure and never calls a model, workspace tool, or GitHub effect.
 */
export class AgentRunWorkflow extends WorkflowEntrypoint<Env, AgentRunWorkflowPayload> {
  async run(event: Readonly<WorkflowEvent<AgentRunWorkflowPayload>>, step: WorkflowStep): Promise<void> {
    await step.do("fail-closed-runtime-boundary-v1", async () => {
      const run = await getRun(this.env.DB, event.payload.runId);
      if (!run || run.runSnapshotHash !== event.payload.runSnapshotHash) {
        throw new Error("Agent run identity or immutable snapshot binding is invalid");
      }
      await updateRunState(this.env.DB, {
        runId: run.id,
        expectedStatus: run.status,
        status: "failed",
        usage: run.usage,
        error: {
          code: "agent_runtime_not_integrated",
          message: "Agent execution is disabled until trusted tools, Connect V2 observations, and exact-effect execution are integrated",
        },
      });
    });
  }
}
