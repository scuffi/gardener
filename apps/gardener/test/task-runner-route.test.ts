import { describe, expect, it, vi } from "vitest";
import { handleRunnerSessionRequest, matchRunnerSessionPath } from "../src/task-runtime/runner-route";
import type { Env } from "../src/env";

describe("public task runner route", () => {
  it("matches only the narrow deterministic session path", () => {
    expect(matchRunnerSessionPath("/session/repo-1-run-2-attempt-1-plan")).toBe("repo-1-run-2-attempt-1-plan");
    expect(matchRunnerSessionPath("/session/repo-1/state")).toBeNull();
    expect(matchRunnerSessionPath("/invoke/repo-1")).toBeNull();
    expect(matchRunnerSessionPath("/api/runs")).toBeNull();
  });

  it("forwards the WebSocket request to exactly one named Durable Object", async () => {
    const fetch = vi.fn(async (request: Request) => new Response(request.headers.get("x-gardener-session-id")));
    const idFromName = vi.fn((name: string) => ({ name }));
    const get = vi.fn(() => ({ fetch }));
    const env = { RUNNER_SESSIONS: { idFromName, get } } as unknown as Env;
    const request = new Request("https://gardener.example/session/repo-1-run-2-attempt-1-plan", {
      headers: { upgrade: "websocket" },
    });
    const response = await handleRunnerSessionRequest(request, env);
    expect(await response.text()).toBe("repo-1-run-2-attempt-1-plan");
    expect(idFromName).toHaveBeenCalledWith("repo-1-run-2-attempt-1-plan");
    expect(new URL(fetch.mock.calls[0]![0].url).pathname).toBe("/rpc");
  });

  it("returns 404 for anything outside the session boundary", async () => {
    const env = {} as Env;
    expect((await handleRunnerSessionRequest(new Request("https://gardener.example/state/run"), env)).status).toBe(404);
  });
});
