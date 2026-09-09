import { canonicalSha256 } from "@gardener/core";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { bearerToken, verifyEventToken, verifyIdentityToken } from "./auth";
import {
  beginGitHubInstallation,
  beginGitHubLogin,
  claimGardenerInstance,
  listConnectedRepositories,
} from "./connect";
import { ensureDatabase } from "./database";
import { audit, getSetting, repositoryPauseSetting, setSetting } from "./instance-state";
import { operationKindSchema, policyModeSchema, type RepositoryEventV2 } from "./domain";
import { cloudflareAccessCredentials, instanceId, type Env } from "./env";
import { createGardenerMcpOAuthProvider, type ConsentConsumeResult, type ConsentStateStore, type GardenerMcpEnv, type StoredConsentState } from "./mcp";
import { admitRepositoryEvent, getRun, listAgents, listOpenInbox } from "./persistence";
import { setupPolicyProfile, setupProfileIds } from "./setup";
import { agentCatalog, agentManagement, createGardenerMcpServices } from "./agent-management";

interface AppBindings {
  Bindings: Env;
  Variables: { actor: string; actorLogin: string; identityToken: string };
}

const sessionCookie = "gardener_session";
export const app = new Hono<AppBindings>();

app.use("*", async (c, next) => {
  await ensureDatabase(c.env.DB);
  return next();
});

app.onError((error, c) => {
  console.error("request failed", error instanceof Error ? error.message : "unknown error");
  const status = error instanceof z.ZodError ? 400 : 500;
  return c.json({ error: status === 400 ? "Invalid request" : "Internal error" }, status);
});

app.get("/api/health", async (c) => {
  let database = false;
  try { await c.env.DB.prepare("SELECT 1").first(); database = true; } catch { /* reported below */ }
  let connectConfigured = false;
  try { connectConfigured = Boolean(c.env.CONNECT_URL && c.env.CONNECT_ISSUER && instanceId(c.env)); } catch { /* invalid bootstrap */ }
  const oauthConfigured = Boolean(c.env.OAUTH_KV);
  const agentRuntime = { enabled: false, status: "fail-closed-foundation" } as const;
  return c.json({
    ok: database && Boolean(c.env.AI) && connectConfigured && agentRuntime.enabled,
    durableOrchestration: agentRuntime.enabled,
    database,
    workersAi: Boolean(c.env.AI),
    connectConfigured,
    oauthMcp: { configured: oauthConfigured, route: "/mcp" },
    agentRuntime,
    computer: { configured: Boolean(c.env.COMPUTER_WORKSPACES && c.env.COMPUTER_LOADER), experimental: true },
    localDevelopment: c.env.LOCAL_DEV_BYPASS === "true",
  });
});

app.post("/hooks/connect", async (c) => {
  const headerToken = bearerToken(c.req.header("authorization"));
  if (!headerToken) return c.json({ error: "Connect event authorization required" }, 401);
  let event: RepositoryEventV2;
  try { event = await verifyEventToken(headerToken, c.env); }
  catch { return c.json({ error: "Invalid, expired, or unsupported V2 event signature" }, 401); }
  if (!("deliveryId" in event)) return c.json({ error: "Connect hooks accept only provider-attested events" }, 400);

  await upsertEventRepository(c.env.DB, event);
  const resource = eventResource(event);
  const admitted = await admitRepositoryEvent(c.env.DB, {
    id: event.id,
    provider: "github",
    deliveryId: event.deliveryId,
    eventKind: event.kind,
    action: event.action,
    repositoryId: event.repository.id,
    resourceType: resource.type,
    resourceId: resource.id,
    actor: event.actor,
    resourceAuthor: event.resourceAuthor,
    facts: trustedEventFacts(event),
    envelope: event,
    envelopeHash: await canonicalSha256(event),
    occurredAt: event.occurredAt,
  });
  if (admitted.admitted) await audit(c.env.DB, "connect", "repository_event.received", "repository_event", event.id, { deliveryId: event.deliveryId, kind: event.kind, action: event.action });
  // Event admission is intentionally decoupled from execution until AgentRunWorkflow
  // has trusted tools and Connect V2 exact-effect interfaces.
  return c.json({ accepted: true, duplicate: !admitted.admitted, runs: [], runtime: "fail-closed" }, admitted.admitted ? 202 : 200);
});

