/// <reference types="node" />
import { createAgentSource } from "@gardener/core";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { agentManagement, createGardenerMcpServices } from "../src/agent-management";
import type { Env } from "../src/env";
import { newAgentDatabase } from "./persistence-test-db";

function environment(db: D1Database): Env {
  return {
    DB: db,
    LOCAL_DEV_BYPASS: "true",
    GARDENER_INSTANCE_TOKEN: "gdn_instance-1.abcdefghijklmnopqrstuvwxyz012345",
    CONNECT_ISSUER: "https://connect.example",
    CONNECT_URL: "https://connect.example",
    AI_MODEL: "@cf/test/model",
    AI: {} as Ai,
    ASSETS: { fetch: async () => new Response("not found", { status: 404 }) } as unknown as Fetcher,
  } as Env;
}

function json(method: string, body?: unknown): RequestInit {
  return { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
}

const testApp = new Hono<{ Bindings: Env; Variables: { actor: string; actorLogin: string; identityToken: string } }>();
testApp.use("/api/*", async (c, next) => {
  c.set("actor", "local-development");
  c.set("actorLogin", "Local developer");
  c.set("identityToken", "local-development");
  return next();
});
testApp.route("/api", agentManagement);

const source = createAgentSource(`---
schema: gardener.agent/v1
name: Issue reader
description: Observe issues without persistent authority.
triggers:
  - github.issue.opened
repositories:
  - "1318443351"
capabilities:
  observation:
    - github.issue.read
---
Read the issue and summarize relevant facts. Do not claim any mutation occurred.
`);

describe("Agent-native management API", () => {
  it("serves the dashboard authoring contract without collapsing lifecycle boundaries", async () => {
    const { sqlite, db } = newAgentDatabase();
    try {
      sqlite.prepare("INSERT INTO repositories (id, installation_id, owner, name, default_branch, active) VALUES (?, ?, ?, ?, ?, 1)")
        .run("1318443351", "158557952", "scuffi", "flue", "main");
      sqlite.prepare("INSERT INTO repositories (id, installation_id, owner, name, default_branch, active) VALUES (?, ?, ?, ?, ?, 1)")
        .run("1318443352", "158557952", "scuffi", "other", "main");
      const env = environment(db);
      const sourceMd = new TextDecoder().decode(Buffer.from(source.agentMd.bytesBase64, "base64"))
        .replace('  - "1318443351"', "  - this");

      let response = await testApp.request("https://gardener.example/api/agents/validate", json("POST", { sourceMd }), env);
      expect(await response.json()).toMatchObject({ valid: true, publishable: false, diagnostics: [{ code: "missing_repository_context" }] });

      response = await testApp.request("https://gardener.example/api/agents", json("POST", { sourceMd, thisRepositoryId: "1318443351" }), env);
      expect(response.status).toBe(201);
      const created = await response.json() as { agent: { id: string }; draftId: string };

      response = await testApp.request("https://gardener.example/api/agents/validate", json("POST", { sourceMd, agentId: created.agent.id, thisRepositoryId: "1318443351" }), env);
      expect(await response.json()).toMatchObject({ valid: true, publishable: true, diagnostics: [] });

      response = await testApp.request(`https://gardener.example/api/agents/${created.agent.id}`, undefined, env);
      const detail = await response.json() as { draft: { sourceMd: string; thisRepositoryId: string }; revisions: unknown[] };
      expect(detail.draft).toMatchObject({ sourceMd, thisRepositoryId: "1318443351" });
      expect(detail.revisions).toEqual([]);

      response = await testApp.request(`https://gardener.example/api/agents/${created.agent.id}/revisions`, json("POST", { sourceMd, thisRepositoryId: "1318443351" }), env);
      expect(response.status).toBe(201);
      expect(await response.json()).toEqual({ revision: 1, paused: true });
      const compiled = sqlite.prepare("SELECT compiled_json FROM agent_revisions WHERE agent_id = ?").get(created.agent.id) as { compiled_json: string };
      expect(JSON.parse(compiled.compiled_json).spec.repositories).toEqual(["1318443351"]);

      response = await testApp.request(`https://gardener.example/api/agents/${created.agent.id}/revisions/1`, undefined, env);
      expect(await response.json()).toMatchObject({ revision: 1, sourceMd });
      response = await testApp.request(`https://gardener.example/api/agents/${created.agent.id}/revisions/1/activate`, { method: "POST" }, env);
      expect(response.status).toBe(200);
      response = await testApp.request(`https://gardener.example/api/agents/${created.agent.id}/status`, json("POST", { enabled: true }), env);
      expect(await response.json()).toEqual({ enabled: true });

      response = await testApp.request("https://gardener.example/api/history", undefined, env);
      expect((await response.json() as { items: unknown[] }).items.length).toBeGreaterThan(0);
    } finally {
      sqlite.close();
    }
  });

  it("makes MCP draft writes idempotent and version checked", async () => {
    const { sqlite, db } = newAgentDatabase();
    try {
      const services = createGardenerMcpServices({ DB: db });
      const principal = {
        clientId: "mcp-client", audience: "https://gardener.example/mcp",
        grantedScopes: ["gardener:agents:drafts:write" as const],
        owner: { githubUserId: "123", githubLogin: "owner", instanceId: "instance-test" },
      };
      const sourceMd = new TextDecoder().decode(Buffer.from(source.agentMd.bytesBase64, "base64"));
      const first = await services.agents.savePausedDraft({ source: sourceMd, supportingFiles: [], expectedDraftVersion: 0, idempotencyKey: "request-key-000001" }, principal);
      const replay = await services.agents.savePausedDraft({ source: sourceMd, supportingFiles: [], expectedDraftVersion: 0, idempotencyKey: "request-key-000001" }, principal);
      expect(replay).toEqual(first);
      const listed = await services.agents.list({ limit: 20 }, principal);
      await expect(services.agents.savePausedDraft({ agentId: listed.agents[0]!.id, source: `${sourceMd}\nChanged`, supportingFiles: [], expectedDraftVersion: 1, idempotencyKey: "request-key-000001" }, principal))
        .rejects.toThrow("Idempotency key was reused");
      await expect(services.agents.savePausedDraft({ agentId: listed.agents[0]!.id, source: `${sourceMd}\nChanged`, supportingFiles: [], idempotencyKey: "request-key-000002" }, principal))
        .rejects.toThrow("requires expectedDraftVersion");
      const updated = await services.agents.savePausedDraft({ agentId: listed.agents[0]!.id, source: `${sourceMd}\nChanged`, supportingFiles: [], expectedDraftVersion: 1, idempotencyKey: "request-key-000002" }, principal);
      expect(updated.draftId).toBe(first.draftId);
      expect(updated.contentHash).not.toBe(first.contentHash);
    } finally {
      sqlite.close();
    }
  });

  it("keeps publication, activation, and enablement as separate owner actions", async () => {
    const { sqlite, db } = newAgentDatabase();
    try {
      sqlite.prepare("INSERT INTO repositories (id, installation_id, owner, name, default_branch, active) VALUES (?, ?, ?, ?, ?, 1)")
        .run("1318443351", "158557952", "scuffi", "flue", "main");
      const env = environment(db);

      let response = await testApp.request("https://gardener.example/api/agents", json("POST", {
        id: "agent-one", slug: "agent-one", name: "Issue reader", description: "Read issues",
      }), env);
      expect(response.status).toBe(201);

      response = await testApp.request("https://gardener.example/api/agents/agent-one/drafts", json("POST", { draftId: "draft-one", source }), env);
      expect(response.status).toBe(201);
      expect((await response.json() as { draft: { status: string } }).draft.status).toBe("editing");

      response = await testApp.request("https://gardener.example/api/agents/agent-one/drafts/draft-one/publish", json("POST", {}), env);
      expect(response.status).toBe(201);
      const published = await response.json() as { revision: { id: string; publishedPaused: boolean }; active: boolean; enabled: boolean };
      expect(published).toMatchObject({ active: false, enabled: false });
      expect(published.revision.publishedPaused).toBe(true);

      response = await testApp.request("https://gardener.example/api/agents/agent-one/enable", json("POST", { enabled: true }), env);
      expect(response.status).toBe(409);

      response = await testApp.request(`https://gardener.example/api/agents/agent-one/revisions/${published.revision.id}/activate`, json("POST", {}), env);
      expect(response.status).toBe(200);
      response = await testApp.request("https://gardener.example/api/agents/agent-one/enable", json("POST", { enabled: true }), env);
      expect(response.status).toBe(200);
      expect((await response.json() as { agent: { enabled: boolean } }).agent.enabled).toBe(true);
    } finally {
      sqlite.close();
    }
  });

  it("exposes simulation only as an explicit fail-closed validation boundary", async () => {
    const { sqlite, db } = newAgentDatabase();
    try {
      sqlite.prepare("INSERT INTO agents (id, slug, name, created_by) VALUES ('agent-one', 'agent-one', 'Agent', 'owner')").run();
      const env = environment(db);
      await testApp.request("https://gardener.example/api/agents/agent-one/drafts", json("POST", { draftId: "draft-one", source }), env);
      const response = await testApp.request("https://gardener.example/api/agents/agent-one/drafts/draft-one/simulate", json("POST", {}), env);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ mode: "validate-only", executed: false, persistentEffects: false, blockedReason: "Agent runtime is not integrated" });
    } finally {
      sqlite.close();
    }
  });
});
