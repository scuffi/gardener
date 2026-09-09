import { createValidatedHarness, type HarnessBackend } from "../adapter";
import {
  HARNESS_ADAPTER_VERSIONS,
  type AgentHarness,
  type HarnessCancelRequest,
  type HarnessReadOptions,
  type HarnessRequest,
  type HarnessSubmission,
} from "../types";
import type { ThinkHarnessExecution } from "./generic-agent";

export interface ThinkHarnessAgentStub {
  executeHarnessRequest(request: HarnessRequest): Promise<ThinkHarnessExecution>;
  readHarnessOutcome(requestId: string): Promise<ThinkHarnessExecution | null>;
  cancelHarness(reason?: string): Promise<boolean>;
}

/** Implement with getAgentByName(binding, runId); provider stubs stay private. */
export interface ThinkHarnessAgentLocator {
  get(runId: string): Promise<ThinkHarnessAgentStub> | ThinkHarnessAgentStub;
}

export function createThinkHarness(locator: ThinkHarnessAgentLocator): AgentHarness {
  return createValidatedHarness(
    {
      id: "think",
      adapterVersion: HARNESS_ADAPTER_VERSIONS.think,
      capabilities: ["reasoning", "structured-outcome", "workspace-tools", "cancellation"],
      preview: true,
    },
    new ThinkBackend(locator),
  );
}

class ThinkBackend implements HarnessBackend {
  constructor(private readonly locator: ThinkHarnessAgentLocator) {}

  async start(request: HarnessRequest) {
    return (await (await this.locator.get(request.runId)).executeHarnessRequest(request)).submission;
  }

  async submit(request: HarnessRequest) {
    return (await (await this.locator.get(request.runId)).executeHarnessRequest(request)).submission;
  }

  async read(submission: HarnessSubmission, _options?: HarnessReadOptions) {
    const execution = await (await this.locator.get(submission.runId)).readHarnessOutcome(submission.requestId);
    if (!execution) throw new Error(`Think submission ${submission.submissionId} is not available`);
    return { request: execution.request, outcome: execution.outcome };
  }

  async cancel(request: HarnessCancelRequest) {
    const cancelled = await (await this.locator.get(request.runId)).cancelHarness(request.reason);
    return { runId: request.runId, cancelled };
  }
}
