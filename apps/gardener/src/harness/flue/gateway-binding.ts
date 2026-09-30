import type { CloudflareAIBinding } from "@flue/runtime/cloudflare/workers-ai";

/**
 * An AI Gateway reached over HTTPS rather than through the `AI` binding, so it
 * can live in another Cloudflare account. The token authenticates to the
 * gateway (`cf-aig-authorization`); provider keys or billing live on the
 * gateway, never in Gardener.
 */
export interface ModelGatewayConfig {
  accountId: string;
  gatewayId: string;
  token: string;
  /** Sent as `cf-aig-metadata: {"project": …}` on every request, for attribution. */
  project: string | null;
}

export interface ModelGatewayEnv {
  GARDENER_AI_GATEWAY_ACCOUNT_ID?: string;
  GARDENER_AI_GATEWAY_ID?: string;
  GARDENER_AI_GATEWAY_PROJECT?: string;
  GARDENER_AI_GATEWAY_TOKEN?: string;
}

const GATEWAY_ORIGIN = "https://gateway.ai.cloudflare.com";
/** Marks a network failure reaching the gateway, for the run's failure summary. */
export const GATEWAY_UNREACHABLE = "gardener_ai_gateway_unreachable";
const ANTHROPIC_VERSION = "2023-06-01";
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * The installation's external gateway, or null when none is configured. The
 * account and gateway vars decide: a leftover token alone means none, so
 * turning the gateway off never leaves runs half-configured. A gateway without
 * its token throws rather than silently using the account's own gateway.
 */
export function modelGatewayConfig(env: ModelGatewayEnv): ModelGatewayConfig | null {
  const accountId = env.GARDENER_AI_GATEWAY_ACCOUNT_ID?.trim() || undefined;
  const gatewayId = env.GARDENER_AI_GATEWAY_ID?.trim() || undefined;
  const token = env.GARDENER_AI_GATEWAY_TOKEN?.trim() || undefined;
  const project = env.GARDENER_AI_GATEWAY_PROJECT?.trim() || null;
  if (!accountId && !gatewayId) return null;
  if (!accountId || !gatewayId || !token) {
    throw new Error("Gardener's AI Gateway is partially configured; redeploy with the gateway account, gateway ID and token");
  }
  if (!IDENTIFIER.test(accountId) || !IDENTIFIER.test(gatewayId)) {
    throw new Error("Gardener's AI Gateway account or gateway ID is malformed");
  }
  return { accountId, gatewayId, token, project };
}

/**
 * A binding for Flue's Workers AI provider. `@cf/…` models run on the
 * account's own Workers AI through `fallback`; every other model goes to the
 * external gateway, in the request format Flue already chose for its prefix.
 */
export function gatewayModelBinding(
  config: ModelGatewayConfig,
  fallback: CloudflareAIBinding,
  fetcher: typeof fetch = fetch,
  wait: (ms: number, signal: AbortSignal | undefined) => Promise<void> = sleep,
): CloudflareAIBinding {
  return {
    run(modelId, inputs, options) {
      if (modelId.startsWith("@cf/")) return fallback.run(modelId, inputs, options);
      const request = gatewayRequest(config, modelId, inputs, options);
      return fetchWithRetries(request, fetcher, wait);
    },
  };
}

/** Attempts per model call: the first, and up to two retries. */
export const GATEWAY_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [1_000, 4_000];
/** The longest `Retry-After` honoured; a longer one ends the call instead. */
const MAX_RETRY_AFTER_MS = 30_000;
/** Overload and outage statuses worth another attempt: rate limits, 5xx, and Anthropic's 529. */
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504, 529]);

/**
 * One model call, retried on a network failure or a retryable status. Only
 * whole responses are retried: a status arrives before any of the stream, so
 * nothing the model produced is ever replayed or duplicated. The run's
 * deadline signal ends the waits as well as the requests.
 *
 * A 500 or 504 can arrive after the provider finished the work, so a retry may
 * be billed twice while only the response returned counts against the run's
 * `output-tokens`: the budget bounds the run, not the exact spend.
 */
