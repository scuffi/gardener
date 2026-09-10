export const HARNESS_IDS = ["flue", "think", "cloudflare-agents"] as const;

export type HarnessId = (typeof HARNESS_IDS)[number];

export const HARNESS_ADAPTER_VERSIONS = {
  flue: "1.0.0",
  think: "1.0.0",
  "cloudflare-agents": "1.0.0",
} as const satisfies Record<HarnessId, string>;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type HarnessCapability =
  | "reasoning"
  | "structured-outcome"
  | "workspace-tools"
  | "tool-events"
  | "model-usage"
  | "cancellation";

export interface HarnessDescriptor {
  id: HarnessId;
  adapterVersion: string;
  capabilities: readonly HarnessCapability[];
  preview: boolean;
}

export interface HarnessBindingSnapshot {
  id: HarnessId;
  adapterVersion: string;
}

export interface HarnessRunSnapshot {
  agentRevisionId: string;
  agentRevisionHash: string;
  promptReference: string;
  policySnapshotReference: string;
  toolCatalogVersion: string;
  harness: HarnessBindingSnapshot;
}

export interface HarnessBudget {
  maxTurns: number;
  maxToolCalls: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxRuntimeMs: number;
}

/**
 * Harness tools can observe data or change only the isolated run workspace.
 * Persistent provider effects are deliberately not representable here.
 */
export interface HarnessToolDescriptor {
  name: string;
  description: string;
  authority: "observe" | "workspace";
  inputSchema?: { [key: string]: JsonValue };
}

export interface HarnessRequest {
  schemaVersion: "gardener.harness.request/v1";
  requestId: string;
  runId: string;
  snapshot: HarnessRunSnapshot;
  prompt: string;
  model: {
    id: string;
  };
  tools: readonly HarnessToolDescriptor[];
  budget: HarnessBudget;
  /** Optional host-owned JSON Schema for result.data; it narrows shape, never authority. */
  resultDataSchema?: { [key: string]: JsonValue };
  context?: readonly {
    name: string;
    content: string;
  }[];
}

export interface HarnessSubmission {
  schemaVersion: "gardener.harness.submission/v1";
  harness: HarnessBindingSnapshot;
  runId: string;
  requestId: string;
  submissionId: string;
  acceptedAt: string;
}

export interface HarnessModelUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  model: string;
  turns: number;
  toolCalls: number;
}

export type HarnessActivityEvent =
  | {
      type: "activity";
      sequence: number;
      at: string;
      activity: "reasoning" | "tool";
      status: "started" | "completed" | "failed";
      name: string;
    }
  | {
      type: "tool";
      sequence: number;
      at: string;
      status: "requested" | "completed" | "rejected";
      toolCallId: string;
      toolName: string;
      input?: JsonValue;
      output?: JsonValue;
      error?: HarnessError;
    };

export interface HarnessResult {
  kind: "result" | "abstain";
  summary: string;
  data?: JsonValue;
}

export interface HarnessInterruptionRequest {
  kind: "capability" | "human-input";
  reason: string;
  capability?: string;
  scope?: JsonValue;
  question?: string;
}

export type HarnessErrorCode =
  | "invalid-request"
  | "invalid-outcome"
  | "budget-exceeded"
  | "cancelled"
  | "unsupported-model"
  | "unsupported-model-response"
  | "tool-denied"
  | "integration-unavailable"
  | "provider-error";

export interface HarnessError {
  code: HarnessErrorCode;
  message: string;
  retryable: boolean;
  details?: JsonValue;
}

interface HarnessOutcomeBase {
  schemaVersion: "gardener.harness.outcome/v1";
  harness: HarnessBindingSnapshot;
  runId: string;
  requestId: string;
  submissionId: string;
  usage: HarnessModelUsage;
  events: readonly HarnessActivityEvent[];
}

export type HarnessOutcome =
  | (HarnessOutcomeBase & {
      status: "completed";
      result: HarnessResult;
    })
  | (HarnessOutcomeBase & {
      status: "interrupted";
      interruption: HarnessInterruptionRequest;
    })
  | (HarnessOutcomeBase & {
      status: "cancelled";
      error: HarnessError;
    })
  | (HarnessOutcomeBase & {
      status: "failed";
      error: HarnessError;
    });

export interface HarnessCancelRequest {
  runId: string;
  reason?: string;
}

export interface HarnessCancelResult {
  runId: string;
  cancelled: boolean;
}

export interface HarnessReadOptions {
  signal?: AbortSignal;
  onEvent?: (event: HarnessActivityEvent) => void;
}

/**
 * Framework-neutral lifecycle used by the durable Gardener orchestrator.
 * start() creates a run and admits its first request; submit() admits another
 * request to that same run; read() reattaches to one durable submission.
 */
export interface AgentHarness {
  readonly descriptor: HarnessDescriptor;
  start(request: HarnessRequest): Promise<HarnessSubmission>;
  submit(request: HarnessRequest): Promise<HarnessSubmission>;
  read(submission: HarnessSubmission, options?: HarnessReadOptions): Promise<HarnessOutcome>;
  cancel(request: HarnessCancelRequest): Promise<HarnessCancelResult>;
}

export interface HarnessToolInvocation {
  runId: string;
  requestId: string;
  toolCallId: string;
  toolName: string;
  input: JsonValue;
}

/** Supplied by Gardener after policy has narrowed the run's workspace tools. */
export interface HarnessToolFacade {
  invoke(invocation: HarnessToolInvocation): Promise<JsonValue>;
}
