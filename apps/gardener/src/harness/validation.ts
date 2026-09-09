import {
  HARNESS_ADAPTER_VERSIONS,
  HARNESS_IDS,
  type HarnessActivityEvent,
  type HarnessBindingSnapshot,
  type HarnessBudget,
  type HarnessError,
  type HarnessErrorCode,
  type HarnessId,
  type HarnessModelUsage,
  type HarnessOutcome,
  type HarnessRequest,
  type HarnessSubmission,
  type HarnessToolDescriptor,
  type JsonValue,
} from "./types";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const HASH = /^[a-f0-9]{32,128}$/;
const MAX_PROMPT_BYTES = 512_000;
const MAX_CONTEXT_ITEMS = 64;
const MAX_CONTEXT_BYTES = 512_000;
const MAX_TOOLS = 64;
const MAX_EVENTS = 1_024;
const MAX_JSON_CHARS = 1_000_000;

export class HarnessContractError extends Error {
  readonly code: HarnessErrorCode;

  constructor(code: HarnessErrorCode, message: string) {
    super(message);
    this.name = "HarnessContractError";
    this.code = code;
  }
}

export function harnessError(
  code: HarnessErrorCode,
  message: string,
  retryable = false,
  details?: JsonValue,
): HarnessError {
  return {
    code,
    message,
    retryable,
    ...(details === undefined ? {} : { details }),
  };
}

export function assertHarnessRequest(
  value: unknown,
  expected?: HarnessBindingSnapshot,
): asserts value is HarnessRequest {
  const request = record(value, "Harness request");
  exactKeys(request, ["schemaVersion", "requestId", "runId", "snapshot", "prompt", "model", "tools", "budget", "context"], "Harness request");
  equal(request.schemaVersion, "gardener.harness.request/v1", "Harness request schemaVersion");
  identifier(request.requestId, "requestId");
  identifier(request.runId, "runId");
  stringBound(request.prompt, "prompt", 1, MAX_PROMPT_BYTES);
  utf8Bound(request.prompt as string, "prompt", MAX_PROMPT_BYTES);

  const snapshot = record(request.snapshot, "snapshot");
  exactKeys(snapshot, ["agentRevisionId", "agentRevisionHash", "promptReference", "policySnapshotReference", "toolCatalogVersion", "harness"], "snapshot");
  identifier(snapshot.agentRevisionId, "snapshot.agentRevisionId");
  stringBound(snapshot.agentRevisionHash, "snapshot.agentRevisionHash", 32, 128);
  if (!HASH.test(snapshot.agentRevisionHash as string)) {
    invalid("snapshot.agentRevisionHash must be a lowercase hexadecimal hash");
  }
  identifier(snapshot.promptReference, "snapshot.promptReference");
  identifier(snapshot.policySnapshotReference, "snapshot.policySnapshotReference");
  identifier(snapshot.toolCatalogVersion, "snapshot.toolCatalogVersion");
  assertHarnessBinding(snapshot.harness, "snapshot.harness");

  if (expected) {
    const actual = snapshot.harness as unknown as HarnessBindingSnapshot;
    if (actual.id !== expected.id || actual.adapterVersion !== expected.adapterVersion) {
      invalid(
        `Run snapshot pins ${actual.id}@${actual.adapterVersion}, not ${expected.id}@${expected.adapterVersion}`,
      );
    }
  }

  const model = record(request.model, "model");
  exactKeys(model, ["id"], "model");
  stringBound(model.id, "model.id", 1, 256);
  assertBudget(request.budget);

  if (!Array.isArray(request.tools) || request.tools.length > MAX_TOOLS) {
    invalid(`tools must contain at most ${MAX_TOOLS} entries`);
  }
  const names = new Set<string>();
  for (const tool of request.tools) {
    assertTool(tool);
    const name = (tool as HarnessToolDescriptor).name;
    if (names.has(name)) invalid(`Duplicate harness tool ${name}`);
    names.add(name);
  }

  if (request.context !== undefined) {
    if (!Array.isArray(request.context) || request.context.length > MAX_CONTEXT_ITEMS) {
      invalid(`context must contain at most ${MAX_CONTEXT_ITEMS} entries`);
    }
    let total = 0;
    for (const [index, item] of request.context.entries()) {
      const context = record(item, `context[${index}]`);
      exactKeys(context, ["name", "content"], `context[${index}]`);
      stringBound(context.name, `context[${index}].name`, 1, 128);
      stringBound(context.content, `context[${index}].content`, 0, MAX_CONTEXT_BYTES);
      total += new TextEncoder().encode(context.content as string).byteLength;
    }
    if (total > MAX_CONTEXT_BYTES) invalid(`context exceeds ${MAX_CONTEXT_BYTES} UTF-8 bytes`);
  }
}

