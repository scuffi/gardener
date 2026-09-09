import { describe, expect, it, vi } from "vitest";
import type { AuthInfo } from "@modelcontextprotocol/server";
import type { GardenerMcpTokenProps } from "../src/mcp/auth-context";
import { redactAndBoundOutput } from "../src/mcp/redaction";
import { GARDENER_MCP_TOOL_SCOPES, type GardenerMcpScope } from "../src/mcp/scopes";
import { createGardenerStatelessMcpHandler } from "../src/mcp/server";
import type { GardenerMcpServices, JsonObject } from "../src/mcp/services";

const audience = "https://gardener.example.test/mcp";

function services(overrides: Partial<GardenerMcpServices["agents"]> = {}): GardenerMcpServices {
  const value = (name: string): JsonObject => ({ name });
  return {
    agents: {
      list: vi.fn(async () => ({ agents: [], nextCursor: null })),
      get: vi.fn(async () => value("get")),
      catalog: vi.fn(async () => value("catalog")),
      validate: vi.fn(async () => value("validate")),
      explain: vi.fn(async () => value("explain")),
      diff: vi.fn(async () => value("diff")),
      simulate: vi.fn(async () => ({ mode: "dry-run", executed: false })),
      savePausedDraft: vi.fn(async () => ({
        lifecycle: "paused_draft" as const,
        draftId: "draft-1",
        contentHash: "abcdefghijklmnop",
        updatedAt: "2026-09-09T10:00:00.000Z",
        active: false as const,
        enabled: false as const,
        immutableRevisionCreated: false as const,
      })),
      ...overrides,
    },
    runs: { getTrace: vi.fn(async () => value("trace")) },
  };
}

function auth(scopes: GardenerMcpScope[], suffix = "one"): { props: GardenerMcpTokenProps; authInfo: AuthInfo } {
  const props: GardenerMcpTokenProps = {
    kind: "gardener.mcp-token/v1",
    githubUserId: `user-${suffix}`,
    githubLogin: `owner-${suffix}`,
    instanceId: "instance-one",
    clientId: `client-${suffix}`,
    audience,
    scopes,
    authorizationId: `authorization_${suffix}_1234567890`,
  };
  return {
    props,
    authInfo: {
      token: `very-secret-access-token-${suffix}`,
      clientId: props.clientId,
      scopes,
      resource: new URL(audience),
      extra: { gardener: { ...props, scopes: [...scopes] } },
    },
  };
}

function inputFor(tool: keyof typeof GARDENER_MCP_TOOL_SCOPES): Record<string, unknown> {
  switch (tool) {
    case "gardener.agent.list": return {};
    case "gardener.agent.get": return { agentId: "agent-1" };
    case "gardener.agent.catalog": return {};
    case "gardener.agent.validate": return { source: "# Agent" };
    case "gardener.agent.explain": return { source: "# Agent" };
    case "gardener.agent.diff": return { agentId: "agent-1", fromRevisionId: "revision-1", toRevisionId: "revision-2" };
    case "gardener.agent.simulate": return { source: "# Agent", event: { kind: "issue", action: "opened", repositoryId: "123", resourceType: "issue", resourceId: "456" } };
    case "gardener.agent.publish_draft": return { source: "# Agent", idempotencyKey: "idempotency-key-1234" };
    case "gardener.run.get_trace": return { runId: "run-1" };
  }
}

async function callTool(
  tool: keyof typeof GARDENER_MCP_TOOL_SCOPES,
  scopes: GardenerMcpScope[],
  service = services(),
  suffix = "one",
): Promise<any> {
  const identity = auth(scopes, suffix);
  const handler = createGardenerStatelessMcpHandler(service, {
    route: "/mcp",
    audience,
    authProps: identity.props,
    authInfo: identity.authInfo,
  });
  const response = await handler.fetch(new Request(audience, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: inputFor(tool) } }),
  }), { authInfo: identity.authInfo });
  const text = await response.text();
  if (response.headers.get("content-type")?.includes("text/event-stream")) {
    const data = text.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
    return data ? JSON.parse(data) : { status: response.status, text };
  }
  try { return JSON.parse(text); } catch { return { status: response.status, text }; }
}

