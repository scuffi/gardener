import { describe, expect, it, vi } from "vitest";
import {
  GATEWAY_ATTEMPTS,
  gatewayModelBinding,
  gatewayRequest,
  modelGatewayConfig,
  taskModelBinding,
  type ModelGatewayConfig,
} from "../src/harness/flue/gateway-binding";

const config: ModelGatewayConfig = { accountId: "acct", gatewayId: "gw", token: "secret-token", project: "agents-team-gardener" };
const base = "https://gateway.ai.cloudflare.com/v1/acct/gw";
const noWait = async () => {};

describe("external AI Gateway binding", () => {
  it("is configured by its account and gateway vars", () => {
    expect(modelGatewayConfig({})).toBeNull();
    // A leftover token alone, as after turning the gateway off, means none.
    expect(modelGatewayConfig({ GARDENER_AI_GATEWAY_TOKEN: "t" })).toBeNull();
    expect(modelGatewayConfig({
      GARDENER_AI_GATEWAY_ACCOUNT_ID: "acct",
      GARDENER_AI_GATEWAY_ID: "gw",
      GARDENER_AI_GATEWAY_TOKEN: " t ",
    })).toEqual({ accountId: "acct", gatewayId: "gw", token: "t", project: null });
    expect(() => modelGatewayConfig({ GARDENER_AI_GATEWAY_ACCOUNT_ID: "acct", GARDENER_AI_GATEWAY_ID: "gw" }))
      .toThrow(/partially configured/);
    expect(() => modelGatewayConfig({ GARDENER_AI_GATEWAY_ID: "gw", GARDENER_AI_GATEWAY_TOKEN: "t" }))
      .toThrow(/partially configured/);
    expect(() => modelGatewayConfig({
      GARDENER_AI_GATEWAY_ACCOUNT_ID: "acct/../x",
      GARDENER_AI_GATEWAY_ID: "gw",
      GARDENER_AI_GATEWAY_TOKEN: "t",
    })).toThrow(/malformed/);
  });

  it("routes each provider prefix to its native gateway endpoint", () => {
    const anthropic = gatewayRequest(config, "anthropic/claude-opus-5-5", { stream: true, model: "anthropic/claude-opus-5-5" }, undefined);
    expect(anthropic.url).toBe(`${base}/anthropic/v1/messages`);
    expect(JSON.parse(anthropic.init.body as string)).toEqual({ stream: true, model: "claude-opus-5-5" });
    expect(anthropic.init.headers).toMatchObject({ "anthropic-version": "2023-06-01" });

    const openai = gatewayRequest(config, "openai/gpt-6.1-sol", { input: [] }, undefined);
    expect(openai.url).toBe(`${base}/openai/responses`);
    expect(JSON.parse(openai.init.body as string)).toEqual({ input: [], model: "gpt-6.1-sol" });
    expect(openai.init.headers).not.toHaveProperty("anthropic-version");

    const other = gatewayRequest(config, "google-ai-studio/gemini-3.5-flash", { messages: [] }, undefined);
    expect(other.url).toBe(`${base}/compat/chat/completions`);
    expect(JSON.parse(other.init.body as string).model).toBe("google-ai-studio/gemini-3.5-flash");

    expect(() => gatewayRequest(config, "claude", {}, undefined)).toThrow(/needs a provider prefix/);
  });

  it("authenticates with the configured token only and tags the project", () => {
    const controller = new AbortController();
    const request = gatewayRequest(config, "openai/gpt-6.1-sol", {}, {
      returnRawResponse: true,
      signal: controller.signal,
      gateway: { id: "default" },
      extraHeaders: {
        "x-session-affinity": "s1",
        "cf-aig-request-timeout": "1000",
        Authorization: "Bearer injected",
        "x-api-key": "injected",
        "cf-aig-authorization": "Bearer injected",
      },
    });
    expect(request.init.headers).toEqual({
      "x-session-affinity": "s1",
      "cf-aig-request-timeout": "1000",
      "content-type": "application/json",
      "cf-aig-authorization": "Bearer secret-token",
      "cf-aig-metadata": JSON.stringify({ project: "agents-team-gardener" }),
    });
    expect(request.init.signal).toBe(controller.signal);
    expect(request.init.method).toBe("POST");
    expect(gatewayRequest({ ...config, project: null }, "openai/x", {}, undefined).init.headers)
      .not.toHaveProperty("cf-aig-metadata");
  });

  it("keeps Workers AI models on the account's own binding", async () => {
    const fallback = { run: vi.fn(async () => new Response("binding")) };
    const fetcher = vi.fn(async () => new Response("gateway"));
    const binding = gatewayModelBinding(config, fallback, fetcher as unknown as typeof fetch);
    const options = { returnRawResponse: true };
    await binding.run("@cf/zai-org/glm-5.3", { messages: [] }, options);
    expect(fallback.run).toHaveBeenCalledWith("@cf/zai-org/glm-5.3", { messages: [] }, options);
    expect(fetcher).not.toHaveBeenCalled();
    const response = await binding.run("anthropic/claude-sonnet-5-5", {}, options) as Response;
    expect(await response.text()).toBe("gateway");
    expect(fetcher).toHaveBeenCalledWith(`${base}/anthropic/v1/messages`, expect.objectContaining({ method: "POST" }));
  });

  it("marks an unreachable gateway after retrying, but keeps the run's own aborts", async () => {
    const fallback = { run: vi.fn() };
    const failing = vi.fn(async () => { throw new TypeError("fetch failed"); });
    const waits: number[] = [];
    const unreachable = gatewayModelBinding(config, fallback, failing as unknown as typeof fetch, async (ms) => { waits.push(ms); });
    await expect(unreachable.run("openai/gpt-6.1-sol", {}, {})).rejects.toThrow(/gardener_ai_gateway_unreachable/);
    expect(failing).toHaveBeenCalledTimes(GATEWAY_ATTEMPTS);
    expect(waits).toEqual([1_000, 4_000]);
    const aborted = new AbortController();
    aborted.abort();
    const abortError = new DOMException("aborted", "AbortError");
    const abortingFetch = vi.fn(async () => { throw abortError; });
    const aborting = gatewayModelBinding(config, fallback, abortingFetch as unknown as typeof fetch, noWait);
    await expect(aborting.run("openai/gpt-6.1-sol", {}, { signal: aborted.signal })).rejects.toBe(abortError);
    expect(abortingFetch).toHaveBeenCalledTimes(1);
  });

  it("retries overloaded and failing providers before any response streams", async () => {
    const fallback = { run: vi.fn() };
    const responses = [new Response("busy", { status: 503 }), new Response("overloaded", { status: 529 }), new Response("ok")];
    const fetcher = vi.fn(async () => responses.shift()!);
    const waits: number[] = [];
    const binding = gatewayModelBinding(config, fallback, fetcher as unknown as typeof fetch, async (ms) => { waits.push(ms); });
    const response = await binding.run("anthropic/claude-opus-5-5", {}, {}) as Response;
    expect(await response.text()).toBe("ok");
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(waits).toEqual([1_000, 4_000]);
    // Every attempt sends the same request.
    const [first, second] = fetcher.mock.calls as unknown as [string, RequestInit][];
    expect(second).toEqual(first);
  });

  it("returns the last failure after the final attempt, and never retries a client error", async () => {
    const fallback = { run: vi.fn() };
    const alwaysBusy = vi.fn(async () => new Response("busy", { status: 503 }));
    const busy = gatewayModelBinding(config, fallback, alwaysBusy as unknown as typeof fetch, noWait);
    expect(((await busy.run("openai/gpt-6.1-sol", {}, {})) as Response).status).toBe(503);
    expect(alwaysBusy).toHaveBeenCalledTimes(GATEWAY_ATTEMPTS);
    for (const status of [400, 401, 404, 413]) {
      const rejecting = vi.fn(async () => new Response("no", { status }));
      const binding = gatewayModelBinding(config, fallback, rejecting as unknown as typeof fetch, noWait);
      expect(((await binding.run("openai/gpt-6.1-sol", {}, {})) as Response).status).toBe(status);
      expect(rejecting).toHaveBeenCalledTimes(1);
    }
  });

  it("honours a short Retry-After and gives up on a long one", async () => {
    const fallback = { run: vi.fn() };
    const waits: number[] = [];
    const short = [new Response("slow down", { status: 429, headers: { "retry-after": "7" } }), new Response("ok")];
    const shortFetch = vi.fn(async () => short.shift()!);
    await gatewayModelBinding(config, fallback, shortFetch as unknown as typeof fetch, async (ms) => { waits.push(ms); })
      .run("openai/gpt-6.1-sol", {}, {});
    expect(waits).toEqual([7_000]);
    const longFetch = vi.fn(async () => new Response("later", { status: 429, headers: { "retry-after": "3600" } }));
    const long = await gatewayModelBinding(config, fallback, longFetch as unknown as typeof fetch, noWait)
      .run("openai/gpt-6.1-sol", {}, {}) as Response;
    expect(long.status).toBe(429);
    expect(longFetch).toHaveBeenCalledTimes(1);
  });

  it("stops waiting to retry when the run's deadline passes", async () => {
    const fallback = { run: vi.fn() };
    const deadline = new AbortController();
    const fetcher = vi.fn(async () => {
      deadline.abort(new DOMException("deadline", "TimeoutError"));
      return new Response("busy", { status: 503 });
    });
    const binding = gatewayModelBinding(config, fallback, fetcher as unknown as typeof fetch);
    await expect(binding.run("openai/gpt-6.1-sol", {}, { signal: deadline.signal })).rejects.toThrow(/deadline/);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("uses the AI binding alone when no gateway is configured, and one gateway binding per AI binding", () => {
    const AI = { run: vi.fn() };
    expect(taskModelBinding({ AI })).toBe(AI);
    const env = { AI, GARDENER_AI_GATEWAY_ACCOUNT_ID: "acct", GARDENER_AI_GATEWAY_ID: "gw", GARDENER_AI_GATEWAY_TOKEN: "t" };
    const first = taskModelBinding(env);
    expect(first).not.toBe(AI);
    expect(taskModelBinding(env)).toBe(first);
  });
});
