import { setProvider } from "@flue/runtime";
import {
  cloudflareBindingProvider,
  type CloudflareAIBinding,
} from "@flue/runtime/cloudflare/workers-ai";
import type { HarnessBudget } from "../types";
import { FLUE_NATIVE_INPUT_BYTES_PER_TOKEN } from "../../flue-native-protocol";

const NATIVE_BOUNDED_MODEL_PREFIX = "gardener-native-bounded-v2";
const MINIMUM_PROVIDER_OUTPUT_TOKENS = 16;
let installedBinding: CloudflareAIBinding | undefined;

type CloudflareProvider = ReturnType<typeof cloudflareBindingProvider>;
type ProviderStreamOptions = NonNullable<Parameters<CloudflareProvider["stream"]>[2]>;
type PayloadTransform = ProviderStreamOptions["onPayload"];

interface EncodedBudget {
  model: string;
  maxTurns: number;
  maxInputBytes: number;
  maxOutputTokensPerTurn: number;
  maxRuntimeMs: number;
  deadlineAtMs: number;
}

/** Encode the immutable, submission-scoped native runtime limits in Flue's model id. */
export function boundedCloudflareModel(model: string, budget: HarnessBudget): string {
  if (budget.maxOutputTokens < MINIMUM_PROVIDER_OUTPUT_TOKENS) {
    throw new Error(`Flue requires an output-token budget of at least ${MINIMUM_PROVIDER_OUTPUT_TOKENS}`);
  }
  const modelId = model.startsWith("cloudflare/") ? model.slice("cloudflare/".length) : model;
  const maxInputBytes = inputByteLimit(budget.maxInputTokens);
  const maxOutputTokensPerTurn = Math.floor(budget.maxOutputTokens / budget.maxTurns);
  if (maxOutputTokensPerTurn < MINIMUM_PROVIDER_OUTPUT_TOKENS) {
    throw new Error(`Flue requires at least ${MINIMUM_PROVIDER_OUTPUT_TOKENS} output tokens per permitted turn`);
  }
  return `cloudflare/${NATIVE_BOUNDED_MODEL_PREFIX}:${budget.maxTurns}:${maxInputBytes}:${maxOutputTokensPerTurn}:${budget.maxRuntimeMs}:${Date.parse(budget.deadlineAt)}:${encodeURIComponent(modelId)}`;
}

/** Register a tool-preserving provider wrapper around Flue's supported Workers AI provider. */
export function installBoundedCloudflareProvider(binding: CloudflareAIBinding): void {
  if (installedBinding === binding) return;
  installedBinding = binding;
  const provider = cloudflareBindingProvider({ binding });
  const stream = provider.stream.bind(provider);
  const streamSimple = provider.streamSimple.bind(provider);

  provider.stream = ((model, context, options) => {
    const budget = decodeBoundedModel(model.id);
    enforceTurnLimit(context, budget.maxTurns);
    enforceInputByteLimit(context, budget.maxInputBytes);
    return stream(
      resolveActualModel(provider, model, budget.model),
      context,
      boundedProviderOptions(options, budget),
    );
  }) as typeof provider.stream;

  provider.streamSimple = ((model, context, options) => {
    const budget = decodeBoundedModel(model.id);
    enforceTurnLimit(context, budget.maxTurns);
    enforceInputByteLimit(context, budget.maxInputBytes);
    return streamSimple(
      resolveActualModel(provider, model, budget.model),
      context,
      boundedProviderOptions(options as ProviderStreamOptions | undefined, budget),
    );
  }) as typeof provider.streamSimple;

  setProvider(provider);
}

function boundedProviderOptions(
  options: ProviderStreamOptions | undefined,
  budget: EncodedBudget,
): ProviderStreamOptions {
  return {
    ...options,
    maxTokens: options?.maxTokens === undefined
      ? budget.maxOutputTokensPerTurn
      : Math.min(options.maxTokens, budget.maxOutputTokensPerTurn),
    signal: deadlineSignal(options?.signal, budget.deadlineAtMs, budget.maxRuntimeMs),
    onPayload: nativeToolPayload(options?.onPayload, budget.maxInputBytes),
  };
}

function nativeToolPayload(
  previous: PayloadTransform | undefined,
  maxInputBytes: number,
): NonNullable<PayloadTransform> {
  return async (payload, model) => {
    const overridden = await previous?.(payload, model);
    const value = overridden === undefined ? payload : overridden;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("Flue provider produced an unsupported native tool payload");
    }
    // Native execution uses Flue's serialized tool catalog, never assistant-text JSON mode.
    const { response_format: _legacyStructuredMode, ...native } = value as Record<string, unknown>;
    forceIssueTriageTool(native);
    enforceInputByteLimit(native, maxInputBytes);
    return native;
  };
}

