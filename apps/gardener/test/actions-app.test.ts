import { describe, expect, it, vi } from "vitest";
import actionsApp from "../src/task-runtime/actions-app";
import type { Env } from "../src/env";

describe("single public Gardener runtime", () => {
  it("exposes health and only the authenticated session route", async () => {
    const fetch = vi.fn(async (request: Request) =>
      new Response(request.headers.get("x-gardener-session-id"))
    );
    const env = {
      RUNNER_SESSIONS: {
        idFromName: (name: string) => ({ name }),
        get: () => ({ fetch }),
      },
    } as unknown as Env;

    await expect((await actionsApp.fetch(new Request("https://gardener.example/health"), env)).json())
      .resolves.toEqual({ ok: true, service: "gardener-runtime" });
    expect((await actionsApp.fetch(new Request("https://gardener.example/api/runs"), env)).status).toBe(404);
    expect((await actionsApp.fetch(new Request("https://gardener.example/state/run"), env)).status).toBe(404);
    expect((await actionsApp.fetch(new Request("https://gardener.example/session/repo-1/state"), env)).status).toBe(404);

    const response = await actionsApp.fetch(
      new Request("https://gardener.example/session/repo-1-run-2-attempt-1-plan"),
      env,
    );
    expect(await response.text()).toBe("repo-1-run-2-attempt-1-plan");
    expect(fetch).toHaveBeenCalledOnce();
  });
});
