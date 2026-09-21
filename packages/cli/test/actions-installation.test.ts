/// <reference types="node" />
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  actionsResourceNames,
  ensurePublicRunnerIngress,
  renderIngressConfig,
  renderRuntimeConfig,
} from "../src/actions-installation";

const originalToken = process.env.CLOUDFLARE_API_TOKEN;
afterEach(() => {
  vi.unstubAllGlobals();
  if (originalToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
  else process.env.CLOUDFLARE_API_TOKEN = originalToken;
});

describe("Actions-native installation topology", () => {
  it("derives isolated deterministic Cloudflare names", () => {
    expect(actionsResourceNames("demo-team")).toEqual({
      database: "gardener-demo-team",
      runtimeWorker: "gardener-demo-team-runtime",
      ingressWorker: "gardener-demo-team-runner-ingress",
    });
    expect(() => actionsResourceNames("Invalid Workspace")).toThrow();
  });

  it("creates an exact-host Access bypass only when the account intercepts ingress", async () => {
    process.env.CLOUDFLARE_API_TOKEN = "test-token";
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith("/health")) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://team.cloudflareaccess.com/cdn-cgi/access/login" },
        });
      }
      if (url.includes("/access/apps?")) return Response.json({ success: true, result: [] });
      if (url.endsWith("/access/apps") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        expect(body).toMatchObject({
          domain: "runner.example.workers.dev",
          type: "self_hosted",
          policies: [{ decision: "bypass", include: [{ everyone: {} }] }],
        });
        expect(new Headers(init.headers).get("authorization")).toBe("Bearer test-token");
        return Response.json({ success: true, result: { id: "access-app-1" } });
      }
      throw new Error(`Unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetch);

    await expect(ensurePublicRunnerIngress({
      accountId: "account-1",
      workspace: "demo-team",
      ingressOrigin: "https://runner.example.workers.dev",
      existingAppId: null,
    }, 0)).resolves.toBe("access-app-1");
  });

  it("renders a private runtime and one narrow public ingress binding", () => {
    const sourceRoot = "/trusted/gardener";
    const names = actionsResourceNames("demo-team");
    const runtime = JSON.parse(renderRuntimeConfig({
      names,
      databaseId: "11111111-1111-4111-8111-111111111111",
      sourceRoot,
      workspace: "demo-team",
    })) as Record<string, any>;
    const ingress = JSON.parse(renderIngressConfig({ names, sourceRoot })) as Record<string, any>;

    expect(runtime.name).toBe(names.runtimeWorker);
    expect(runtime.main).toBe(join(sourceRoot, "apps/gardener/dist/gardener_actions_v1_runtime/index.js"));
    expect(runtime.workers_dev).toBe(false);
    expect(runtime.d1_databases).toEqual([expect.objectContaining({
      database_name: names.database,
      database_id: "11111111-1111-4111-8111-111111111111",
    })]);
    expect(runtime.vars).toMatchObject({
      GARDENER_WORKSPACE_ID: "demo-team",
      GARDENER_DEPLOYMENT_MODE: "actions-v1",
      LOCAL_DEV_BYPASS: "false",
    });
    expect(runtime).not.toHaveProperty("assets");

    expect(ingress.name).toBe(names.ingressWorker);
    expect(ingress.workers_dev).toBe(true);
    expect(ingress.services).toEqual([{
      binding: "GARDENER",
      service: names.runtimeWorker,
      entrypoint: "GardenerRunnerIngressEntrypoint",
    }]);
    expect(JSON.stringify(ingress)).not.toContain("DB");
    expect(JSON.stringify(ingress)).not.toContain("AI");
  });
});
