import { describe, expect, it, vi } from "vitest";
import worker from "../src/index";

describe("narrow public runner ingress", () => {
  it("exposes health and only proxies the exact session route", async () => {
    const fetch = vi.fn(async (request: Request) =>
      new URL(request.url).pathname === "/health"
        ? Response.json({ ok: true, service: "gardener-actions-runtime" })
        : new Response("proxied")
    );
    const env = { GARDENER: { fetch } };

    expect(await (await worker.fetch(new Request("https://runner.example/health"), env)).json())
      .toEqual({ ok: true, service: "gardener-runner-ingress", runtime: true });
    expect((await worker.fetch(new Request("https://runner.example/api/runs"), env)).status).toBe(404);
    expect((await worker.fetch(new Request("https://runner.example/state/run"), env)).status).toBe(404);
    const response = await worker.fetch(new Request("https://runner.example/session/repo-1-run-2-attempt-1-plan"), env);
    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