function forceIssueTriageTool(payload: Record<string, unknown>): void {
  const tools = Array.isArray(payload.tools) ? payload.tools : [];
  const names = tools.map((tool) => {
    if (typeof tool !== "object" || tool === null) return undefined;
    const record = tool as Record<string, unknown>;
    if (typeof record.name === "string") return record.name;
    const fn = record.function;
    return typeof fn === "object" && fn !== null && typeof (fn as Record<string, unknown>).name === "string"
      ? (fn as Record<string, unknown>).name as string
      : undefined;
  });
  if (!names.includes("submit_task_outcome_v1")) return;
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const hasToolResult = messages.some((message) => {
    if (typeof message !== "object" || message === null) return false;
    const role = (message as Record<string, unknown>).role;
    return role === "tool" || role === "toolResult";
  });
  const name = hasToolResult || !names.includes("repository_list_files") ? "submit_task_outcome_v1" : "repository_list_files";
  if (!names.includes(name)) throw new Error(`Required issue-triage tool ${name} is missing`);
  payload.tool_choice = { type: "function", function: { name } };
}

function decodeBoundedModel(model: string): EncodedBudget {
  const [prefix, turns, input, output, runtime, deadline, encodedModel, ...extra] = model.split(":");
  const maxTurns = Number(turns);
  const maxInputBytes = Number(input);
  const maxOutputTokensPerTurn = Number(output);
  const maxRuntimeMs = Number(runtime);
  const deadlineAtMs = Number(deadline);
  if (
    prefix !== NATIVE_BOUNDED_MODEL_PREFIX
    || extra.length > 0
    || !Number.isSafeInteger(maxTurns)
    || maxTurns < 1
    || !Number.isSafeInteger(maxInputBytes)
    || maxInputBytes < 1
    || !Number.isSafeInteger(maxOutputTokensPerTurn)
    || maxOutputTokensPerTurn < MINIMUM_PROVIDER_OUTPUT_TOKENS
    || !Number.isSafeInteger(maxRuntimeMs)
    || maxRuntimeMs < 1
    || !Number.isSafeInteger(deadlineAtMs)
    || deadlineAtMs < 1
    || !encodedModel
  ) {
    throw new Error("Flue model request is missing a valid immutable Gardener native budget");
  }
  const decoded = decodeURIComponent(encodedModel);
  if (!decoded || decoded.startsWith("cloudflare/")) {
    throw new Error("Flue model request contains an invalid bounded model id");
  }
  return { model: decoded, maxTurns, maxInputBytes, maxOutputTokensPerTurn, maxRuntimeMs, deadlineAtMs };
}

function enforceInputByteLimit(value: unknown, maxInputBytes: number): void {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("Flue model input could not be measured");
  if (new TextEncoder().encode(serialized).byteLength > maxInputBytes) {
    throw new Error(`Flue model input exceeds its immutable ${maxInputBytes}-byte safety limit`);
  }
}

function inputByteLimit(maxInputTokens: number): number {
  const limit = maxInputTokens * FLUE_NATIVE_INPUT_BYTES_PER_TOKEN;
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error("Flue model input token budget cannot be encoded safely");
  }
  return limit;
}

function enforceTurnLimit(context: { messages: readonly { role?: unknown }[] }, maxTurns: number): void {
  const completedTurns = context.messages.filter((message) => message.role === "assistant").length;
  if (completedTurns >= maxTurns) {
    throw new Error(`Gardener native profile permits at most ${maxTurns} model turn${maxTurns === 1 ? "" : "s"}`);
  }
}

function deadlineSignal(
  existing: AbortSignal | undefined,
  deadlineAtMs: number,
  maxRuntimeMs: number,
): AbortSignal {
  const remaining = Math.min(deadlineAtMs - Date.now(), maxRuntimeMs);
  if (remaining <= 0) throw new Error("Gardener model runtime budget expired");
  const deadline = AbortSignal.timeout(Math.max(1, Math.ceil(remaining)));
  return existing ? AbortSignal.any([existing, deadline]) : deadline;
}

function resolveActualModel(
  provider: CloudflareProvider,
  encoded: Parameters<CloudflareProvider["stream"]>[0],
  modelId: string,
): Parameters<CloudflareProvider["stream"]>[0] {
  return provider.getModels().find((candidate) => candidate.id === modelId) ?? {
    ...encoded,
    id: modelId,
    name: modelId,
  };
}
