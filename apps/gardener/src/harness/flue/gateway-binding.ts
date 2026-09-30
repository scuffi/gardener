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
): CloudflareAIBinding {
  return {
    run(modelId, inputs, options) {
      if (modelId.startsWith("@cf/")) return fallback.run(modelId, inputs, options);
      const request = gatewayRequest(config, modelId, inputs, options);
      return fetcher(request.url, request.init).catch((error: unknown) => {
        // Aborts are the run's own deadline; keep them recognisable.
        if (request.init.signal?.aborted || (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"))) {
          throw error;
        }
        throw new Error(`${GATEWAY_UNREACHABLE}: the AI Gateway could not be reached`, { cause: error });
      });
    },
  };
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
