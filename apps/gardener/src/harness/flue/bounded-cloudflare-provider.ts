import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type Model,
  type OpenAICompletionsCompat,
  type Usage,
} from "@earendil-works/pi-ai";
import { convertMessages } from "@earendil-works/pi-ai/api/openai-completions";
import { setProvider } from "@flue/runtime";
import {
  cloudflareBindingProvider,
  type CloudflareAIBinding,
} from "@flue/runtime/cloudflare/workers-ai";
import type { HarnessBudget, JsonValue } from "../types";

const BOUNDED_MODEL_PREFIX = "gardener-bounded-v1";
const MINIMUM_PROVIDER_OUTPUT_TOKENS = 16;
const MAXIMUM_NORMALIZED_RESPONSE_BYTES = 512_000;
const RETRYABLE_INTERRUPTION_MARKER = "(retryable_interruption)";
let installedBinding: CloudflareAIBinding | undefined;
type CloudflareProvider = ReturnType<typeof cloudflareBindingProvider>;
type ProviderModel = Parameters<CloudflareProvider["stream"]>[0];
type ProviderStreamOptions = NonNullable<Parameters<CloudflareProvider["stream"]>[2]>;
type PayloadTransform = ProviderStreamOptions["onPayload"];

// Pinned mirror of Flue 2.0.3's Workers AI chat-completions serializer.
// Keep this synchronized with @flue/runtime's WORKERS_AI_COMPAT profile.
const WORKERS_AI_COMPAT: Omit<
  Required<OpenAICompletionsCompat>,
  "cacheControlFormat" | "deferredToolsMode"
> & {
  cacheControlFormat?: OpenAICompletionsCompat["cacheControlFormat"];
  deferredToolsMode?: OpenAICompletionsCompat["deferredToolsMode"];
} = {
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsReasoningEffort: true,
  supportsUsageInStreaming: true,
  maxTokensField: "max_completion_tokens",
  requiresToolResultName: false,
  requiresAssistantAfterToolResult: false,
  requiresThinkingAsText: false,
  requiresReasoningContentOnAssistantMessages: false,
  thinkingFormat: "openai",
  chatTemplateKwargs: {},
  openRouterRouting: {},
  vercelGatewayRouting: {},
  zaiToolStream: false,
  supportsStrictMode: true,
  supportsOpenAIGrammarTools: false,
  cacheControlFormat: undefined,
  sendSessionAffinityHeaders: true,
  sessionAffinityFormat: "openai",
  supportsLongCacheRetention: false,
};

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
    const actualModel = resolveActualModel(provider, model, budget.model);
    const boundedOptions = boundedProviderOptions(options, budget);
    if (actualModel.api === "cloudflare-ai-binding") {
      // The native model-only payload deliberately omits Flue's framework
      // tools. Its final serialized body is measured after that omission and
      // after schema injection, immediately before AI.run.
      return structuredWorkersAiResponse(binding, actualModel, context, boundedOptions);
    }
    enforceInputLimit(context, budget.maxInputTokens);
    return stream(actualModel, context, boundedOptions);
  }) as typeof provider.stream;

  provider.streamSimple = ((model, context, options) => {
    const budget = decodeBoundedModel(model.id);
    const actualModel = resolveActualModel(provider, model, budget.model);
    const boundedOptions = boundedProviderOptions(options as ProviderStreamOptions | undefined, budget);
    if (actualModel.api === "cloudflare-ai-binding") {
      // See stream(): only the transmitted payload counts for this path.
      return structuredWorkersAiResponse(binding, actualModel, context, boundedOptions);
    }
    enforceInputLimit(context, budget.maxInputTokens);
    return streamSimple(actualModel, context, boundedOptions);
  }) as typeof provider.streamSimple;

  setProvider(provider);
}

function boundedProviderOptions(
  options: ProviderStreamOptions | undefined,
  budget: EncodedBudget,
): ProviderStreamOptions {
  return {
    ...options,
    maxTokens: boundedMaxTokens(options?.maxTokens, budget.maxOutputTokens),
    signal: deadlineSignal(options?.signal, budget.deadlineAtMs, budget.maxRuntimeMs),
    onPayload: structuredPayload(
      options?.onPayload,
      completedDecisionSchema(budget.resultDataSchema),
      budget.maxInputTokens,
    ),
  };
}

/**
 * Workers AI JSON Mode is non-streaming. Flue 2.0.3's binding provider always
 * asks for SSE, so combining its `stream: true` body with `response_format`
 * produces no reliable assistant-text projection. Perform the native call
 * non-streaming and adapt the complete, schema-constrained value back into the
 * same assistant event protocol consumed by Flue's durable runtime.
 */
