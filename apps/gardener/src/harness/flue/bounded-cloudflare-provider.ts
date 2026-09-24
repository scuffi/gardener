import { setProvider } from "@flue/runtime";
import {
  cloudflareBindingProvider,
  type CloudflareAIBinding,
} from "@flue/runtime/cloudflare/workers-ai";
import type { HarnessBudget } from "../types";
import { INPUT_BYTES_PER_TOKEN } from "./input-budget";

const NATIVE_BOUNDED_MODEL_PREFIX = "gardener-native-bounded-v3";
const MINIMUM_PROVIDER_OUTPUT_TOKENS = 16;
let installedBinding: CloudflareAIBinding | undefined;

type CloudflareProvider = ReturnType<typeof cloudflareBindingProvider>;
type ProviderStreamOptions = NonNullable<Parameters<CloudflareProvider["stream"]>[2]>;

interface EncodedBudget {
  model: string;
  maxTurns: number;
  maxInputBytes: number;
  maxOutputTokens: number;
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
  return `cloudflare/${NATIVE_BOUNDED_MODEL_PREFIX}:${budget.maxTurns}:${maxInputBytes}:${budget.maxOutputTokens}:${budget.maxRuntimeMs}:${Date.parse(budget.deadlineAt)}:${encodeURIComponent(modelId)}`;
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
      boundedProviderOptions(options, context, budget),
    );
  }) as typeof provider.stream;

  provider.streamSimple = ((model, context, options) => {
    const budget = decodeBoundedModel(model.id);
    enforceTurnLimit(context, budget.maxTurns);
    enforceInputByteLimit(context, budget.maxInputBytes);
    return streamSimple(
      resolveActualModel(provider, model, budget.model),
      context,
      boundedProviderOptions(options as ProviderStreamOptions | undefined, context, budget),
    );
  }) as typeof provider.streamSimple;

  setProvider(provider);
}

function boundedProviderOptions(
  options: ProviderStreamOptions | undefined,
  context: { messages: readonly { role?: unknown; usage?: { output?: unknown } }[] },
  budget: EncodedBudget,
): ProviderStreamOptions {
  const remainingOutputTokens = outputTokensRemaining(context, budget.maxOutputTokens);
  return {
    ...options,
    maxTokens: options?.maxTokens === undefined
      ? remainingOutputTokens
      : Math.min(options.maxTokens, remainingOutputTokens),
    signal: deadlineSignal(options?.signal, budget.deadlineAtMs, budget.maxRuntimeMs),
  };
}

function decodeBoundedModel(model: string): EncodedBudget {
  const [prefix, turns, input, output, runtime, deadline, encodedModel, ...extra] = model.split(":");
  const maxTurns = Number(turns);
  const maxInputBytes = Number(input);
  const maxOutputTokens = Number(output);
  const maxRuntimeMs = Number(runtime);
  const deadlineAtMs = Number(deadline);
  if (
    prefix !== NATIVE_BOUNDED_MODEL_PREFIX
    || extra.length > 0
    || !Number.isSafeInteger(maxTurns)
    || maxTurns < 1
    || !Number.isSafeInteger(maxInputBytes)
    || maxInputBytes < 1
    || !Number.isSafeInteger(maxOutputTokens)
    || maxOutputTokens < MINIMUM_PROVIDER_OUTPUT_TOKENS
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
  return { model: decoded, maxTurns, maxInputBytes, maxOutputTokens, maxRuntimeMs, deadlineAtMs };
}

function outputTokensRemaining(
  context: { messages: readonly { role?: unknown; usage?: { output?: unknown } }[] },
  maxOutputTokens: number,
): number {
  const used = context.messages.reduce((total, message) => {
    if (message.role !== "assistant") return total;
    const output = message.usage?.output;
    if (!Number.isSafeInteger(output) || (output as number) < 0) {
      throw new Error("Flue assistant history is missing output-token usage");
    }
    return total + (output as number);
  }, 0);
  const remaining = maxOutputTokens - used;
  if (remaining < MINIMUM_PROVIDER_OUTPUT_TOKENS) {
    throw new Error("Gardener model output-token budget is exhausted");
  }
  return remaining;
}

function enforceInputByteLimit(value: unknown, maxInputBytes: number): void {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("Flue model input could not be measured");
  if (new TextEncoder().encode(serialized).byteLength > maxInputBytes) {
    throw new Error(`Flue model input exceeds its immutable ${maxInputBytes}-byte safety limit`);
  }
}

function inputByteLimit(maxInputTokens: number): number {
  const limit = maxInputTokens * INPUT_BYTES_PER_TOKEN;
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
