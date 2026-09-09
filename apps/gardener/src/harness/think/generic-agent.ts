import { Think, type TurnConfig, type TurnContext } from "@cloudflare/think";
import { jsonSchema, tool, type ToolSet } from "ai";
import { NarrowedHarnessToolFacade } from "../adapter";
import { outcomeFromDecision, parseHarnessDecision, unsupportedResponseOutcome } from "../structured";
import type {
  HarnessOutcome,
  HarnessRequest,
  HarnessSubmission,
  HarnessToolFacade,
  JsonValue,
} from "../types";
import {
  assertHarnessRequest,
  emptyUsage,
  expectedHarnessBinding,
  harnessError,
} from "../validation";

export interface GardenerThinkEnv extends Cloudflare.Env {
  AI: Ai;
  GARDENER_HARNESS_TOOLS: HarnessToolFacade;
}

interface GardenerThinkState {
  request: HarnessRequest | null;
  requests: Record<string, HarnessRequest>;
  outcomes: Record<string, HarnessOutcome>;
  cancelled: boolean;
}

export interface ThinkHarnessExecution {
  request: HarnessRequest;
  submission: HarnessSubmission;
  outcome: HarnessOutcome;
}

/** One static Think class; each run is addressed as a distinct Agent instance. */
export class GardenerThinkHarnessAgent extends Think<GardenerThinkEnv, GardenerThinkState> {
  initialState: GardenerThinkState = { request: null, requests: {}, outcomes: {}, cancelled: false };
  workspaceBash = false;
  maxSteps = 1;

  private activeAbort: AbortController | null = null;
  private activeToolFacade: NarrowedHarnessToolFacade | null = null;

  getModel() {
    const request = this.state.request;
    if (!request) throw new Error("Think harness has not received its immutable request");
    return request.model.id;
  }

  getSystemPrompt(): string {
    const request = this.state.request;
    if (!request) return "Gardener harness is awaiting an immutable run request.";
    return [
      request.prompt,
      "You may use only the active Gardener tools for this run.",
      "You cannot approve policy, obtain credentials, or directly mutate GitHub.",
      "Persistent effects must be returned as untrusted data for Gardener to validate.",
      "Return one JSON decision: completed with a structured result, or interrupted with a capability/human-input request.",
    ].join("\n\n");
  }

  getTools(): ToolSet {
    const request = this.state.request;
    if (!request) return {};
    const narrowed = this.activeToolFacade ?? new NarrowedHarnessToolFacade(request, this.env.GARDENER_HARNESS_TOOLS);
    return Object.fromEntries(
      request.tools.map((descriptor) => [
        descriptor.name,
        tool({
          description: descriptor.description,
          inputSchema: jsonSchema(descriptor.inputSchema ?? { type: "object", additionalProperties: true }),
          execute: async (input, context) =>
            narrowed.invoke({
              runId: request.runId,
              requestId: request.requestId,
              toolCallId: context.toolCallId,
              toolName: descriptor.name,
              input: normalizeJson(input),
            }),
        }),
      ]),
    );
  }

  beforeTurn(_context: TurnContext): TurnConfig {
    const request = this.state.request;
    if (!request) return { activeTools: [], maxSteps: 1 };
    return {
      activeTools: request.tools.map((tool) => tool.name),
      maxSteps: request.budget.maxTurns,
      maxOutputTokens: request.budget.maxOutputTokens,
      timeout: request.budget.maxRuntimeMs,
    };
  }