async function fetchWithRetries(
  request: { url: string; init: RequestInit },
  fetcher: typeof fetch,
  wait: (ms: number, signal: AbortSignal | undefined) => Promise<void>,
): Promise<Response> {
  const signal = request.init.signal ?? undefined;
  for (let attempt = 1; ; attempt += 1) {
    const last = attempt >= GATEWAY_ATTEMPTS;
    let response: Response;
    try {
      response = await fetcher(request.url, request.init);
    } catch (error) {
      // Aborts are the run's own deadline; keep them recognisable.
      if (signal?.aborted || (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"))) {
        throw error;
      }
      if (last) throw new Error(`${GATEWAY_UNREACHABLE}: the AI Gateway could not be reached`, { cause: error });
      await wait(RETRY_DELAYS_MS[attempt - 1]!, signal);
      continue;
    }
    if (last || !RETRYABLE_STATUSES.has(response.status)) return response;
    const delay = retryDelay(response.headers.get("retry-after"), RETRY_DELAYS_MS[attempt - 1]!);
    if (delay === null) return response;
    // A body that already failed cannot be cancelled, and need not be.
    await response.body?.cancel().catch(() => undefined);
    await wait(delay, signal);
  }
}

/** The wait before the next attempt, or null when the provider asks for longer than a run should sit idle. */
function retryDelay(retryAfter: string | null, fallbackMs: number): number | null {
  if (!retryAfter) return fallbackMs;
  const seconds = Number(retryAfter);
  const ms = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(retryAfter) - Date.now();
  if (!Number.isFinite(ms)) return fallbackMs;
  if (ms > MAX_RETRY_AFTER_MS) return null;
  return Math.max(fallbackMs, ms);
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

const installed = new WeakMap<CloudflareAIBinding, CloudflareAIBinding>();

/**
 * The binding task agents call models through: `ai` alone without a gateway,
 * otherwise the gateway binding. One per `AI` binding, so the bounded provider
 * is installed once per isolate.
 */
export function taskModelBinding(env: ModelGatewayEnv & { AI: CloudflareAIBinding }): CloudflareAIBinding {
  const config = modelGatewayConfig(env);
  if (!config) return env.AI;
  const existing = installed.get(env.AI);
  if (existing) return existing;
  const binding = gatewayModelBinding(config, env.AI);
  installed.set(env.AI, binding);
  return binding;
}

/** Exported for tests: the HTTPS request for one model call. */
export function gatewayRequest(
  config: ModelGatewayConfig,
  modelId: string,
  inputs: Record<string, unknown>,
  options: Record<string, unknown> | undefined,
): { url: string; init: RequestInit } {
  const base = `${GATEWAY_ORIGIN}/v1/${config.accountId}/${config.gatewayId}`;
  const route = gatewayRoute(modelId);
  const headers: Record<string, string> = {
    ...stringHeaders(options?.extraHeaders),
    "content-type": "application/json",
    "cf-aig-authorization": `Bearer ${config.token}`,
  };
  if (config.project) headers["cf-aig-metadata"] = JSON.stringify({ project: config.project });
  if (route.anthropic) headers["anthropic-version"] = ANTHROPIC_VERSION;
  const signal = options?.signal instanceof AbortSignal ? options.signal : undefined;
  return {
    url: `${base}/${route.path}`,
    init: {
      method: "POST",
      headers,
      body: JSON.stringify({ ...inputs, model: route.model }),
      ...(signal ? { signal } : {}),
    },
  };
}

function gatewayRoute(modelId: string): { path: string; model: string; anthropic: boolean } {
  const slash = modelId.indexOf("/");
  const vendor = slash > 0 ? modelId.slice(0, slash) : "";
  const model = slash > 0 ? modelId.slice(slash + 1) : "";
  if (!vendor || !model) {
    throw new Error(`Model ${modelId} needs a provider prefix, such as anthropic/ or openai/, to use the AI Gateway`);
  }
  if (vendor === "anthropic") return { path: "anthropic/v1/messages", model, anthropic: true };
  if (vendor === "openai") return { path: "openai/responses", model, anthropic: false };
  // Other providers go through the gateway's OpenAI-compatible endpoint,
  // which takes the full `provider/model` id.
  return { path: "compat/chat/completions", model: modelId, anthropic: false };
}

function stringHeaders(value: unknown): Record<string, string> {
  if (value === null || typeof value !== "object") return {};
  const headers: Record<string, string> = {};
  for (const [name, header] of Object.entries(value)) {
    const lower = name.toLowerCase();
    // Credentials come only from the configuration.
    if (lower === "authorization" || lower === "x-api-key" || lower.startsWith("cf-aig-authorization")) continue;
    if (typeof header === "string") headers[name] = header;
  }
  return headers;
}
