import { createValidatedHarness, type HarnessBackend } from "../adapter";
import {
  HARNESS_ADAPTER_VERSIONS,
  type AgentHarness,
  type HarnessCancelRequest,
  type HarnessReadOptions,
  type HarnessRequest,
  type HarnessSubmission,
} from "../types";
import type { DirectHarnessExecution } from "./generic-agent";

export interface CloudflareAgentsHarnessStub {
  executeHarnessRequest(request: HarnessRequest): Promise<DirectHarnessExecution>;
  readHarnessOutcome(requestId: string): Promise<DirectHarnessExecution | null>;
  cancelHarness(reason?: string): Promise<boolean>;
}

export interface CloudflareAgentsHarnessLocator {
  get(runId: string): Promise<CloudflareAgentsHarnessStub> | CloudflareAgentsHarnessStub;
}

export function createCloudflareAgentsHarness(
  locator: CloudflareAgentsHarnessLocator,
): AgentHarness {
  return createValidatedHarness(
    {
      id: "cloudflare-agents",
      adapterVersion: HARNESS_ADAPTER_VERSIONS["cloudflare-agents"],
      capabilities: [
        "reasoning",
        "structured-outcome",
        "workspace-tools",
        "tool-events",
        "model-usage",
        "cancellation",
      ],
      preview: false,
    },
    new CloudflareAgentsBackend(locator),
  );
}

class CloudflareAgentsBackend implements HarnessBackend {
  constructor(private readonly locator: CloudflareAgentsHarnessLocator) {}

  async start(request: HarnessRequest) {
    return (await (await this.locator.get(request.runId)).executeHarnessRequest(request)).submission;
  }

  async submit(request: HarnessRequest) {
    return (await (await this.locator.get(request.runId)).executeHarnessRequest(request)).submission;
  }

  async read(submission: HarnessSubmission, _options?: HarnessReadOptions) {
    const execution = await (await this.locator.get(submission.runId)).readHarnessOutcome(submission.requestId);
    if (!execution) throw new Error(`Cloudflare Agents submission ${submission.submissionId} is not available`);
    return { request: execution.request, outcome: execution.outcome };
  }

  async cancel(request: HarnessCancelRequest) {
    const cancelled = await (await this.locator.get(request.runId)).cancelHarness(request.reason);
    return { runId: request.runId, cancelled };
  }
}
