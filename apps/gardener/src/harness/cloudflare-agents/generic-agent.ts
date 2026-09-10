import { canonicalJson } from "@gardener/core";
import { Agent } from "agents";
import { NarrowedHarnessToolFacade } from "../adapter";
import { outcomeFromDecision, parseHarnessDecision, unsupportedResponseOutcome } from "../structured";
import type {
  HarnessActivityEvent,
  HarnessModelUsage,
  HarnessOutcome,
  HarnessRequest,
  HarnessSubmission,
  HarnessToolFacade,
  JsonValue,
} from "../types";
import {
  HarnessContractError,
  assertHarnessRequest,
  emptyUsage,
  expectedHarnessBinding,
  harnessError,
  parseHarnessOutcome,
} from "../validation";

export interface GardenerCloudflareAgentsEnv extends Cloudflare.Env {
  AI: Ai;
  GARDENER_HARNESS_TOOLS: HarnessToolFacade;
}

interface DirectHarnessState {
  request: HarnessRequest | null;
  requests: Record<string, HarnessRequest>;
  outcomes: Record<string, HarnessOutcome>;
  cancelled: boolean;
}

export interface DirectHarnessExecution {
  request: HarnessRequest;
  submission: HarnessSubmission;
  outcome: HarnessOutcome;
}