app.get("/api/auth/start", async (c) => c.redirect(await beginGitHubLogin(c.env, new URL(c.req.url).origin), 302));
app.post("/api/auth/session", async (c) => {
  const { token } = z.object({ token: z.string().min(1).max(20_000) }).strict().parse(await c.req.json());
  const identity = await verifyIdentityToken(token, c.env);
  const now = Math.floor(Date.now() / 1_000);
  const maxAge = typeof identity.exp === "number" ? Math.max(1, Math.min(28_800, identity.exp - now)) : 28_800;
  setCookie(c, sessionCookie, token, { httpOnly: true, secure: new URL(c.req.url).protocol === "https:", sameSite: "Strict", path: "/", maxAge });
  return c.json({ authenticated: true, githubLogin: identityLogin(identity) });
});
app.get("/api/auth/session", async (c) => {
  const token = getCookie(c, sessionCookie);
  if (!token) return c.json({ authenticated: false });
  try {
    const identity = await verifyIdentityToken(token, c.env);
    if (cloudflareAccessCredentials(c.env)) await claimGardenerInstance(c.env, new URL(c.req.url).origin);
    return c.json({ authenticated: true, githubLogin: identityLogin(identity) });
  } catch {
    deleteCookie(c, sessionCookie, { path: "/", secure: new URL(c.req.url).protocol === "https:" });
    return c.json({ authenticated: false });
  }
});
app.post("/api/auth/logout", (c) => {
  deleteCookie(c, sessionCookie, { path: "/", secure: new URL(c.req.url).protocol === "https:" });
  return c.json({ signedOut: true });
});