export function assertHarnessSubmission(
  value: unknown,
  expected: HarnessBindingSnapshot,
): asserts value is HarnessSubmission {
  const submission = record(value, "Harness submission");
  exactKeys(submission, ["schemaVersion", "harness", "runId", "requestId", "submissionId", "acceptedAt"], "Harness submission");
  equal(submission.schemaVersion, "gardener.harness.submission/v1", "Harness submission schemaVersion");
  assertHarnessBinding(submission.harness, "submission.harness");
  const binding = submission.harness as unknown as HarnessBindingSnapshot;
  if (binding.id !== expected.id || binding.adapterVersion !== expected.adapterVersion) {
    invalid("Harness submission binding does not match its adapter");
  }
  identifier(submission.runId, "submission.runId");
  identifier(submission.requestId, "submission.requestId");
  identifier(submission.submissionId, "submission.submissionId");
  isoDate(submission.acceptedAt, "submission.acceptedAt");
}

export function parseHarnessOutcome(value: unknown, expected: HarnessSubmission): HarnessOutcome {
  const outcome = record(value, "Harness outcome");
  const commonOutcomeKeys = ["schemaVersion", "harness", "runId", "requestId", "submissionId", "usage", "events", "status"];
  const variantKey = outcome.status === "completed" ? "result" : outcome.status === "interrupted" ? "interruption" : "error";
  exactKeys(outcome, [...commonOutcomeKeys, variantKey], "Harness outcome", true);
  equal(outcome.schemaVersion, "gardener.harness.outcome/v1", "Harness outcome schemaVersion");
  assertHarnessBinding(outcome.harness, "outcome.harness");
  const binding = outcome.harness as unknown as HarnessBindingSnapshot;
  if (
    binding.id !== expected.harness.id ||
    binding.adapterVersion !== expected.harness.adapterVersion ||
    outcome.runId !== expected.runId ||
    outcome.requestId !== expected.requestId ||
    outcome.submissionId !== expected.submissionId
  ) {
    invalidOutcome("Harness outcome is not bound to the requested submission");
  }
  assertUsage(outcome.usage);
  assertEvents(outcome.events);

  switch (outcome.status) {
    case "completed": {
      const result = record(outcome.result, "outcome.result");
      exactKeys(result, ["kind", "summary", "data"], "outcome.result", true);
      if (result.kind !== "result" && result.kind !== "abstain") {
        invalidOutcome("Completed outcome result.kind must be result or abstain");
      }
      stringBoundOutcome(result.summary, "outcome.result.summary", 1, 32_000);
      if (result.data !== undefined) assertJsonValue(result.data, "outcome.result.data");
      break;
    }
    case "interrupted": {
      const interruption = record(outcome.interruption, "outcome.interruption");
      exactKeys(interruption, ["kind", "reason", "capability", "scope", "question"], "outcome.interruption", true);
      if (interruption.kind !== "capability" && interruption.kind !== "human-input") {
        invalidOutcome("Unknown interruption kind");
      }
      stringBoundOutcome(interruption.reason, "outcome.interruption.reason", 1, 8_000);
      if (interruption.capability !== undefined) {
        stringBoundOutcome(interruption.capability, "outcome.interruption.capability", 1, 256);
      }
      if (interruption.scope !== undefined) assertJsonValue(interruption.scope, "outcome.interruption.scope");
      if (interruption.question !== undefined) {
        stringBoundOutcome(interruption.question, "outcome.interruption.question", 1, 8_000);
      }
      break;
    }
    case "cancelled":
    case "failed":
      assertError(outcome.error);
      break;
    default:
      invalidOutcome("Unknown harness outcome status");
  }

  return value as HarnessOutcome;
}

export function enforceOutcomeBudget(
  outcome: HarnessOutcome,
  request: HarnessRequest,
): HarnessOutcome {
  const exceeded =
    outcome.usage.turns > request.budget.maxTurns ||
    outcome.usage.toolCalls > request.budget.maxToolCalls ||
    outcome.usage.inputTokens > request.budget.maxInputTokens ||
    outcome.usage.outputTokens > request.budget.maxOutputTokens;
  if (!exceeded) return outcome;

  return {
    schemaVersion: "gardener.harness.outcome/v1",
    harness: outcome.harness,
    runId: outcome.runId,
    requestId: outcome.requestId,
    submissionId: outcome.submissionId,
    status: "failed",
    usage: outcome.usage,
    events: outcome.events,
    error: harnessError("budget-exceeded", "Harness reported usage beyond the immutable run budget"),
  };
}

