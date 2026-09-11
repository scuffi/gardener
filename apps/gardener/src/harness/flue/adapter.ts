import { AgentRunError, getAgentInstance, init } from "@flue/runtime";
import { createValidatedHarness, type HarnessBackend, type HarnessSubmissionStore } from "../adapter";
import { outcomeFromDecision, parseHarnessDecision, unsupportedResponseOutcome } from "../structured";
import {
  HARNESS_ADAPTER_VERSIONS,
  type AgentHarness,
  type HarnessCancelRequest,
  type HarnessErrorCode,
  type HarnessOutcome,
  type HarnessReadOptions,
  type HarnessRequest,
  type HarnessSubmission,
} from "../types";
import { HarnessContractError, emptyUsage, harnessError } from "../validation";
import { GardenerFlueAgent } from "./generic-agent";

export function createFlueHarness(requests: HarnessSubmissionStore): AgentHarness {
  return createValidatedHarness(
    {
      id: "flue",
      adapterVersion: HARNESS_ADAPTER_VERSIONS.flue,
      capabilities: [
        "reasoning",
        "structured-outcome",
        "model-usage",
        "cancellation",
      ],
      preview: false,
    },
    new FlueBackend(requests),
  );
}

class FlueBackend implements HarnessBackend {
  constructor(private readonly requests: HarnessSubmissionStore) {}

  async start(request: HarnessRequest): Promise<HarnessSubmission> {
    this.validateDispatchable(request);
    const durableRequest = await this.resolveRequest(request);
    this.validateDispatchable(durableRequest);
    const existing = await this.requests.getSubmission(durableRequest.runId, durableRequest.requestId);
    if (existing) return existing;
    const handle = init(GardenerFlueAgent, { id: durableRequest.runId, uid: null });
    const receipt = await handle.dispatch({
      message: durableRequest.prompt,
      initialData: { request: durableRequest },
      idempotencyKey: durableRequest.requestId,
    });
    const accepted = submission(durableRequest, receipt.submissionId, receipt.acceptedAt);
    await this.requests.putSubmission(accepted);
    return accepted;
  }

  async submit(request: HarnessRequest): Promise<HarnessSubmission> {
    this.validateDispatchable(request);
    const durableRequest = await this.resolveRequest(request);
    this.validateDispatchable(durableRequest);
    const existing = await this.requests.getSubmission(durableRequest.runId, durableRequest.requestId);
    if (existing) return existing;
    if ((await getAgentInstance(GardenerFlueAgent, durableRequest.runId)) === null) {
      throw new Error(`Flue run ${durableRequest.runId} has not been started`);
    }
    const receipt = await init(GardenerFlueAgent, { id: durableRequest.runId }).dispatch({
      message: durableRequest.prompt,
      idempotencyKey: durableRequest.requestId,
    });
    const accepted = submission(durableRequest, receipt.submissionId, receipt.acceptedAt);
    await this.requests.putSubmission(accepted);
    return accepted;
  }

  private async resolveRequest(request: HarnessRequest): Promise<HarnessRequest> {
    const durable = await this.requests.get(request.runId, request.requestId);
    if (durable) return durable;
    await this.requests.put(request);
    return request;
  }

  private validateDispatchable(request: HarnessRequest): void {
    if (request.tools.length > 0) {
      throw new HarnessContractError("integration-unavailable", "Flue workspace tools are unavailable until the trusted Gardener tool facade is configured");
    }
    // Flue's AI-binding OpenAI Responses route has a hard 16-token floor.
    // Reject smaller immutable budgets rather than letting the provider raise them.
    if (request.budget.maxOutputTokens < 16) {
      throw new HarnessContractError("invalid-request", "Flue requires an output-token budget of at least 16");
    }
  }