describe("Gardener MCP tool authority", () => {
  for (const [tool, requiredScope] of Object.entries(GARDENER_MCP_TOOL_SCOPES) as [keyof typeof GARDENER_MCP_TOOL_SCOPES, GardenerMcpScope][]) {
    it(`${tool} requires exactly ${requiredScope}`, async () => {
      const denied = await callTool(tool, []);
      expect(JSON.stringify(denied)).toContain("forbidden");

      const unrelated = GARDENER_MCP_TOOL_SCOPES[tool] === "gardener:runs:read"
        ? "gardener:agents:read"
        : "gardener:runs:read";
      const adjacent = await callTool(tool, [unrelated]);
      expect(JSON.stringify(adjacent)).toContain("forbidden");

      const allowed = await callTool(tool, [requiredScope]);
      expect(JSON.stringify(allowed)).not.toContain('"error":"forbidden"');
    });
  }

  it("fails closed when HTTP and Worker audience/client/user context disagree", async () => {
    const identity = auth(["gardener:agents:read"]);
    identity.authInfo.clientId = "different-client";
    const handler = createGardenerStatelessMcpHandler(services(), {
      route: "/mcp", audience, authProps: identity.props, authInfo: identity.authInfo,
    });
    const response = await handler.fetch(new Request(audience, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "gardener.agent.list", arguments: {} } }),
    }), { authInfo: identity.authInfo });
    expect(await response.text()).toContain("forbidden");
  });

  it("passes no bearer token or OAuth metadata to services and redacts secret-bearing output", async () => {
    const list = vi.fn(async (_input, principal) => ({
      agents: [], nextCursor: null, principal,
      access_token: "leak-me-not",
      nested: { cookie: "session", safe: "visible" },
    }) as any);
    const result = await callTool("gardener.agent.list", ["gardener:agents:read"], services({ list }));
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("very-secret-access-token");
    expect(serialized).not.toContain("leak-me-not");
    expect(serialized).not.toContain("session");
    expect(serialized).toContain("[redacted]");
    expect(list).toHaveBeenCalledOnce();
    const principal = list.mock.calls[0]![1] as any;
    expect(principal).not.toHaveProperty("token");
    expect(principal).not.toHaveProperty("authInfo");
  });

  it("bounds redacted output by UTF-8 bytes and removes embedded credentials", () => {
    const safe = redactAndBoundOutput({
      note: `embedded ghp_${"a".repeat(24)} value`,
      messages: Array.from({ length: 20 }, () => "🙂".repeat(8_000)),
    });
    const serialized = JSON.stringify(safe);
    expect(new TextEncoder().encode(serialized).byteLength).toBeLessThanOrEqual(64 * 1024);
    expect(serialized).not.toContain("ghp_");
    expect(serialized).toContain("[redacted]");
  });

  it("publish_draft only accepts a paused non-revision receipt", async () => {
    const savePausedDraft = vi.fn(async () => ({
      lifecycle: "active",
      draftId: "draft-1",
      contentHash: "abcdefghijklmnop",
      updatedAt: "2026-09-09T10:00:00.000Z",
      active: true,
      enabled: true,
      immutableRevisionCreated: true,
    }) as any);
    const result = await callTool("gardener.agent.publish_draft", ["gardener:agents:drafts:write"], services({ savePausedDraft }));
    expect(JSON.stringify(result)).toContain("service_error");
    expect(savePausedDraft).toHaveBeenCalledOnce();
  });

  it("exposes only the selected authoring and redacted-trace tools", async () => {
    const identity = auth(["gardener:agents:read"]);
    const handler = createGardenerStatelessMcpHandler(services(), {
      route: "/mcp", audience, authProps: identity.props, authInfo: identity.authInfo,
    });
    const response = await handler.fetch(new Request(audience, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    }), { authInfo: identity.authInfo });
    const body = await response.text();
    for (const tool of Object.keys(GARDENER_MCP_TOOL_SCOPES)) expect(body).toContain(tool);
    for (const forbidden of ["activate", "enable", "approve", "policy", "repository.manage", "pause", "credential", "github.execute", "shell", "network"]) {
      expect(body).not.toContain(`gardener.${forbidden}`);
    }
  });

  it("rejects audience and owner disagreement between authorization contexts", async () => {
    for (const mutate of [
      (identity: ReturnType<typeof auth>) => { identity.authInfo.resource = new URL("https://other.example.test/mcp"); },
      (identity: ReturnType<typeof auth>) => { (identity.authInfo.extra!.gardener as any).githubUserId = "different-user"; },
    ]) {
      const identity = auth(["gardener:agents:read"]);
      mutate(identity);
      const handler = createGardenerStatelessMcpHandler(services(), {
        route: "/mcp", audience, authProps: identity.props, authInfo: identity.authInfo,
      });
      const response = await handler.fetch(new Request(audience, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "gardener.agent.list", arguments: {} } }),
      }), { authInfo: identity.authInfo });
      expect(await response.text()).toContain("forbidden");
    }
  });

  it("constructs a fresh McpServer for every request", async () => {
    const identity = auth(["gardener:agents:read"]);
    const created: object[] = [];
    const handler = createGardenerStatelessMcpHandler(services(), {
      route: "/mcp", audience, authProps: identity.props, authInfo: identity.authInfo,
      onServerCreated: (server) => created.push(server),
    });
    const request = () => new Request(audience, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "gardener.agent.list", arguments: {} } }),
    });
    await handler.fetch(request(), { authInfo: identity.authInfo });
    await handler.fetch(request(), { authInfo: identity.authInfo });
    expect(created).toHaveLength(2);
    expect(created[0]).not.toBe(created[1]);
  });
});