export function emptyUsage(model: string): HarnessModelUsage {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0, model, turns: 0, toolCalls: 0 };
}

export function assertJsonValue(value: unknown, label = "value"): asserts value is JsonValue {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch {
    invalidOutcome(`${label} must be JSON serializable`);
  }
  if (encoded === undefined || new TextEncoder().encode(encoded).byteLength > MAX_JSON_CHARS) {
    invalidOutcome(`${label} must be bounded JSON`);
  }

  const stack: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > 20_000 || current.depth > 32) invalidOutcome(`${label} has excessive JSON complexity`);
    if (current.value === null || typeof current.value === "string" || typeof current.value === "boolean") continue;
    if (typeof current.value === "number") {
      if (!Number.isFinite(current.value)) invalidOutcome(`${label} contains a non-finite number`);
      continue;
    }
    if (typeof current.value !== "object") invalidOutcome(`${label} contains a non-JSON value`);
    const values = Array.isArray(current.value) ? current.value : Object.values(current.value as Record<string, unknown>);
    if (values.length > 2_000) invalidOutcome(`${label} has too many JSON entries`);
    for (const item of values) stack.push({ value: item, depth: current.depth + 1 });
  }
}

function assertHarnessBinding(value: unknown, label: string): asserts value is HarnessBindingSnapshot {
  const binding = record(value, label);
  exactKeys(binding, ["id", "adapterVersion"], label);
  if (!HARNESS_IDS.includes(binding.id as HarnessId)) invalid(`${label}.id is unsupported`);
  stringBound(binding.adapterVersion, `${label}.adapterVersion`, 1, 64);
}

function assertBudget(value: unknown): asserts value is HarnessBudget {
  const budget = record(value, "budget");
  exactKeys(budget, ["maxTurns", "maxToolCalls", "maxInputTokens", "maxOutputTokens", "maxRuntimeMs"], "budget");
  integer(budget.maxTurns, "budget.maxTurns", 1, 64);
  integer(budget.maxToolCalls, "budget.maxToolCalls", 0, 256);
  integer(budget.maxInputTokens, "budget.maxInputTokens", 1, 2_000_000);
  integer(budget.maxOutputTokens, "budget.maxOutputTokens", 1, 128_000);
  integer(budget.maxRuntimeMs, "budget.maxRuntimeMs", 1_000, 3_600_000);
}

function assertTool(value: unknown): asserts value is HarnessToolDescriptor {
  const tool = record(value, "tool");
  exactKeys(tool, ["name", "description", "authority", "inputSchema"], "tool");
  stringBound(tool.name, "tool.name", 1, 64);
  if (!TOOL_NAME.test(tool.name as string)) invalid(`Invalid harness tool name ${String(tool.name)}`);
  stringBound(tool.description, "tool.description", 1, 2_000);
  if (tool.authority !== "observe" && tool.authority !== "workspace") {
    invalid("Harness tools may only have observe or workspace authority");
  }
  if (tool.inputSchema !== undefined) assertJsonValue(tool.inputSchema, `tool ${String(tool.name)} inputSchema`);
}

function assertUsage(value: unknown): asserts value is HarnessModelUsage {
  const usage = recordOutcome(value, "outcome.usage");
  exactKeys(usage, ["inputTokens", "outputTokens", "totalTokens", "model", "turns", "toolCalls"], "outcome.usage", true);
  integerOutcome(usage.inputTokens, "usage.inputTokens", 0, Number.MAX_SAFE_INTEGER);
  integerOutcome(usage.outputTokens, "usage.outputTokens", 0, Number.MAX_SAFE_INTEGER);
  integerOutcome(usage.totalTokens, "usage.totalTokens", 0, Number.MAX_SAFE_INTEGER);
  integerOutcome(usage.turns, "usage.turns", 0, Number.MAX_SAFE_INTEGER);
  integerOutcome(usage.toolCalls, "usage.toolCalls", 0, Number.MAX_SAFE_INTEGER);
  stringBoundOutcome(usage.model, "usage.model", 1, 256);
  if (usage.totalTokens !== (usage.inputTokens as number) + (usage.outputTokens as number)) {
    invalidOutcome("usage.totalTokens must equal inputTokens + outputTokens");
  }
}

