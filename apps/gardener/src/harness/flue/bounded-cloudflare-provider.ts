import { setProvider } from "@flue/runtime";
import type { HarnessBudget } from "../types";
import {
  cloudflareBindingProvider,
  type CloudflareAIBinding,
} from "@flue/runtime/cloudflare/workers-ai";

const BOUNDED_MODEL_PREFIX = "gardener-bounded-v1";
const MINIMUM_PROVIDER_OUTPUT_TOKENS = 16;
let installedBinding: CloudflareAIBinding | undefined;

interface EncodedBudget {
  model: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxRuntimeMs: number;
  deadlineAtMs: number;
}

/** Encode immutable Gardener limits into the Flue submission-scoped model id. */
export function boundedCloudflareModel(model: string, budget: HarnessBudget): string {
  if (budget.maxOutputTokens < MINIMUM_PROVIDER_OUTPUT_TOKENS) {
    throw new Error(`Flue requires an output-token budget of at least ${MINIMUM_PROVIDER_OUTPUT_TOKENS}`);
  }
  const modelId = model.startsWith("cloudflare/") ? model.slice("cloudflare/".length) : model;
  return `cloudflare/${BOUNDED_MODEL_PREFIX}:${budget.maxInputTokens}:${budget.maxOutputTokens}:${budget.maxRuntimeMs}:${Date.parse(budget.deadlineAt)}:${encodeURIComponent(modelId)}`;
}

/** Register a Flue-native provider wrapper that enforces limits before AI.run. */
export function installBoundedCloudflareProvider(binding: CloudflareAIBinding): void {
  if (installedBinding === binding) return;
  installedBinding = binding;
  const provider = cloudflareBindingProvider({ binding });
  const stream = provider.stream.bind(provider);
  const streamSimple = provider.streamSimple.bind(provider);

  provider.stream = ((model, context, options) => {
    const budget = decodeBoundedModel(model.id);
    enforceInputLimit(context, budget.maxInputTokens);
    return stream(resolveActualModel(provider, model, budget.model), context, {
      ...options,
      maxTokens: boundedMaxTokens(options?.maxTokens, budget.maxOutputTokens),
      signal: deadlineSignal(options?.signal, budget.deadlineAtMs, budget.maxRuntimeMs),
    });
  }) as typeof provider.stream;

  provider.streamSimple = ((model, context, options) => {
    const budget = decodeBoundedModel(model.id);
    enforceInputLimit(context, budget.maxInputTokens);
    return streamSimple(resolveActualModel(provider, model, budget.model), context, {
      ...options,
      maxTokens: boundedMaxTokens(options?.maxTokens, budget.maxOutputTokens),
      signal: deadlineSignal(options?.signal, budget.deadlineAtMs, budget.maxRuntimeMs),
    });
  }) as typeof provider.streamSimple;

  setProvider(provider);
}

function decodeBoundedModel(model: string): EncodedBudget {
  const [prefix, input, output, runtime, deadline, encodedModel, ...extra] = model.split(":");
  const maxInputTokens = Number(input);
  const maxOutputTokens = Number(output);
  const maxRuntimeMs = Number(runtime);
  const deadlineAtMs = Number(deadline);
  if (
    prefix !== BOUNDED_MODEL_PREFIX
    || extra.length > 0
    || !Number.isSafeInteger(maxInputTokens)
    || maxInputTokens < 1
    || !Number.isSafeInteger(maxOutputTokens)
    || maxOutputTokens < MINIMUM_PROVIDER_OUTPUT_TOKENS
    || !Number.isSafeInteger(maxRuntimeMs)
    || maxRuntimeMs < 1
    || !Number.isSafeInteger(deadlineAtMs)
    || deadlineAtMs < 1
    || !encodedModel
  ) throw new Error("Flue model request is missing a valid immutable Gardener budget");
  const decoded = decodeURIComponent(encodedModel);
  if (!decoded || decoded.startsWith("cloudflare/")) {
    throw new Error("Flue model request contains an invalid bounded model id");
  }
  return { model: decoded, maxInputTokens, maxOutputTokens, maxRuntimeMs, deadlineAtMs };
}

function enforceInputLimit(context: unknown, maxInputTokens: number): void {
  const serialized = JSON.stringify(context);
  if (serialized === undefined) throw new Error("Flue model input could not be measured");
  // A tokenizer cannot emit more tokens than the UTF-8 bytes it consumes.
  // Measuring the complete provider context is deliberately conservative and
  // includes message framing rather than estimating only the user prompt.
  const upperBound = new TextEncoder().encode(serialized).byteLength;
  if (upperBound > maxInputTokens) {
    throw new Error(`Flue model input exceeds its immutable ${maxInputTokens}-token budget`);
  }
}

function boundedMaxTokens(requested: number | undefined, maximum: number): number {
  return requested === undefined ? maximum : Math.min(requested, maximum);
}

function deadlineSignal(existing: AbortSignal | undefined, deadlineAtMs: number, maxRuntimeMs: number): AbortSignal {
  const remaining = Math.min(deadlineAtMs - Date.now(), maxRuntimeMs);
  if (remaining <= 0) throw new Error("Gardener model runtime budget expired");
  const deadline = AbortSignal.timeout(Math.max(1, Math.ceil(remaining)));
  return existing ? AbortSignal.any([existing, deadline]) : deadline;
}

function resolveActualModel(
  provider: ReturnType<typeof cloudflareBindingProvider>,
  encoded: Parameters<typeof provider.stream>[0],
  modelId: string,
): Parameters<typeof provider.stream>[0] {
  return provider.getModels().find((candidate) => candidate.id === modelId) ?? {
    ...encoded,
    id: modelId,
    name: modelId,
  };
}