app.use("/api/*", async (c, next) => {
  if (c.env.LOCAL_DEV_BYPASS === "true") {
    c.set("actor", "local-development"); c.set("actorLogin", "Local developer"); c.set("identityToken", "local-development");
    return next();
  }
  const bearer = bearerToken(c.req.header("authorization"));
  const cookie = getCookie(c, sessionCookie);
  const token = bearer ?? cookie;
  if (!token) return c.json({ error: "Authentication required" }, 401);
  if (!bearer && !["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
    if (c.req.header("origin") !== new URL(c.req.url).origin) return c.json({ error: "Invalid request origin" }, 403);
  }
  try {
    const identity = await verifyIdentityToken(token, c.env);
    c.set("actor", String(identity.sub)); c.set("actorLogin", identityLogin(identity)); c.set("identityToken", token);
    return next();
  } catch { return c.json({ error: "Invalid or expired session" }, 401); }
});

app.route("/api", agentManagement);
app.get("/api/agent-catalog", (c) => c.json(agentCatalog));
app.post("/api/install/start", async (c) => c.json({ installationUrl: await beginGitHubInstallation(c.env, c.get("identityToken"), new URL(c.req.url).origin) }));
app.post("/api/repositories/sync", async (c) => {
  const repositories = await listConnectedRepositories(c.env);
  await c.env.DB.prepare("UPDATE repositories SET active = 0, updated_at = CURRENT_TIMESTAMP").run();
  for (const repository of repositories) {
    await c.env.DB.prepare(
      "INSERT INTO repositories (id, installation_id, owner, name, default_branch, active) VALUES (?, ?, ?, ?, ?, 1) " +
      "ON CONFLICT(id) DO UPDATE SET installation_id = excluded.installation_id, owner = excluded.owner, name = excluded.name, default_branch = excluded.default_branch, active = 1, updated_at = CURRENT_TIMESTAMP",
    ).bind(repository.id, repository.installationId, repository.owner, repository.name, repository.defaultBranch ?? null).run();
  }
  await audit(c.env.DB, c.get("actor"), "repositories.synced", "instance", instanceId(c.env), { count: repositories.length });
  return c.json({ repositories });
});
app.get("/api/policies", async (c) => c.json({ policies: (await c.env.DB.prepare("SELECT operation_kind, mode, updated_at FROM operation_policies ORDER BY operation_kind").all()).results }));
app.put("/api/policies", async (c) => {
  const body = z.object({ policies: z.array(z.object({ operation: operationKindSchema, mode: policyModeSchema }).strict()).min(1).max(operationKindSchema.options.length) }).strict().parse(await c.req.json());
  if (new Set(body.policies.map((item) => item.operation)).size !== body.policies.length) return c.json({ error: "Duplicate policy operation" }, 400);
  await c.env.DB.batch(body.policies.flatMap((item) => [
    c.env.DB.prepare("UPDATE operation_policies SET mode = ?, updated_at = CURRENT_TIMESTAMP WHERE operation_kind = ?").bind(item.mode, item.operation),
    c.env.DB.prepare("INSERT INTO audit_records (actor, action, resource_type, resource_id, detail_json) VALUES (?, 'policy.updated', 'operation', ?, ?)").bind(c.get("actor"), item.operation, JSON.stringify({ mode: item.mode })),
  ]));
  return c.json(body);
});
app.put("/api/policies/:operation", async (c) => {
  const operation = operationKindSchema.safeParse(c.req.param("operation"));
  if (!operation.success) return c.json({ error: "Unknown operation" }, 404);
  const { mode } = z.object({ mode: policyModeSchema }).strict().parse(await c.req.json());
  await c.env.DB.prepare("UPDATE operation_policies SET mode = ?, updated_at = CURRENT_TIMESTAMP WHERE operation_kind = ?").bind(mode, operation.data).run();
  await audit(c.env.DB, c.get("actor"), "policy.updated", "operation", operation.data, { mode });
  return c.json({ operation: operation.data, mode });
});
app.post("/api/setup/activate", async (c) => {
  const { profile } = z.object({ profile: z.enum(setupProfileIds) }).strict().parse(await c.req.json());
  if (!await c.env.DB.prepare("SELECT 1 FROM repositories WHERE active = 1 LIMIT 1").first()) return c.json({ error: "Connect at least one repository before completing setup" }, 409);
  const policies = setupPolicyProfile(profile);
  await c.env.DB.batch([
    ...Object.entries(policies).map(([operation, mode]) => c.env.DB.prepare("UPDATE operation_policies SET mode = ?, updated_at = CURRENT_TIMESTAMP WHERE operation_kind = ?").bind(mode, operation)),
    c.env.DB.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('global_paused', 'false', CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP"),
    c.env.DB.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('onboarding_completed', 'true', CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP"),
    c.env.DB.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('setup_profile', ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP").bind(profile),
  ]);
  await audit(c.env.DB, c.get("actor"), "setup.completed", "instance", instanceId(c.env), { profile });
  return c.json({ activated: true, profile, agentsEnabled: false });
});
app.post("/api/settings/pause", async (c) => {
  const { paused } = z.object({ paused: z.boolean() }).strict().parse(await c.req.json());
  await setSetting(c.env.DB, "global_paused", String(paused));
  await audit(c.env.DB, c.get("actor"), paused ? "system.paused" : "system.resumed", "instance", instanceId(c.env));
  return c.json({ globalPaused: paused });
});
app.put("/api/repositories/:id/pause", async (c) => {
  const id = c.req.param("id"); const { paused } = z.object({ paused: z.boolean() }).strict().parse(await c.req.json());
  const repository = await c.env.DB.prepare("SELECT owner, name FROM repositories WHERE id = ? AND active = 1").bind(id).first<{ owner: string; name: string }>();
  if (!repository) return c.json({ error: "Active repository not found" }, 404);
  await setSetting(c.env.DB, repositoryPauseSetting(id), String(paused));
  await audit(c.env.DB, c.get("actor"), paused ? "repository.paused" : "repository.resumed", "repository", id, repository);
  return c.json({ id, paused });
});
app.get("/api/runs", async (c) => {
  const limit = z.coerce.number().int().min(1).max(100).default(50).parse(c.req.query("limit"));
  return c.json({ runs: (await c.env.DB.prepare("SELECT id, kind, agent_id, agent_revision_id, status, harness_id, harness_version, created_at, started_at, completed_at FROM agent_runs ORDER BY created_at DESC LIMIT ?").bind(limit).all()).results });
});
app.get("/api/runs/:id", async (c) => {
  const run = await getRun(c.env.DB, c.req.param("id")); if (!run) return c.json({ error: "Run not found" }, 404);
  const [tasks, steps, effects] = await Promise.all([
    c.env.DB.prepare("SELECT id, parent_task_id, stable_key, kind, status, parallel_group, depth, created_at, started_at, completed_at FROM run_tasks WHERE run_id = ? ORDER BY created_at").bind(run.id).all(),
    c.env.DB.prepare("SELECT id, task_id, stable_key, kind, status, attempt_count, max_attempts, created_at, started_at, completed_at FROM run_steps WHERE run_id = ? ORDER BY created_at").bind(run.id).all(),
    c.env.DB.prepare("SELECT id, operation_id, effect_kind, policy_mode, status, created_at, decided_at, executed_at FROM effects WHERE run_id = ? ORDER BY created_at").bind(run.id).all(),
  ]);
  return c.json({ run, tasks: tasks.results, steps: steps.results, effects: effects.results });
});
app.get("/api/state", async (c) => {
  const [paused, onboardingCompleted, setupProfile, agents, policies, repositories, repositoryPauses, runs, inbox, audits] = await Promise.all([
    getSetting(c.env.DB, "global_paused"), getSetting(c.env.DB, "onboarding_completed"), getSetting(c.env.DB, "setup_profile"), listAgents(c.env.DB),
    c.env.DB.prepare("SELECT operation_kind, mode, updated_at FROM operation_policies ORDER BY operation_kind").all(),
    c.env.DB.prepare("SELECT id, owner, name, default_branch, active, updated_at FROM repositories ORDER BY owner, name").all(),
    c.env.DB.prepare("SELECT key, value FROM settings WHERE key LIKE 'repository_paused:%'").all<{ key: string; value: string }>(),
    c.env.DB.prepare("SELECT id, kind, agent_id, status, created_at, started_at, completed_at FROM agent_runs ORDER BY created_at DESC LIMIT 50").all(),
    listOpenInbox(c.env.DB),
    c.env.DB.prepare("SELECT actor, action, resource_type, resource_id, created_at FROM audit_records ORDER BY created_at DESC LIMIT 30").all(),
  ]);
  const pausedRepositories = new Set(repositoryPauses.results.filter((item) => item.value === "true").map((item) => item.key.slice("repository_paused:".length)));
  return c.json({
    globalPaused: paused !== "false", viewer: { login: c.get("actorLogin") }, setup: { completed: onboardingCompleted === "true", profile: setupProfile, activeRepositories: repositories.results.filter((item) => Boolean(item.active)).length },
    agents, policies: policies.results, repositories: repositories.results.map((item) => ({ ...item, paused: pausedRepositories.has(String(item.id)) })),
    runs: runs.results, inbox, audits: audits.results,
    capabilities: { agentAuthoring: "available", agentRuntime: "fail-closed", computerWorkspace: "preview", oauthMcp: c.env.OAUTH_KV ? "available" : "needs-kv-binding" },
  });
});

app.notFound((c) => {
  const path = new URL(c.req.url).pathname;
  if (path.startsWith("/api/") || path.startsWith("/hooks/") || path === "/mcp" || path.startsWith("/oauth/")) {
    return c.json({ error: "Not found" }, 404);
  }
  return c.env.ASSETS.fetch(c.req.raw);
});

function identityLogin(identity: Record<string, unknown>): string {
  return typeof identity.githubLogin === "string" ? identity.githubLogin : "GitHub user";
}

export function ownerPrincipalFromIdentity(identity: Record<string, unknown>, env: Env) {
  const match = /^([1-9][0-9]{0,31})$/.exec(String(identity.sub));
  if (!match?.[1]) return null;
  return { githubUserId: match[1], githubLogin: identityLogin(identity), instanceId: instanceId(env) };
}

async function upsertEventRepository(db: D1Database, event: RepositoryEventV2): Promise<void> {
  await db.prepare(
    "INSERT INTO repositories (id, installation_id, owner, name, default_branch, active, updated_at) VALUES (?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP) " +
      "ON CONFLICT(id) DO UPDATE SET installation_id = excluded.installation_id, owner = excluded.owner, name = excluded.name, default_branch = excluded.default_branch, active = 1, updated_at = CURRENT_TIMESTAMP",
  ).bind(event.repository.id, event.repository.installationId, event.repository.owner, event.repository.name, event.repository.defaultBranch).run();
}

function eventResource(event: RepositoryEventV2): { type: string; id: string } {
  if ("comment" in event) return { type: "comment", id: event.comment.id };
  if ("review" in event) return { type: "review", id: event.review.id };
  if ("issue" in event) return { type: "issue", id: event.issue.id };
  if ("pullRequest" in event) return { type: "pull_request", id: event.pullRequest.id };
  if ("discussion" in event) return { type: "discussion", id: event.discussion.id };
  if ("checkRun" in event) return { type: "check_run", id: event.checkRun.id };
  if ("checkSuite" in event) return { type: "check_suite", id: event.checkSuite.id };
  if ("release" in event) return { type: "release", id: event.release.id };
  if ("push" in event) return { type: "push", id: event.push.after };
  if ("requestId" in event) return { type: "manual", id: event.requestId };
  return { type: "schedule", id: event.scheduleId };
}

function trustedEventFacts(event: RepositoryEventV2): Record<string, unknown> {
  if ("pullRequest" in event) return { labels: event.pullRequest.labels, draft: event.pullRequest.draft, headSha: event.pullRequest.head.sha, baseRef: event.pullRequest.base.ref, baseSha: event.pullRequest.base.sha };
  if ("issue" in event) return { labels: event.issue.labels, state: event.issue.state, updatedAt: event.issue.updatedAt };
  if ("discussion" in event) return { labels: event.discussion.labels, state: event.discussion.state, answered: event.discussion.answered, updatedAt: event.discussion.updatedAt };
  return {};
}

function cookieValue(request: Request, name: string): string | null {
  const raw = request.headers.get("cookie"); if (!raw) return null;
  for (const part of raw.split(";")) { const index = part.indexOf("="); if (index >= 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim(); }
  return null;
}

async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

class D1ConsentStateStore implements ConsentStateStore {
  constructor(private readonly db: D1Database) {}
  async create(state: StoredConsentState): Promise<{ handle: string }> {
    const bytes = new Uint8Array(32); crypto.getRandomValues(bytes);
    const handle = btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
    await this.db.prepare("INSERT INTO mcp_consent_states (handle_hash, state_json, csrf_digest, owner_github_user_id, expires_at) VALUES (?, ?, ?, ?, ?)")
      .bind(await digest(handle), JSON.stringify(state), state.csrfDigest, state.owner.githubUserId, state.expiresAt).run();
    return { handle };
  }
  async consume(input: { handle: string; csrfDigest: string; ownerGithubUserId: string; now: number }): Promise<ConsentConsumeResult> {
    const handleHash = await digest(input.handle);
    const changed = await this.db.prepare("UPDATE mcp_consent_states SET consumed_at = ? WHERE handle_hash = ? AND consumed_at IS NULL AND expires_at >= ? AND csrf_digest = ? AND owner_github_user_id = ?")
      .bind(input.now, handleHash, input.now, input.csrfDigest, input.ownerGithubUserId).run();
    const row = await this.db.prepare("SELECT state_json, csrf_digest, owner_github_user_id, expires_at, consumed_at FROM mcp_consent_states WHERE handle_hash = ?")
      .bind(handleHash).first<{ state_json: string; csrf_digest: string; owner_github_user_id: string; expires_at: number; consumed_at: number | null }>();
    if (!row) return { status: "invalid" };
    if ((changed.meta.changes ?? 0) > 0) return { status: "ok", state: JSON.parse(row.state_json) as StoredConsentState };
    if (row.consumed_at !== null) return { status: "replayed" };
    if (row.expires_at < input.now) return { status: "expired" };
    if (row.csrf_digest !== input.csrfDigest) return { status: "csrf-mismatch" };
    if (row.owner_github_user_id !== input.ownerGithubUserId) return { status: "owner-mismatch" };
    return { status: "invalid" };
  }
}

const applicationHandler: ExportedHandler<Env> = { fetch: app.fetch };
const oauthPaths = ["/mcp", "/oauth/authorize", "/oauth/token", "/oauth/register", "/.well-known/"];

export const gardenerWorker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    await ensureDatabase(env.DB);
    const path = new URL(request.url).pathname;
    if (!env.OAUTH_KV) {
      if (oauthPaths.some((prefix) => path === prefix || path.startsWith(prefix))) return new Response(JSON.stringify({ error: "OAuth MCP is not configured" }), { status: 503, headers: { "content-type": "application/json", "cache-control": "no-store" } });
      return app.fetch(request, env, ctx);
    }
    const origin = new URL(request.url).origin;
    const provider = createGardenerMcpOAuthProvider<GardenerMcpEnv & Env>({
      applicationHandler: applicationHandler as ExportedHandler<GardenerMcpEnv & Env>,
      async verifyOwnerSession(ownerRequest, ownerEnv) {
        const token = cookieValue(ownerRequest, sessionCookie); if (!token) return null;
        try {
          const identity = await verifyIdentityToken(token, ownerEnv);
          return ownerPrincipalFromIdentity(identity, ownerEnv);
        } catch { return null; }
      },
      services: createGardenerMcpServices,
      consentState: (ownerEnv) => new D1ConsentStateStore(ownerEnv.DB),
    }, { issuer: origin, audience: `${origin}/mcp` });
    return provider.fetch(request, env as GardenerMcpEnv & Env, ctx);
  },
} satisfies ExportedHandler<Env>;

// Flue consumes the Hono route map; src/index.ts remains the authored Worker
// entry and composes these routes with OAuth plus Flue's generated exports.
export default app;