function assertEvents(value: unknown): asserts value is HarnessActivityEvent[] {
  if (!Array.isArray(value) || value.length > MAX_EVENTS) invalidOutcome(`events must contain at most ${MAX_EVENTS} entries`);
  let previous = -1;
  for (const [index, raw] of value.entries()) {
    const event = recordOutcome(raw, `events[${index}]`);
    exactKeys(
      event,
      event.type === "activity"
        ? ["type", "sequence", "at", "activity", "status", "name"]
        : ["type", "sequence", "at", "status", "toolCallId", "toolName", "input", "output", "error"],
      `events[${index}]`,
      true,
    );
    integerOutcome(event.sequence, `events[${index}].sequence`, 0, Number.MAX_SAFE_INTEGER);
    if ((event.sequence as number) <= previous) invalidOutcome("Event sequences must be strictly increasing");
    previous = event.sequence as number;
    isoDateOutcome(event.at, `events[${index}].at`);
    if (event.type === "activity") {
      if (event.activity !== "reasoning" && event.activity !== "tool") invalidOutcome("Unknown activity event kind");
      if (!["started", "completed", "failed"].includes(event.status as string)) invalidOutcome("Unknown activity status");
      stringBoundOutcome(event.name, `events[${index}].name`, 1, 256);
    } else if (event.type === "tool") {
      if (!["requested", "completed", "rejected"].includes(event.status as string)) invalidOutcome("Unknown tool status");
      identifierOutcome(event.toolCallId, `events[${index}].toolCallId`);
      stringBoundOutcome(event.toolName, `events[${index}].toolName`, 1, 64);
      if (event.input !== undefined) assertJsonValue(event.input, `events[${index}].input`);
      if (event.output !== undefined) assertJsonValue(event.output, `events[${index}].output`);
      if (event.error !== undefined) assertError(event.error);
    } else {
      invalidOutcome("Unknown harness event type");
    }
  }
}

function assertError(value: unknown): asserts value is HarnessError {
  const error = recordOutcome(value, "outcome.error");
  exactKeys(error, ["code", "message", "retryable", "details"], "outcome.error", true);
  const codes: HarnessErrorCode[] = [
    "invalid-request", "invalid-outcome", "budget-exceeded", "cancelled", "unsupported-model",
    "unsupported-model-response", "tool-denied", "integration-unavailable", "provider-error",
  ];
  if (!codes.includes(error.code as HarnessErrorCode)) invalidOutcome("Unknown harness error code");
  stringBoundOutcome(error.message, "outcome.error.message", 1, 8_000);
  if (typeof error.retryable !== "boolean") invalidOutcome("outcome.error.retryable must be boolean");
  if (error.details !== undefined) assertJsonValue(error.details, "outcome.error.details");
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
  outcome = false,
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) {
    const message = `${label} contains unknown fields: ${unknown.join(", ")}`;
    if (outcome) invalidOutcome(message);
    invalid(message);
  }
}

function utf8Bound(value: string, label: string, max: number): void {
  if (new TextEncoder().encode(value).byteLength > max) invalid(`${label} exceeds ${max} UTF-8 bytes`);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function recordOutcome(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalidOutcome(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function equal(value: unknown, expected: string, label: string): void {
  if (value !== expected) invalid(`${label} must be ${expected}`);
}
function identifier(value: unknown, label: string): void {
  stringBound(value, label, 1, 256);
  if (!IDENTIFIER.test(value as string)) invalid(`${label} has an invalid format`);
}
function identifierOutcome(value: unknown, label: string): void {
  stringBoundOutcome(value, label, 1, 256);
  if (!IDENTIFIER.test(value as string)) invalidOutcome(`${label} has an invalid format`);
}
function stringBound(value: unknown, label: string, min: number, max: number): void {
  if (typeof value !== "string" || value.length < min || value.length > max) invalid(`${label} must contain ${min}-${max} characters`);
}
function stringBoundOutcome(value: unknown, label: string, min: number, max: number): void {
  if (typeof value !== "string" || value.length < min || value.length > max) invalidOutcome(`${label} must contain ${min}-${max} characters`);
}
function integer(value: unknown, label: string, min: number, max: number): void {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) invalid(`${label} must be an integer between ${min} and ${max}`);
}
function integerOutcome(value: unknown, label: string, min: number, max: number): void {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) invalidOutcome(`${label} must be an integer between ${min} and ${max}`);
}
function isoDate(value: unknown, label: string): void {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) invalid(`${label} must be an ISO timestamp`);
}
function isoDateOutcome(value: unknown, label: string): void {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) invalidOutcome(`${label} must be an ISO timestamp`);
}
function invalid(message: string): never {
  throw new HarnessContractError("invalid-request", message);
}
function invalidOutcome(message: string): never {
  throw new HarnessContractError("invalid-outcome", message);
}

export function expectedHarnessBinding(id: HarnessId): HarnessBindingSnapshot {
  return { id, adapterVersion: HARNESS_ADAPTER_VERSIONS[id] };
}
