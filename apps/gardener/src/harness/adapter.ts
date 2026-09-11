import type {
  AgentHarness,
  HarnessCancelRequest,
  HarnessCancelResult,
  HarnessDescriptor,
  HarnessOutcome,
  HarnessReadOptions,
  HarnessRequest,
  HarnessSubmission,
  HarnessToolFacade,
  HarnessToolInvocation,
  JsonValue,
} from "./types";
import { resultDataSchemaIssue } from "./result-schema";
import {
  HarnessContractError,
  assertHarnessRequest,
  assertHarnessSubmission,
  assertJsonValue,
  enforceOutcomeBudget,
  harnessError,
  parseHarnessOutcome,
} from "./validation";

export interface HarnessBackendRead {
  request: HarnessRequest;
  outcome: unknown;
}

/** Durable request storage supplied by the orchestrator integration. */
export interface HarnessRequestStore {
  put(request: HarnessRequest): Promise<void>;
  get(runId: string, requestId: string): Promise<HarnessRequest | null>;
}

/** Durable request plus dispatch-receipt storage for reattaching after a crash. */
export interface HarnessSubmissionStore extends HarnessRequestStore {
  putSubmission(submission: HarnessSubmission): Promise<void>;
  getSubmission(runId: string, requestId: string): Promise<HarnessSubmission | null>;
}

/** Provider bridge. Provider-specific handles stay behind this interface. */
export interface HarnessBackend {
  start(request: HarnessRequest): Promise<unknown>;
  submit(request: HarnessRequest): Promise<unknown>;
  read(submission: HarnessSubmission, options?: HarnessReadOptions): Promise<HarnessBackendRead>;
  cancel(request: HarnessCancelRequest): Promise<HarnessCancelResult>;
}

/**
 * Applies the same contract, pinning, result, and budget checks to every
 * provider. The orchestrator, not a framework adapter, remains authoritative.
 */
export function createValidatedHarness(
  descriptor: HarnessDescriptor,
  backend: HarnessBackend,
): AgentHarness {
  const expected = { id: descriptor.id, adapterVersion: descriptor.adapterVersion } as const;

  const admit = async (kind: "start" | "submit", request: HarnessRequest) => {
    assertHarnessRequest(request, expected);
    const raw = await backend[kind](request);
    assertHarnessSubmission(raw, expected);
    const submission = raw as HarnessSubmission;
    if (submission.runId !== request.runId || submission.requestId !== request.requestId) {
      throw new HarnessContractError("invalid-outcome", "Harness submission changed the run or request identity");
    }
    return submission;
  };

  return {
    descriptor: freezeDescriptor(descriptor),
    start: (request) => admit("start", request),
    submit: (request) => admit("submit", request),
    async read(submission, options) {
      assertHarnessSubmission(submission, expected);
      const read = await backend.read(submission, options);
      assertHarnessRequest(read.request, expected);
      if (read.request.runId !== submission.runId || read.request.requestId !== submission.requestId) {
        throw new HarnessContractError("invalid-outcome", "Harness read returned a different immutable request");
      }
      const parsed = parseHarnessOutcome(read.outcome, submission);
      const schemaIssue = parsed.status === "completed" && read.request.resultDataSchema
        ? resultDataSchemaIssue(read.request.resultDataSchema, parsed.result.data)
        : null;
      const validated: HarnessOutcome = schemaIssue
        ? {
            schemaVersion: parsed.schemaVersion,
            harness: parsed.harness,
            runId: parsed.runId,
            requestId: parsed.requestId,
            submissionId: parsed.submissionId,
            status: "failed",
            usage: parsed.usage,
            events: parsed.events,
            error: harnessError("unsupported-model-response", `Harness result violated resultDataSchema: ${schemaIssue}`),
          }
        : parsed;
      const bounded = enforceOutcomeBudget(validated, read.request);
      for (const event of bounded.events) options?.onEvent?.(event);
      return bounded;
    },
    async cancel(request) {
      if (typeof request.runId !== "string" || request.runId.length === 0) {
        throw new HarnessContractError("invalid-request", "Cancellation requires a runId");
      }
      if (request.reason !== undefined && request.reason.length > 2_000) {
        throw new HarnessContractError("invalid-request", "Cancellation reason is too long");
      }
      const result = await backend.cancel(request);
      if (result.runId !== request.runId || typeof result.cancelled !== "boolean") {
        throw new HarnessContractError("invalid-outcome", "Harness returned an invalid cancellation result");
      }
      return result;
    },
  };
}

export class NarrowedHarnessToolFacade implements HarnessToolFacade {
  private calls = 0;
  private inputBytes = 0;
  private outputBytes = 0;

  get callCount(): number { return this.calls; }
  /** Bytes of model-produced tool arguments (a conservative output-token bound). */
  get modelOutputBytes(): number { return this.inputBytes; }
  /** Bytes returned to the model by tools (a conservative input-token bound). */
  get modelInputBytes(): number { return this.outputBytes; }

  constructor(
    private readonly request: HarnessRequest,
    private readonly delegate: HarnessToolFacade,
  ) {}

  async invoke(invocation: HarnessToolInvocation): Promise<JsonValue> {
    if (invocation.runId !== this.request.runId || invocation.requestId !== this.request.requestId) {
      throw new HarnessContractError("tool-denied", "Tool invocation is not bound to this harness request");
    }
    const tool = this.request.tools.find((candidate) => candidate.name === invocation.toolName);
    if (!tool) {
      throw new HarnessContractError("tool-denied", `Harness requested unavailable tool ${invocation.toolName}`);
    }
    if (tool.authority !== "observe" && tool.authority !== "workspace") {
      throw new HarnessContractError("tool-denied", "Harness tools cannot expand persistent authority");
    }
    if (this.calls >= this.request.budget.maxToolCalls) {
      throw new HarnessContractError("budget-exceeded", "Harness tool-call budget is exhausted");
    }
    assertJsonValue(invocation.input, "tool input");
    this.inputBytes += new TextEncoder().encode(JSON.stringify(invocation.input)).byteLength;
    this.calls += 1;
    const output = await this.delegate.invoke(invocation);
    assertJsonValue(output, "tool output");
    this.outputBytes += new TextEncoder().encode(JSON.stringify(output)).byteLength;
    return output;
  }
}

export function providerFailureOutcome(
  submission: HarnessSubmission,
  request: HarnessRequest,
  error: unknown,
): HarnessOutcome {
  const contract = error instanceof HarnessContractError ? error : null;
  return {
    schemaVersion: "gardener.harness.outcome/v1",
    harness: submission.harness,
    runId: submission.runId,
    requestId: submission.requestId,
    submissionId: submission.submissionId,
    status: "failed",
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      model: request.model.id,
      turns: 0,
      toolCalls: 0,
    },
    events: [],
    error: harnessError(
      contract?.code ?? "provider-error",
      error instanceof Error ? error.message : "Harness provider failed",
      contract === null,
    ),
  };
}

function freezeDescriptor(descriptor: HarnessDescriptor): HarnessDescriptor {
  return Object.freeze({
    ...descriptor,
    capabilities: Object.freeze([...descriptor.capabilities]),
  });
}