interface DirectModelResponse {
  response: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

/**
 * Minimal base Agents SDK harness. It intentionally calls env.AI.run directly
 * and supports only the verified Workers AI text response shape.
 */
export class GardenerCloudflareAgentsHarness extends Agent<
  GardenerCloudflareAgentsEnv,
  DirectHarnessState
> {
  initialState: DirectHarnessState = { request: null, requests: {}, outcomes: {}, cancelled: false };
  private activeAbort: AbortController | null = null;

  async executeHarnessRequest(request: HarnessRequest): Promise<DirectHarnessExecution> {
    const binding = expectedHarnessBinding("cloudflare-agents");
    assertHarnessRequest(request, binding);

    const persistedRequest = this.state.requests[request.requestId];
    const persistedOutcome = this.state.outcomes[request.requestId];
    if (persistedRequest !== undefined || persistedOutcome !== undefined) {
      if (persistedRequest === undefined) {
        throw new HarnessContractError(
          "integration-unavailable",
          `Harness request ${request.requestId} has an outcome without its immutable request`,
        );
      }
      assertHarnessRequest(persistedRequest, binding);
      if (canonicalJson(persistedRequest) !== canonicalJson(request)) {
        throw new HarnessContractError(
          "invalid-request",
          `Harness request ${request.requestId} conflicts with the persisted immutable request`,
        );
      }
      if (persistedOutcome === undefined) {
        throw new HarnessContractError(
          "integration-unavailable",
          `Harness request ${request.requestId} has an ambiguous in-flight execution; refusing duplicate inference`,
        );
      }
      const submission = submissionFor(request, new Date(0).toISOString());
      return {
        request: persistedRequest,
        submission,
        outcome: parseHarnessOutcome(persistedOutcome, submission),
      };
    }

    const submission = submissionFor(request, new Date().toISOString());
    this.setState({
      ...this.state,
      request,
      requests: { ...this.state.requests, [request.requestId]: request },
      cancelled: false,
    });
    const controller = new AbortController();
    this.activeAbort = controller;
    const outcome = await this.runBoundedLoop(request, submission, controller);
    if (this.activeAbort === controller) this.activeAbort = null;
    this.setState({
      ...this.state,
      request,
      outcomes: { ...this.state.outcomes, [request.requestId]: outcome },
    });
    return { request, submission, outcome };
  }

  readHarnessOutcome(requestId: string): DirectHarnessExecution | null {
    const request = this.state.requests[requestId];
    const outcome = this.state.outcomes[requestId];
    if (!request || !outcome) return null;
    const submission = submissionFor(request, new Date(0).toISOString());
    return { request, submission, outcome };
  }

  cancelHarness(reason?: string): boolean {
    const wasActive = this.activeAbort !== null;
    if (wasActive) {
      this.setState({ ...this.state, cancelled: true });
      this.activeAbort?.abort(new Error(reason ?? "Cancelled by Gardener"));
    }
    return wasActive;
  }

  private async runBoundedLoop(
    request: HarnessRequest,
    submission: HarnessSubmission,
    controller: AbortController,
  ): Promise<HarnessOutcome> {
    const usage = emptyUsage(request.model.id);
    const events: HarnessActivityEvent[] = [];
    if (!request.model.id.startsWith("@cf/")) {
      return failure(
        submission,
        usage,
        events,
        "unsupported-model",
        "The direct Cloudflare Agents harness supports only @cf/ Workers AI models; use Flue or Think for gateway model slugs",
      );
    }

    const started = Date.now();
    const narrowed = new NarrowedHarnessToolFacade(request, this.env.GARDENER_HARNESS_TOOLS);
    const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
      { role: "system", content: systemPrompt(request) },
      { role: "user", content: request.prompt },
    ];
    let sequence = 0;

    for (let turn = 0; turn < request.budget.maxTurns; turn += 1) {
      if (controller.signal.aborted || this.state.cancelled) return cancelled(submission, usage, events);
      if (Date.now() - started >= request.budget.maxRuntimeMs) {
        return failure(submission, usage, events, "budget-exceeded", "Harness runtime budget is exhausted");
      }
      if (conservativeTokens(messages) + narrowed.modelInputBytes > request.budget.maxInputTokens) {
        return failure(submission, usage, events, "budget-exceeded", "Harness input-token budget is exhausted");
      }

      events.push(activity(sequence++, "reasoning", "started", `turn-${turn}`));
      let raw: unknown;
      try {
        const ai = this.env.AI as unknown as {
          run(model: string, input: unknown, options?: { signal?: AbortSignal }): Promise<unknown>;
        };
        const remainingRuntimeMs = Math.max(1, request.budget.maxRuntimeMs - (Date.now() - started));
        const callController = new AbortController();
        const timeout = setTimeout(() => callController.abort(new Error("Harness runtime budget is exhausted")), remainingRuntimeMs);
        const abortCall = () => callController.abort(controller.signal.reason);
        controller.signal.addEventListener("abort", abortCall, { once: true });
        try {
          raw = await ai.run(
            request.model.id,
            {
              messages,
              max_tokens: Math.max(1, request.budget.maxOutputTokens - usage.outputTokens),
              response_format: { type: "json_object" },
            },
            { signal: callController.signal },
          );
        } finally {
          clearTimeout(timeout);
          controller.signal.removeEventListener("abort", abortCall);
        }
      } catch (error) {
        if (controller.signal.aborted || this.state.cancelled) return cancelled(submission, usage, events);
        if (Date.now() - started >= request.budget.maxRuntimeMs) {
          return failure(submission, usage, events, "budget-exceeded", "Harness runtime budget is exhausted");
        }
        return failure(
          submission,
          usage,
          events,
          "provider-error",
          error instanceof Error ? error.message : "Workers AI request failed",
          true,
        );
      }

      const response = parseDirectResponse(raw);
      if (!response) {
        events.push(activity(sequence++, "reasoning", "failed", `turn-${turn}`));
        return unsupportedResponseOutcome(
          submission,
          withTurnUsage(usage, turn + 1),
          events,
          "Workers AI response did not contain a supported non-streaming string or { response, usage? } shape",
        );
      }
      if (new TextEncoder().encode(response.response).byteLength > 512_000) {
        return failure(submission, usage, events, "budget-exceeded", "Workers AI response exceeded the bounded response size");
      }
      addUsage(usage, response, messages, turn + 1);
      if (usage.inputTokens > request.budget.maxInputTokens || usage.outputTokens > request.budget.maxOutputTokens) {
        return failure(submission, usage, events, "budget-exceeded", "Workers AI usage exceeded the immutable run budget");
      }
      events.push(activity(sequence++, "reasoning", "completed", `turn-${turn}`));

      let decision: unknown;
      try {
        decision = JSON.parse(response.response);
      } catch {
        return unsupportedResponseOutcome(submission, usage, events, "Workers AI response was not structured JSON");
      }
      try {
        const parsed = parseHarnessDecision(decision);
        return outcomeFromDecision(parsed, submission, usage, events);
      } catch {
        // It may be a bounded workspace/observation tool decision.
      }

      const toolDecision = parseToolDecision(decision);
      if (!toolDecision) {
        return unsupportedResponseOutcome(submission, usage, events, "Workers AI returned an unknown decision shape");
      }
      const toolCallId = `${request.requestId}:tool:${usage.toolCalls}`;
      events.push({
        type: "tool",
        sequence: sequence++,
        at: new Date().toISOString(),
        status: "requested",
        toolCallId,
        toolName: toolDecision.toolName,
        input: toolDecision.input,
      });
      try {
        const output = await narrowed.invoke({
          runId: request.runId,
          requestId: request.requestId,
          toolCallId,
          toolName: toolDecision.toolName,
          input: toolDecision.input,
        });
        usage.toolCalls += 1;
        events.push({
          type: "tool",
          sequence: sequence++,
          at: new Date().toISOString(),
          status: "completed",
          toolCallId,
          toolName: toolDecision.toolName,
          output,
        });
        messages.push(
          { role: "assistant", content: response.response },
          { role: "user", content: JSON.stringify({ toolCallId, toolName: toolDecision.toolName, output }) },
        );
      } catch (error) {
        const contract = error instanceof HarnessContractError ? error : null;
        events.push({
          type: "tool",
          sequence: sequence++,
          at: new Date().toISOString(),
          status: "rejected",
          toolCallId,
          toolName: toolDecision.toolName,
          error: harnessError(
            contract?.code ?? "provider-error",
            error instanceof Error ? error.message : "Tool invocation failed",
          ),
        });
        return failure(
          submission,
          usage,
          events,
          contract?.code ?? "provider-error",
          error instanceof Error ? error.message : "Tool invocation failed",
        );
      }
    }

    return failure(submission, usage, events, "budget-exceeded", "Harness turn budget is exhausted");
  }
}

