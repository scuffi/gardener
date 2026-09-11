import { setProvider } from "@flue/runtime";
import type { HarnessBudget, JsonValue } from "../types";
import {
  cloudflareBindingProvider,
  type CloudflareAIBinding,
} from "@flue/runtime/cloudflare/workers-ai";

const BOUNDED_MODEL_PREFIX = "gardener-bounded-v1";
const MINIMUM_PROVIDER_OUTPUT_TOKENS = 16;
let installedBinding: CloudflareAIBinding | undefined;
type ProviderStreamOptions = NonNullable<Parameters<ReturnType<typeof cloudflareBindingProvider>["stream"]>[2]>;
type PayloadTransform = ProviderStreamOptions["onPayload"];

interface EncodedBudget {
  model: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxRuntimeMs: number;
  deadlineAtMs: number;
  resultDataSchema: { [key: string]: JsonValue } | null;
}

/** Encode immutable Gardener limits into the Flue submission-scoped model id. */
export function boundedCloudflareModel(
  model: string,
  budget: HarnessBudget,
  resultDataSchema?: { [key: string]: JsonValue },
): string {
  if (budget.maxOutputTokens < MINIMUM_PROVIDER_OUTPUT_TOKENS) {
    throw new Error(`Flue requires an output-token budget of at least ${MINIMUM_PROVIDER_OUTPUT_TOKENS}`);
  }
  const modelId = model.startsWith("cloudflare/") ? model.slice("cloudflare/".length) : model;
  const encodedSchema = encodeBase64Url(JSON.stringify(resultDataSchema ?? null));
  return `cloudflare/${BOUNDED_MODEL_PREFIX}:${budget.maxInputTokens}:${budget.maxOutputTokens}:${budget.maxRuntimeMs}:${Date.parse(budget.deadlineAt)}:${encodeURIComponent(modelId)}:${encodedSchema}`;
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
      onPayload: structuredPayload(
        options?.onPayload,
        completedDecisionSchema(budget.resultDataSchema),
        budget.maxInputTokens,
      ),
    });
  }) as typeof provider.stream;

  provider.streamSimple = ((model, context, options) => {
    const budget = decodeBoundedModel(model.id);
    enforceInputLimit(context, budget.maxInputTokens);
    return streamSimple(resolveActualModel(provider, model, budget.model), context, {
      ...options,
      maxTokens: boundedMaxTokens(options?.maxTokens, budget.maxOutputTokens),
      signal: deadlineSignal(options?.signal, budget.deadlineAtMs, budget.maxRuntimeMs),
      onPayload: structuredPayload(
        options?.onPayload,
        completedDecisionSchema(budget.resultDataSchema),
        budget.maxInputTokens,
      ),
    });
  }) as typeof provider.streamSimple;

  setProvider(provider);
}

function decodeBoundedModel(model: string): EncodedBudget {
  const [prefix, input, output, runtime, deadline, encodedModel, encodedSchema, ...extra] = model.split(":");
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
    || !encodedSchema
  ) throw new Error("Flue model request is missing a valid immutable Gardener budget");
  const decoded = decodeURIComponent(encodedModel);
  if (!decoded || decoded.startsWith("cloudflare/")) {
    throw new Error("Flue model request contains an invalid bounded model id");
  }
  const resultDataSchema = JSON.parse(decodeBase64Url(encodedSchema)) as unknown;
  if (resultDataSchema !== null && (typeof resultDataSchema !== "object" || Array.isArray(resultDataSchema))) {
    throw new Error("Flue model request contains an invalid result schema");
  }
  return {
    model: decoded,
    maxInputTokens,
    maxOutputTokens,
    maxRuntimeMs,
    deadlineAtMs,
    resultDataSchema: resultDataSchema as { [key: string]: JsonValue } | null,
  };
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

function structuredPayload(
  previous: PayloadTransform | undefined,
  schema: { [key: string]: JsonValue },
  maxInputTokens: number,
): NonNullable<PayloadTransform> {
  return async (payload, model) => {
    const overridden = await previous?.(payload, model);
    const structured = structuredProviderPayload(
      overridden === undefined ? payload : overridden,
      model.api,
      schema,
    );
    // This is the final body handed to the Flue provider's AI.run call. It
    // includes the host-owned schema and any earlier trusted transformation.
    enforceInputLimit(structured, maxInputTokens);
    return structured;
  };
}

function structuredProviderPayload(
  payload: unknown,
  api: string,
  schema: { [key: string]: JsonValue },
): unknown {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error("Flue provider produced an unsupported model payload");
  }
  const record = payload as Record<string, unknown>;
  if (api === "openai-responses") {
    const text = typeof record.text === "object" && record.text !== null && !Array.isArray(record.text)
      ? record.text as Record<string, unknown>
      : {};
    return {
      ...record,
      text: {
        ...text,
        format: { type: "json_schema", name: "gardener_harness_decision", strict: true, schema },
      },
    };
  }
  if (api === "cloudflare-ai-binding") {
    return { ...record, response_format: { type: "json_schema", json_schema: schema } };
  }
  if (api === "openai-completions") {
    return {
      ...record,
      response_format: {
        type: "json_schema",
        json_schema: { name: "gardener_harness_decision", strict: true, schema },
      },
    };
  }
  throw new Error(`Gardener structured output is unavailable for Flue model API ${api}`);
}

function completedDecisionSchema(
  resultDataSchema: { [key: string]: JsonValue } | null,
): { [key: string]: JsonValue } {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      status: { const: "completed" },
      result: {
        type: "object",
        additionalProperties: false,
        properties: {
          kind: { enum: ["result", "abstain"] },
          summary: { type: "string", minLength: 1, maxLength: 5_000 },
          data: resultDataSchema ?? {},
        },
        required: ["kind", "summary", "data"],
      },
    },
    required: ["status", "result"],
  };
}

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeBase64Url(value: string): string {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(base64);
  return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
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
