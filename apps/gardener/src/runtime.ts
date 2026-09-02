import type { AgentResult, ConnectEvent } from "@gardener/contracts";
import {
  DeterministicMockAgentRuntime,
  WorkersAiIssueGardenerRuntime,
  parseIssueClassification,
  type IssueClassification,
  type WorkersAiBinding,
} from "@gardener/core";

export const parseAiClassification = parseIssueClassification;
export type Classification = IssueClassification;

export async function runIssueGardener(input: {
  ai: WorkersAiBinding;
  model: string;
  runId: string;
  event: ConnectEvent;
  instructions: string;
}): Promise<AgentResult> {
  // Reserved for the local browser smoke harness; deployment configs always select a hosted Workers AI model.
  const runtime = input.model === "gardener/deterministic-smoke"
    ? new DeterministicMockAgentRuntime()
    : new WorkersAiIssueGardenerRuntime(input.ai);
  const handle = await runtime.start({
    schemaVersion: "v1",
    runId: input.runId,
    model: input.model,
    instructions: input.instructions,
    event: input.event,
    maxOperations: 4,
  });
  const status = await runtime.status(handle);
  if (status.state !== "succeeded") {
    throw new Error(status.error ?? `Agent execution ended in ${status.state}`);
  }
  const result = await runtime.result(handle);
  if (!result) throw new Error("Agent execution returned no result");
  return result;
}
