import { afterEach, describe, expect, it, vi } from "vitest";
import { gardenerApi } from "./api";

afterEach(() => vi.unstubAllGlobals());
function respond(body: unknown) {
  const fetch = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("Agent-native dashboard API", () => {
  it("uses the Agent collection rather than legacy authoring endpoints", async () => {
    const fetch = respond({ agents: [] });
    await gardenerApi.agents();
    expect(fetch).toHaveBeenCalledWith("/api/agents", expect.objectContaining({ credentials: "same-origin" }));
  });

  it("publishes source as a paused revision request", async () => {
    const fetch = respond({ revision: 2, paused: true });
    await gardenerApi.publishAgent("agent/one", "---\nschema: gardener.agent/v1\n---");
    expect(fetch).toHaveBeenCalledWith("/api/agents/agent%2Fone/revisions", expect.objectContaining({
      method: "POST",
      body: expect.stringContaining("sourceMd"),
    }));
  });

  it("keeps activation and enablement as separate calls", async () => {
    const fetch = respond({ activated: true });
    await gardenerApi.activateAgentRevision("a", 3);
    await gardenerApi.setAgentEnabled("a", true);
    expect(fetch.mock.calls.map(([path]) => path)).toEqual([
      "/api/agents/a/revisions/3/activate",
      "/api/agents/a/status",
    ]);
  });
});
