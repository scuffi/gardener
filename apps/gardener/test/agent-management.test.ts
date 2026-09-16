/// <reference types="node" />
import { createAgentSource } from "@gardener/core";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { agentManagement, createGardenerMcpServices } from "../src/agent-management";
import { issueDashboardSession } from "../src/identity";
import { resolveRequestAuthorization, type AuthorizationVariables } from "../src/authorization";
import type { Env } from "../src/env";
import { newAgentDatabase } from "./persistence-test-db";

function environment(db: D1Database): Env {
  return {
    DB: db,
    LOCAL_DEV_BYPASS: "true",
    GARDENER_WORKSPACE_ID: "workspace-1",
    GITHUB_GATEWAY: {} as Env["GITHUB_GATEWAY"],
    AI_MODEL: "@cf/test/model",
    AI: {} as Ai,
    ASSETS: { fetch: async () => new Response("not found", { status: 404 }) } as unknown as Fetcher,
  } as Env;
}

function json(method: string, body?: unknown): RequestInit {
  return { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
}

const testApp = new Hono<{ Bindings: Env; Variables: AuthorizationVariables }>();
testApp.use("/api/*", async (c, next) => {
  c.set("authorization", { userId: "local-development", role: "owner", displayName: "Local developer", identity: { provider: "github", providerSubject: "1", login: "local-development" }, principalKind: "local-dev" });
  c.set("actor", "local-development");
  c.set("actorLogin", "Local developer");
  return next();
});
testApp.route("/api", agentManagement);

const source = createAgentSource(`---
schema: gardener.agent/v1
name: Issue reader
description: Observe issues without persistent authority.
triggers:
  - github.issue.opened
capabilities:
  observation:
    - github.issue.read
---
Read the issue and summarize relevant facts. Do not claim any mutation occurred.
`);

function upgrade(sqlite: import("node:sqlite").DatabaseSync): void {
  sqlite.exec("INSERT OR IGNORE INTO users(id,display_name)VALUES('local-development','Local developer')");
  sqlite.exec("INSERT OR IGNORE INTO external_identities(id,user_id,provider,provider_subject,username)VALUES('identity-local','local-development','github','1','local-development')");
  sqlite.exec("INSERT OR IGNORE INTO memberships(id,user_id,role,permanent)VALUES('membership-local','local-development','owner',1)");
}

describe("Agent-native management API", () => {
  it("resolves the production HTTPS prefixed cookie and ignores cookie/header presence without a valid session", async () => {
    const { sqlite, db }=newAgentDatabase();try{upgrade(sqlite);sqlite.exec("INSERT INTO agents(id,slug,name,created_by)VALUES('agent-one','one','Agent One','local-development')");const env=environment(db);env.LOCAL_DEV_BYPASS="false";
      const session=await issueDashboardSession(db,{userId:"local-development",displayName:"Local developer",role:"owner",permanent:true,identity:{provider:"github",providerSubject:"1",login:"local-development"}},true);
      const secureApp=new Hono<{Bindings:Env;Variables:AuthorizationVariables}>();secureApp.use("/api/*",async(c,next)=>{const principal=await resolveRequestAuthorization(c.req.raw,c.env);if(!principal)return c.json({error:"authentication_required"},401);c.set("authorization",principal);c.set("actor",principal.userId);c.set("actorLogin",principal.displayName);return next()});secureApp.route("/api",agentManagement);
      let response=await secureApp.request("https://gardener.example/api/agents/agent-one/assignments",{headers:{cookie:`__Host-gardener_session=${session.token}`}},env);expect(response.status).toBe(200);
      response=await secureApp.request("https://gardener.example/api/agents/agent-one/assignments",{headers:{cookie:"__Host-gardener_session=presence-only",authorization:"Bearer presence-only"}},env);expect(response.status).toBe(401);
    }finally{sqlite.close()}
  });
  it("serves the dashboard authoring contract without collapsing lifecycle boundaries", async () => {
    const { sqlite, db } = newAgentDatabase();
    try {
      upgrade(sqlite);
      sqlite.prepare("INSERT INTO repositories (id, installation_id, owner, name, default_branch, active) VALUES (?, ?, ?, ?, ?, 1)")
        .run("1318443351", "158557952", "scuffi", "flue", "main");
      sqlite.prepare("INSERT INTO repositories (id, installation_id, owner, name, default_branch, active) VALUES (?, ?, ?, ?, ?, 1)")
        .run("1318443352", "158557952", "scuffi", "other", "main");
      const env = environment(db);
      const sourceMd = new TextDecoder().decode(Buffer.from(source.agentMd.bytesBase64, "base64"));

      let response = await testApp.request("https://gardener.example/api/agents/validate", json("POST", { sourceMd }), env);
      expect(await response.json()).toMatchObject({ valid: true, publishable: true, diagnostics: [] });

      response = await testApp.request("https://gardener.example/api/agents", json("POST", { sourceMd }), env);
      expect(response.status).toBe(201);
      const created = await response.json() as { agent: { id: string }; draftId: string };

      response = await testApp.request("https://gardener.example/api/agents/validate", json("POST", { sourceMd, agentId: created.agent.id }), env);
      expect(await response.json()).toMatchObject({ valid: true, publishable: true, diagnostics: [] });

      response = await testApp.request(`https://gardener.example/api/agents/${created.agent.id}`, undefined, env);
      const detail = await response.json() as { draft: { sourceMd: string }; revisions: unknown[] };
      expect(detail.draft).toMatchObject({ sourceMd });
      expect(detail.revisions).toEqual([]);

      response = await testApp.request(`https://gardener.example/api/agents/${created.agent.id}/revisions`, json("POST", { sourceMd }), env);
      expect(response.status).toBe(201);
      expect(await response.json()).toEqual({ revision: 1, paused: true });
      const compiled = sqlite.prepare("SELECT compiled_json FROM agent_revisions WHERE agent_id = ?").get(created.agent.id) as { compiled_json: string };
      expect(JSON.parse(compiled.compiled_json).spec).not.toHaveProperty("repositories");

      response = await testApp.request(`https://gardener.example/api/agents/${created.agent.id}/revisions/1`, undefined, env);
      expect(await response.json()).toMatchObject({ revision: 1, sourceMd });
      response = await testApp.request(`https://gardener.example/api/agents/${created.agent.id}/revisions/1/activate`, json("POST", { expectedAssignmentEpoch: 1, expectedCurrentRevisionId: null }), env);
      expect(response.status).toBe(200);
      response = await testApp.request(`https://gardener.example/api/agents/${created.agent.id}/status`, json("POST", { enabled: true }), env);
      expect(response.status).toBe(409);

      response = await testApp.request("https://gardener.example/api/history", undefined, env);
      expect((await response.json() as { items: unknown[] }).items.length).toBeGreaterThan(0);
    } finally {
      sqlite.close();
    }
  });

  it("makes MCP draft writes idempotent and version checked", async () => {
    const { sqlite, db } = newAgentDatabase();
    try {
      upgrade(sqlite);
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
      upgrade(sqlite);
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

      response = await testApp.request(`https://gardener.example/api/agents/agent-one/revisions/${published.revision.id}/activate`, json("POST", { expectedAssignmentEpoch: 1, expectedCurrentRevisionId: "revision-does-not-exist" }), env);
      expect(response.status).toBe(409);
      expect(sqlite.prepare("SELECT value FROM settings WHERE key='assignment_epoch'").get()).toEqual({ value: "1" });
      response = await testApp.request(`https://gardener.example/api/agents/agent-one/revisions/${published.revision.id}/activate`, json("POST", { expectedAssignmentEpoch: 1, expectedCurrentRevisionId: null }), env);
      expect(response.status).toBe(200);
      response = await testApp.request("https://gardener.example/api/agents/agent-one/enable", json("POST", { enabled: true }), env);
      expect(response.status).toBe(409);
    } finally {
      sqlite.close();
    }
  });

  it("exposes simulation only as an explicit validation-only boundary", async () => {
    const { sqlite, db } = newAgentDatabase();
    try {
      upgrade(sqlite);
      sqlite.prepare("INSERT INTO agents (id, slug, name, created_by) VALUES ('agent-one', 'agent-one', 'Agent', 'owner')").run();
      const env = environment(db);
      await testApp.request("https://gardener.example/api/agents/agent-one/drafts", json("POST", { draftId: "draft-one", source }), env);
      const response = await testApp.request("https://gardener.example/api/agents/agent-one/drafts/draft-one/simulate", json("POST", {}), env);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ mode: "validate-only", executed: false, persistentEffects: false, blockedReason: "Simulation is validation-only; live execution is limited to the bounded issue-comment runtime" });
    } finally {
      sqlite.close();
    }
  });
});