function structuredWorkersAiResponse(
  binding: CloudflareAIBinding,
  model: ProviderModel,
  context: Context,
  options: ProviderStreamOptions,
) {
  const output = createAssistantMessageEventStream();
  queueMicrotask(async () => {
    try {
      // Flue registers framework-owned tools (for example its task seam) even
      // for a Gardener request whose trusted tool catalog is empty. Model-only
      // Gardener runs must not expose those tools. Deliberately serialize only
      // messages here; tool-bearing Gardener requests are rejected by the
      // adapter before persistence and dispatch.
      const payload = {
        messages: convertMessages(
          model as Model<"openai-completions">,
          context,
          WORKERS_AI_COMPAT,
        ),
        stream: false,
        max_tokens: options.maxTokens,
        ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
        ...reasoningPayload(model, options),
      } as Record<string, unknown>;
      const transformed = await options.onPayload?.(payload, model);
      const finalPayload = transformed === undefined ? payload : transformed;
      if (typeof finalPayload !== "object" || finalPayload === null || Array.isArray(finalPayload)) {
        throw new Error("Gardener structured Workers AI payload is invalid");
      }
      const extraHeaders = bindingHeaders(options);
      let raw: Awaited<ReturnType<CloudflareAIBinding["run"]>>;
      try {
        raw = await binding.run(model.id, finalPayload as Record<string, unknown>, {
          returnRawResponse: true,
          ...(options.signal ? { signal: options.signal } : {}),
          ...(Object.keys(extraHeaders).length > 0 ? { extraHeaders } : {}),
          gateway: { id: "default" },
        });
      } catch (error) {
        if (options.signal?.aborted) throw error;
        // Binding-level rejections have no trustworthy content-free status.
        // Schema and request errors arrive as HTTP responses, so a thrown
        // transport/upstream failure is bounded-retryable at Flue's layer.
        throw new Error(`Workers AI transient binding failure ${RETRYABLE_INTERRUPTION_MARKER}`);
      }
      const native = await readNativeWorkersAiResponse(raw, options, model);
      const text = normalizeNativeResponseText(native.response);
      const usage = normalizeNativeUsage(native.usage);
      const responseId = optionalString(native.response_id);
      const message: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        ...(responseId === undefined ? {} : { responseId }),
        usage,
        stopReason: "stop",
        timestamp: Date.now(),
      };
      const partial: AssistantMessage = { ...message, content: [], stopReason: "pending" };
      const withEmptyText: AssistantMessage = { ...partial, content: [{ type: "text", text: "" }] };
      output.push({ type: "start", partial });
      output.push({ type: "text_start", contentIndex: 0, partial: withEmptyText });
      output.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
      output.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
      output.push({ type: "done", reason: "stop", message });
      output.end(message);
    } catch (error) {
      const aborted = options.signal?.aborted === true;
      const message: AssistantMessage = {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: emptyProviderUsage(),
        stopReason: aborted ? "aborted" : "error",
        errorMessage: aborted
          ? "Gardener structured Workers AI call was aborted"
          : safeProviderError(error),
        timestamp: Date.now(),
      };
      output.push({ type: "error", reason: aborted ? "aborted" : "error", error: message });
      output.end(message);
    }
  });
  return output;
}

async function readNativeWorkersAiResponse(
  raw: Response | Record<string, unknown>,
  options: ProviderStreamOptions,
  model: ProviderModel,
): Promise<Record<string, unknown>> {
  if (raw instanceof Response) {
    const headers: Record<string, string> = {};
    raw.headers.forEach((value, key) => { headers[key] = value; });
    await options.onResponse?.({ status: raw.status, headers }, model);
    if (!raw.ok) {
      if (isRetryableHttpStatus(raw.status)) {
        throw new Error(`Workers AI transient HTTP ${raw.status} ${RETRYABLE_INTERRUPTION_MARKER}`);
      }
      throw new Error(`Workers AI rejected request with HTTP ${raw.status}`);
    }
    const value = await raw.json() as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("Workers AI returned an invalid structured response");
    }
    return value as Record<string, unknown>;
  }
  await options.onResponse?.({ status: 200, headers: {} }, model);
  return raw;
}

function normalizeNativeResponseText(value: unknown): string {
  if (value === undefined) throw new Error("Workers AI structured response is missing response data");
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text || new TextEncoder().encode(text).byteLength > MAXIMUM_NORMALIZED_RESPONSE_BYTES) {
    throw new Error("Workers AI structured response is empty or oversized");
  }
  return text;
}

function normalizeNativeUsage(value: unknown): Usage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return emptyProviderUsage();
  const raw = value as Record<string, unknown>;
  const promptTokens = nonnegativeInteger(raw.prompt_tokens) ?? 0;
  const completionTokens = nonnegativeInteger(raw.completion_tokens) ?? 0;
  const details = typeof raw.prompt_tokens_details === "object" && raw.prompt_tokens_details !== null && !Array.isArray(raw.prompt_tokens_details)
    ? raw.prompt_tokens_details as Record<string, unknown>
    : {};
  const cacheRead = nonnegativeInteger(details.cached_tokens) ?? 0;
  const totalTokens = nonnegativeInteger(raw.total_tokens) ?? promptTokens + completionTokens;
  return {
    input: Math.max(0, promptTokens - cacheRead),
    output: completionTokens,
    cacheRead,
    cacheWrite: 0,
    totalTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function emptyProviderUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function nonnegativeInteger(value: unknown): number | null {
  return Number.isInteger(value) && (value as number) >= 0 ? value as number : null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function bindingHeaders(options: ProviderStreamOptions): Record<string, string> {
  const headers: Record<string, string> = {};
  if (options.sessionId) headers["x-session-affinity"] = options.sessionId;
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    if (value === null) delete headers[name];
    else headers[name] = value;
  }
  return headers;
}

function reasoningPayload(model: ProviderModel, options: ProviderStreamOptions): Record<string, unknown> {
  const reasoning = (options as ProviderStreamOptions & { reasoning?: string }).reasoning;
  if (!model.reasoning || reasoning === undefined || reasoning === "off") return {};
  if (reasoning === "minimal" || reasoning === "low") return { reasoning_effort: "low" };
  if (reasoning === "medium") return { reasoning_effort: "medium" };
  if (reasoning === "high" || reasoning === "xhigh" || reasoning === "max") {
    return { reasoning_effort: "high" };
  }
  return {};
}

function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function safeProviderError(error: unknown): string {
  if (error instanceof Error && /^(Gardener|Workers AI)/u.test(error.message)) return error.message;
  return "Gardener structured Workers AI call failed";
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