  async executeHarnessRequest(request: HarnessRequest): Promise<ThinkHarnessExecution> {
    assertHarnessRequest(request, expectedHarnessBinding("think"));
    const acceptedAt = new Date().toISOString();
    const submission: HarnessSubmission = {
      schemaVersion: "gardener.harness.submission/v1",
      harness: request.snapshot.harness,
      runId: request.runId,
      requestId: request.requestId,
      submissionId: request.requestId,
      acceptedAt,
    };
    this.setState({
      ...this.state,
      request,
      requests: { ...this.state.requests, [request.requestId]: request },
      cancelled: false,
    });
    const controller = new AbortController();
    const narrowed = new NarrowedHarnessToolFacade(request, this.env.GARDENER_HARNESS_TOOLS);
    this.activeAbort = controller;
    this.activeToolFacade = narrowed;
    let outcome: HarnessOutcome;
    try {
      const result = await this.runTurn({
        mode: "wait",
        input: renderInput(request),
        signal: controller.signal,
      });
      const text = extractText(result.message);
      const inputTokens = utf8Bytes(renderInput(request)) + narrowed.modelInputBytes;
      const outputTokens = utf8Bytes(text) + narrowed.modelOutputBytes;
      const usage = {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        model: request.model.id,
        turns: Math.max(1, narrowed.callCount + 1),
        toolCalls: narrowed.callCount,
      };
      try {
        outcome = outcomeFromDecision(parseHarnessDecision(JSON.parse(text)), submission, usage, []);
      } catch (error) {
        outcome = unsupportedResponseOutcome(
          submission,
          usage,
          [],
          error instanceof Error ? error.message : "Think returned an invalid structured decision",
        );
      }
    } catch (error) {
      outcome = {
        schemaVersion: "gardener.harness.outcome/v1",
        harness: submission.harness,
        runId: submission.runId,
        requestId: submission.requestId,
        submissionId: submission.submissionId,
        status: controller.signal.aborted || this.state.cancelled ? "cancelled" : "failed",
        usage: emptyUsage(request.model.id),
        events: [],
        error: harnessError(
          controller.signal.aborted || this.state.cancelled ? "cancelled" : "provider-error",
          error instanceof Error ? error.message : "Think harness failed",
          !(controller.signal.aborted || this.state.cancelled),
        ),
      };
    } finally {
      if (this.activeAbort === controller) this.activeAbort = null;
      if (this.activeToolFacade === narrowed) this.activeToolFacade = null;
    }
    this.setState({
      ...this.state,
      request,
      outcomes: { ...this.state.outcomes, [request.requestId]: outcome },
    });
    return { request, submission, outcome };
  }

  readHarnessOutcome(requestId: string): ThinkHarnessExecution | null {
    const request = this.state.requests[requestId];
    const outcome = this.state.outcomes[requestId];
    if (!request || !outcome) return null;
    return {
      request,
      submission: {
        schemaVersion: "gardener.harness.submission/v1",
        harness: request.snapshot.harness,
        runId: request.runId,
        requestId,
        submissionId: requestId,
        acceptedAt: new Date(0).toISOString(),
      },
      outcome,
    };
  }

  cancelHarness(reason?: string): boolean {
    const wasActive = this.activeAbort !== null;
    if (wasActive) {
      this.setState({ ...this.state, cancelled: true });
      this.activeAbort?.abort(new Error(reason ?? "Cancelled by Gardener"));
    }
    return wasActive;
  }
}

function renderInput(request: HarnessRequest): string {
  const context = request.context?.map((item) => `<context name=${JSON.stringify(item.name)}>\n${item.content}\n</context>`).join("\n\n");
  return context ? `${request.prompt}\n\n${context}` : request.prompt;
}

function extractText(message: unknown): string {
  if (typeof message !== "object" || message === null) return "";
  const parts = (message as { parts?: unknown }).parts;
  if (!Array.isArray(parts)) return "";
  return parts
    .filter((part): part is { type: "text"; text: string } =>
      typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text" &&
      typeof (part as { text?: unknown }).text === "string")
    .map((part) => part.text)
    .join("");
}

function normalizeJson(value: unknown): JsonValue {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function utf8Bytes(value: string): number {
  // A UTF-8 byte count is a conservative upper bound for model tokens and
  // remains enforceable even when preview Think omits provider usage metadata.
  return new TextEncoder().encode(value).byteLength;
}