function submissionFor(request: HarnessRequest, acceptedAt: string): HarnessSubmission {
  return {
    schemaVersion: "gardener.harness.submission/v1",
    harness: request.snapshot.harness,
    runId: request.runId,
    requestId: request.requestId,
    submissionId: request.requestId,
    acceptedAt,
  };
}

export function parseDirectResponse(value: unknown): DirectModelResponse | null {
  if (typeof value === "string") return { response: value };
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const response = value as Record<string, unknown>;
  if (typeof response.response !== "string") return null;
  if (response.usage !== undefined && (typeof response.usage !== "object" || response.usage === null)) return null;
  return response as unknown as DirectModelResponse;
}

function parseToolDecision(value: unknown): { toolName: string; input: JsonValue } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const decision = value as Record<string, unknown>;
  if (decision.status !== "tool" || typeof decision.toolName !== "string") return null;
  try {
    const input = decision.input === undefined ? null : JSON.parse(JSON.stringify(decision.input)) as JsonValue;
    return { toolName: decision.toolName, input };
  } catch {
    return null;
  }
}

function addUsage(
  usage: HarnessModelUsage,
  response: DirectModelResponse,
  messages: Array<{ content: string }>,
  turns: number,
): void {
  // Workers AI usage is preferred when present. Byte counts are a conservative
  // fallback/ceiling so missing preview metadata cannot disable run budgets.
  const input = nonnegativeOptional(response.usage?.prompt_tokens) ?? conservativeTokens(messages);
  const output = nonnegativeOptional(response.usage?.completion_tokens) ?? new TextEncoder().encode(response.response).byteLength;
  usage.inputTokens += input;
  usage.outputTokens += output;
  usage.totalTokens = usage.inputTokens + usage.outputTokens;
  usage.turns = turns;
}

function withTurnUsage(usage: HarnessModelUsage, turns: number): HarnessModelUsage {
  return { ...usage, turns };
}

function nonnegativeOptional(value: unknown): number | null {
  return Number.isInteger(value) && (value as number) >= 0 ? value as number : null;
}

function conservativeTokens(messages: Array<{ content: string }>): number {
  return messages.reduce((total, message) => total + new TextEncoder().encode(message.content).byteLength, 0);
}

function systemPrompt(request: HarnessRequest): string {
  return [
    "You are the reasoning component of a Gardener repository run.",
    "You cannot approve policy, access credentials, or directly mutate GitHub.",
    `Available tools: ${JSON.stringify(request.tools.map(({ name, description }) => ({ name, description })))}`,
    'Return JSON only: {"status":"tool","toolName":"...","input":{...}},',
    'or {"status":"completed","result":{"kind":"result|abstain","summary":"...","data":null}},',
    'or {"status":"interrupted","interruption":{"kind":"capability|human-input","reason":"..."}}.',
  ].join("\n");
}

function activity(
  sequence: number,
  activityName: "reasoning" | "tool",
  status: "started" | "completed" | "failed",
  name: string,
): HarnessActivityEvent {
  return { type: "activity", sequence, at: new Date().toISOString(), activity: activityName, status, name };
}

function failure(
  submission: HarnessSubmission,
  usage: HarnessModelUsage,
  events: readonly HarnessActivityEvent[],
  code: Parameters<typeof harnessError>[0],
  message: string,
  retryable = false,
): HarnessOutcome {
  return {
    schemaVersion: "gardener.harness.outcome/v1",
    harness: submission.harness,
    runId: submission.runId,
    requestId: submission.requestId,
    submissionId: submission.submissionId,
    status: "failed",
    usage,
    events,
    error: harnessError(code, message, retryable),
  };
}

function cancelled(
  submission: HarnessSubmission,
  usage: HarnessModelUsage,
  events: readonly HarnessActivityEvent[],
): HarnessOutcome {
  return {
    schemaVersion: "gardener.harness.outcome/v1",
    harness: submission.harness,
    runId: submission.runId,
    requestId: submission.requestId,
    submissionId: submission.submissionId,
    status: "cancelled",
    usage,
    events,
    error: harnessError("cancelled", "Harness run was cancelled"),
  };
}