  async read(target: HarnessSubmission, options?: HarnessReadOptions) {
    const request = await this.requests.get(target.runId, target.requestId);
    if (!request) throw new Error(`Missing immutable harness request ${target.requestId}`);
    const accepted = await this.requests.getSubmission(target.runId, target.requestId);
    if (!accepted || !sameSubmission(accepted, target)) {
      throw new HarnessContractError("invalid-request", `Submission ${target.submissionId} does not match the immutable Flue receipt`);
    }
    const handle = init(GardenerFlueAgent, { id: accepted.runId });
    const remaining = Math.min(
      Date.parse(request.budget.deadlineAt) - Date.now(),
      request.budget.maxRuntimeMs,
    );
    if (remaining <= 0) {
      await handle.abort();
      return { request, outcome: failedOutcome(accepted, request.model.id, "budget-exceeded", "Flue run exceeded its immutable runtime budget") };
    }
    const deadline = AbortSignal.timeout(Math.max(1, Math.ceil(remaining)));
    const signal = options?.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
    try {
      const reply = await handle.read(accepted.submissionId, { signal });
      const usage = usageFromMetadata(reply.metadata, request.model.id);
      if (!usage) {
        return { request, outcome: failedOutcome(accepted, request.model.id, "invalid-outcome", "Flue response did not include complete model usage metadata") };
      }
      let raw: unknown;
      try {
        raw = JSON.parse(reply.text);
      } catch {
        return {
          request,
          outcome: unsupportedResponseOutcome(accepted, usage, [], "Flue final response was not one structured JSON decision"),
        };
      }
      try {
        return { request, outcome: outcomeFromDecision(parseHarnessDecision(raw), accepted, usage, []) };
      } catch (error) {
        return {
          request,
          outcome: unsupportedResponseOutcome(
            accepted,
            usage,
            [],
            error instanceof Error ? error.message : "Flue returned an invalid structured decision",
          ),
        };
      }
    } catch (error) {
      if (deadline.aborted) {
        await handle.abort();
        return { request, outcome: failedOutcome(accepted, request.model.id, "budget-exceeded", "Flue run exceeded its immutable runtime budget") };
      }
      if (error instanceof AgentRunError && error.outcome === "aborted") {
        return { request, outcome: failedOutcome(accepted, request.model.id, "cancelled", "Flue run was cancelled", "cancelled") };
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
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const usage = value as Record<string, unknown>;
  const uncachedInputTokens = nonnegativeInteger(usage.uncachedInputTokens);
  const cacheReadTokens = nonnegativeInteger(usage.cacheReadTokens);
  const cacheWriteTokens = nonnegativeInteger(usage.cacheWriteTokens);
  const outputTokens = nonnegativeInteger(usage.outputTokens);
  const reportedTotalTokens = nonnegativeInteger(usage.totalTokens);
  const turns = nonnegativeInteger(usage.turns);
  const toolCalls = nonnegativeInteger(usage.toolCalls);
  if (
    uncachedInputTokens === null
    || cacheReadTokens === null
    || cacheWriteTokens === null
    || outputTokens === null
    || reportedTotalTokens === null
    || turns === null
    || toolCalls === null
  ) return null;
  const inputTokens = uncachedInputTokens + cacheReadTokens + cacheWriteTokens;
  const totalTokens = inputTokens + outputTokens;
  if (inputTokens < 1 || outputTokens < 1 || reportedTotalTokens !== totalTokens) return null;
  return { inputTokens, outputTokens, totalTokens, model, turns, toolCalls };
}

function nonnegativeInteger(value: unknown): number | null {
  return Number.isInteger(value) && (value as number) >= 0 ? value as number : null;
}

function sameSubmission(left: HarnessSubmission, right: HarnessSubmission): boolean {
  return left.schemaVersion === right.schemaVersion
    && left.harness.id === right.harness.id
    && left.harness.adapterVersion === right.harness.adapterVersion
    && left.runId === right.runId
    && left.requestId === right.requestId
    && left.submissionId === right.submissionId
    && left.acceptedAt === right.acceptedAt;
}

function failedOutcome(
  target: HarnessSubmission,
  model: string,
  code: HarnessErrorCode,
  message: string,
  status: "failed" | "cancelled" = "failed",
): HarnessOutcome {
  return {
    schemaVersion: "gardener.harness.outcome/v1",
    harness: target.harness,
    runId: target.runId,
    requestId: target.requestId,
    submissionId: target.submissionId,
    status,
    usage: emptyUsage(model),
    events: [],
    error: harnessError(code, message),
  };
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
