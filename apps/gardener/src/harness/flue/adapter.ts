import { AgentRunError, getAgentInstance, init } from "@flue/runtime";
import { createValidatedHarness, type HarnessBackend, type HarnessRequestStore } from "../adapter";
import { outcomeFromDecision, parseHarnessDecision, unsupportedResponseOutcome } from "../structured";
import {
  HARNESS_ADAPTER_VERSIONS,
  type AgentHarness,
  type HarnessCancelRequest,
  type HarnessOutcome,
  type HarnessReadOptions,
  type HarnessRequest,
  type HarnessSubmission,
} from "../types";
import { emptyUsage, harnessError } from "../validation";
import { GardenerFlueAgent } from "./generic-agent";

export function createFlueHarness(requests: HarnessRequestStore): AgentHarness {
  return createValidatedHarness(
    {
      id: "flue",
      adapterVersion: HARNESS_ADAPTER_VERSIONS.flue,
      capabilities: [
        "reasoning",
        "structured-outcome",
        "workspace-tools",
        "model-usage",
        "cancellation",
      ],
      preview: false,
    },
    new FlueBackend(requests),
  );
}

class FlueBackend implements HarnessBackend {
  constructor(private readonly requests: HarnessRequestStore) {}

  async start(request: HarnessRequest): Promise<HarnessSubmission> {
    await this.requests.put(request);
    const handle = init(GardenerFlueAgent, { id: request.runId, uid: null });
    const receipt = await handle.dispatch({
      message: request.prompt,
      initialData: { request },
      idempotencyKey: request.requestId,
    });
    return submission(request, receipt.submissionId, receipt.acceptedAt);
  }

  async submit(request: HarnessRequest): Promise<HarnessSubmission> {
    if ((await getAgentInstance(GardenerFlueAgent, request.runId)) === null) {
      throw new Error(`Flue run ${request.runId} has not been started`);
    }
    await this.requests.put(request);
    const receipt = await init(GardenerFlueAgent, { id: request.runId }).dispatch({
      message: request.prompt,
      idempotencyKey: request.requestId,
    });
    return submission(request, receipt.submissionId, receipt.acceptedAt);
  }

  async read(target: HarnessSubmission, options?: HarnessReadOptions) {
    const request = await this.requests.get(target.runId, target.requestId);
    if (!request) throw new Error(`Missing immutable harness request ${target.requestId}`);
    try {
      const reply = await init(GardenerFlueAgent, { id: target.runId }).read(target.submissionId, {
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
      });
      const usage = usageFromMetadata(reply.metadata, request.model.id);
      let raw: unknown;
      try {
        raw = JSON.parse(reply.text);
      } catch {
        return {
          request,
          outcome: unsupportedResponseOutcome(target, usage, [], "Flue final response was not one structured JSON decision"),
        };
      }
      try {
        return { request, outcome: outcomeFromDecision(parseHarnessDecision(raw), target, usage, []) };
      } catch (error) {
        return {
          request,
          outcome: unsupportedResponseOutcome(
            target,
            usage,
            [],
            error instanceof Error ? error.message : "Flue returned an invalid structured decision",
          ),
        };
      }
    } catch (error) {
      if (error instanceof AgentRunError && error.outcome === "aborted") {
        const outcome: HarnessOutcome = {
          schemaVersion: "gardener.harness.outcome/v1",
          harness: target.harness,
          runId: target.runId,
          requestId: target.requestId,
          submissionId: target.submissionId,
          status: "cancelled",
          usage: emptyUsage(request.model.id),
          events: [],
          error: harnessError("cancelled", "Flue run was cancelled"),
        };
        return { request, outcome };
      }
      throw error;
    }
  }

  async cancel(request: HarnessCancelRequest) {
    const exists = await getAgentInstance(GardenerFlueAgent, request.runId);
    if (!exists) return { runId: request.runId, cancelled: false };
    await init(GardenerFlueAgent, { id: request.runId }).abort();
    return { runId: request.runId, cancelled: true };
  }
}

function usageFromMetadata(metadata: Record<string, unknown> | undefined, model: string) {
  const value = metadata?.gardenerHarnessUsage;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return emptyUsage(model);
  const usage = value as Record<string, unknown>;
  const inputTokens = nonnegativeInteger(usage.inputTokens);
  const outputTokens = nonnegativeInteger(usage.outputTokens);
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    model,
    turns: nonnegativeInteger(usage.turns),
    toolCalls: nonnegativeInteger(usage.toolCalls),
  };
}

function nonnegativeInteger(value: unknown): number {
  return Number.isInteger(value) && (value as number) >= 0 ? value as number : 0;
}

function submission(
  request: HarnessRequest,
  submissionId: string,
  acceptedAt: string,
): HarnessSubmission {
  return {
    schemaVersion: "gardener.harness.submission/v1",
    harness: request.snapshot.harness,
    runId: request.runId,
    requestId: request.requestId,
    submissionId,
    acceptedAt,
  };
}
