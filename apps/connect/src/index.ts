import { operationReceiptSchema, repositoryEventV2Schema, type RepositoryEventV2 } from "@gardener/contracts";
import { canonicalOperationHash as canonicalOperationHashV2 } from "@gardener/core";
import { Hono, type Context, type Next } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { decodeJwt } from "jose";
import { z } from "zod";
import { bearer, constantTimeEqual, decryptAccessCredentials, encryptAccessCredentials, jwks, randomToken, sha256, signToken, verifyToken, verifyWebhookSignature } from "./crypto";
import type { Env, GrantClaims, Variables } from "./env";
import { ConnectOperationError, discoverRepositories, exchangeOAuthCode, executeGitHubOperation, fetchPullRequestForWebhook, getInstallation } from "./github";
import { normalizeGitHubWebhook } from "./webhook";
import { landingPage } from "./landing";
import { callbackUrlSchema, grantRequestSchema, instanceClaimSchema, operationSchema, type Operation } from "./schema";

type AppBindings = { Bindings: Env; Variables: Variables };
type Row = Record<string, unknown>;
const app = new Hono<AppBindings>();

app.onError((error, c) => {
  console.error("connect request failed", error instanceof Error ? error.message : "unknown");
  if (error instanceof z.ZodError) return c.json({ error: "Invalid request", issues: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })) }, 400);
  return c.json({ error: "Internal error" }, 500);
});

app.get("/health", async (c) => {
  let database = false;
  try { await c.env.DB.prepare("SELECT 1").first(); database = true; } catch { /* health only */ }
  const configured = ["GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY", "GITHUB_WEBHOOK_SECRET", "CONNECT_JWT_PRIVATE_KEY", "CONNECT_JWT_PUBLIC_KEY"].every((key) => Boolean((c.env as unknown as Row)[key]));
  return c.json({ ok: database && configured, database, configured, service: "gardener-connect", version: "v2" }, database && configured ? 200 : 503);
});
app.get("/.well-known/jwks.json", async (c) => c.json(await jwks(c.env), 200, { "cache-control": "public, max-age=300" }));

app.get("/", (c) => c.html(landingPage(), 200, { "cache-control": "no-store" }));

const LANDING_COOKIE = "gardener_landing";

app.get("/v1/landing/start", async (c) => {
  const state = randomToken("landing_");
  await c.env.DB.prepare("INSERT INTO landing_states (state_hash, expires_at) VALUES (?, ?)")
    .bind(await sha256(state), Math.floor(Date.now() / 1000) + 600).run();
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", c.env.GITHUB_CLIENT_ID);
  url.searchParams.set("redirect_uri", new URL("/v1/landing/callback", c.env.CONNECT_ISSUER).toString());
  url.searchParams.set("state", state);
  url.searchParams.set("scope", "read:user");
  return c.redirect(url.toString(), 302);
});

app.get("/v1/landing/callback", async (c) => {
  const input = z.object({ code: z.string().min(1), state: z.string().min(1) }).parse(c.req.query());
  const stateHash = await sha256(input.state);
  const state = await c.env.DB.prepare("SELECT state_hash FROM landing_states WHERE state_hash = ? AND consumed_at IS NULL AND expires_at > ?")
    .bind(stateHash, Math.floor(Date.now() / 1000)).first();
  if (!state) return c.json({ error: "Invalid or expired login state" }, 400);
  const consumed = await c.env.DB.prepare("UPDATE landing_states SET consumed_at = CURRENT_TIMESTAMP WHERE state_hash = ? AND consumed_at IS NULL")
    .bind(stateHash).run();
  if ((consumed.meta.changes ?? 0) !== 1) return c.json({ error: "Login state was already used" }, 400);
  const user = await exchangeOAuthCode(c.env, input.code);
  const session = randomToken("landing_session_");
  await c.env.DB.prepare("INSERT INTO landing_sessions (session_hash, github_user_id, github_login, expires_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256(session), user.id, user.login, Math.floor(Date.now() / 1000) + 600).run();
  setCookie(c, LANDING_COOKIE, session, { httpOnly: true, secure: new URL(c.env.CONNECT_ISSUER).protocol === "https:", sameSite: "Lax", path: "/", maxAge: 600 });
  return c.redirect("/?create=1", 302);
});

async function landingIdentity(c: Context<AppBindings>): Promise<{ id: string; login: string; sessionHash: string; sessionToken: string } | null> {
  const session = getCookie(c, LANDING_COOKIE);
  if (!session) return null;
  const sessionHash = await sha256(session);
  const identity = await c.env.DB.prepare("SELECT github_user_id AS id, github_login AS login FROM landing_sessions WHERE session_hash = ? AND expires_at > ?")
    .bind(sessionHash, Math.floor(Date.now() / 1000)).first<{ id: string; login: string }>();
  return identity ? { ...identity, sessionHash, sessionToken: session } : null;
}

async function createInstance(
  env: Env,
  instanceId: string,
  callbackUrl?: string,
  ownerGithubUserId?: string,
  tokenOverride?: string,
  acceptMatchingExisting = false,
): Promise<{ instanceId: string; token: string }> {
  const token = tokenOverride ?? `gdn_${instanceId}.${randomToken()}`;
  const tokenHash = await sha256(token);
  const result = await env.DB.prepare("INSERT OR IGNORE INTO instances (id, token_hash, owner_github_user_id, callback_url, claimed_at) VALUES (?, ?, ?, ?, ?)")
    .bind(instanceId, tokenHash, ownerGithubUserId ?? null, callbackUrl ?? null, callbackUrl ? new Date().toISOString() : null).run();
  if ((result.meta.changes ?? 0) !== 1) {
    const existing = acceptMatchingExisting
      ? await env.DB.prepare("SELECT id FROM instances WHERE id = ? AND token_hash = ? AND owner_github_user_id = ? AND revoked_at IS NULL")
        .bind(instanceId, tokenHash, ownerGithubUserId ?? null).first()
      : null;
    if (!existing) throw new Error("Instance already exists");
  }
  return { instanceId, token };
}

app.post("/v1/bootstrap", async (c) => {
  const identity = await landingIdentity(c);
  if (!identity) return c.json({ error: "GitHub login required" }, 401);
  const instanceId = `instance-${identity.sessionHash.slice(0, 24)}`;
  const token = `gdn_${instanceId}.${identity.sessionToken}`;
  const instance = await createInstance(c.env, instanceId, undefined, identity.id, token, true);
  const source = c.env.DEPLOY_REPOSITORY_URL ?? "https://github.com/cloudflare/gardener";
  return c.json({ ...instance, deployUrl: `https://deploy.workers.cloudflare.com/?url=${encodeURIComponent(source)}` }, 201, { "cache-control": "no-store" });
});

app.post("/v1/admin/bootstrap", async (c) => {
  const supplied = bearer(c.req.header("authorization"));
  if (!supplied || !constantTimeEqual(supplied, c.env.ADMIN_BOOTSTRAP_SECRET)) return c.json({ error: "Unauthorized" }, 401);
  const input = z.object({ instanceId: z.string().min(3).max(100).regex(/^[a-zA-Z0-9_-]+$/), callbackUrl: callbackUrlSchema.optional(), ownerGithubUserId: z.string().regex(/^\d+$/).optional() }).strict().parse(await c.req.json());
  try {
    return c.json(await createInstance(c.env, input.instanceId, input.callbackUrl, input.ownerGithubUserId), 201, { "cache-control": "no-store" });
  } catch {
    return c.json({ error: "Instance already exists" }, 409);
  }
});

async function authenticateInstance(c: Context<AppBindings>, next: Next): Promise<Response | void> {
  const token = bearer(c.req.header("authorization"));
  if (!token) return c.json({ error: "Instance authentication required" }, 401);
  const row = await c.env.DB.prepare("SELECT id FROM instances WHERE token_hash = ? AND revoked_at IS NULL").bind(await sha256(token)).first<{ id: string }>();
  if (!row) return c.json({ error: "Invalid or revoked instance token" }, 401);
  c.set("instanceId", row.id); await next();
}
app.use("/v1/instances/*", authenticateInstance);
app.use("/v1/grants", authenticateInstance);
app.use("/v1/repositories", authenticateInstance);

app.post("/v1/instances/claim", async (c) => {
  const input = instanceClaimSchema.parse(await c.req.json());
  if (input.instanceId !== c.get("instanceId")) return c.json({ error: "Instance mismatch" }, 403);
  let result: D1Result;
  if (input.cloudflareAccess) {
    if (!c.env.ACCESS_CREDENTIAL_ENCRYPTION_KEY) return c.json({ error: "Connect Access credential storage is unavailable" }, 503);
    const encrypted = await encryptAccessCredentials(c.env.ACCESS_CREDENTIAL_ENCRYPTION_KEY, input.instanceId, input.cloudflareAccess);
    result = await c.env.DB.prepare("UPDATE instances SET callback_url = ?, claimed_at = CURRENT_TIMESTAMP, cloudflare_access_credentials = ?, cloudflare_access_configured_at = CURRENT_TIMESTAMP WHERE id = ? AND revoked_at IS NULL AND (callback_url IS NULL OR callback_url = ?)")
      .bind(input.callbackUrl, encrypted, input.instanceId, input.callbackUrl).run();
  } else if (input.cloudflareAccess === null) {
    result = await c.env.DB.prepare("UPDATE instances SET callback_url = ?, claimed_at = CURRENT_TIMESTAMP, cloudflare_access_credentials = NULL, cloudflare_access_configured_at = NULL WHERE id = ? AND revoked_at IS NULL AND (callback_url IS NULL OR callback_url = ?)")
      .bind(input.callbackUrl, input.instanceId, input.callbackUrl).run();
  } else {
    result = await c.env.DB.prepare("UPDATE instances SET callback_url = ?, claimed_at = CURRENT_TIMESTAMP WHERE id = ? AND revoked_at IS NULL AND (callback_url IS NULL OR callback_url = ?)")
      .bind(input.callbackUrl, input.instanceId, input.callbackUrl).run();
  }
  if ((result.meta.changes ?? 0) !== 1) return c.json({ error: "Instance is already claimed to another callback" }, 409);
  return c.json({ claimed: true, instanceId: input.instanceId, cloudflareAccessConfigured: Boolean(input.cloudflareAccess) });
});

async function createState(env: Env, instanceId: string, purpose: "login" | "installation", redirectUri?: string): Promise<string> {
  const state = randomToken("state_");
  await env.DB.prepare("INSERT INTO oauth_states (state_hash, instance_id, purpose, redirect_uri, expires_at) VALUES (?, ?, ?, ?, ?)")
    .bind(await sha256(state), instanceId, purpose, redirectUri ?? null, Math.floor(Date.now() / 1000) + 600).run();
  return state;
}

app.post("/v1/auth/github/start", authenticateInstance, async (c) => {
  const input = z.object({ redirectUri: callbackUrlSchema.optional() }).strict().parse(await c.req.json().catch(() => ({})));
  const state = await createState(c.env, c.get("instanceId"), "login", input.redirectUri);
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", c.env.GITHUB_CLIENT_ID); url.searchParams.set("redirect_uri", c.env.GITHUB_OAUTH_CALLBACK_URL); url.searchParams.set("state", state); url.searchParams.set("scope", "read:user");
  return c.json({ authorizationUrl: url.toString() }, 200, { "cache-control": "no-store" });
});

app.get("/v1/auth/github/callback", async (c) => {
  const { code, state } = z.object({ code: z.string().min(1), state: z.string().min(1) }).parse(c.req.query());
  const row = await consumeState(c.env, state, "login"); if (!row) return c.json({ error: "Invalid or expired OAuth state" }, 400);
  const user = await exchangeOAuthCode(c.env, code);
  const owner = await c.env.DB.prepare("UPDATE instances SET owner_github_user_id = COALESCE(owner_github_user_id, ?) WHERE id = ? AND (owner_github_user_id IS NULL OR owner_github_user_id = ?)")
    .bind(user.id, row.instance_id, user.id).run();
  if ((owner.meta.changes ?? 0) !== 1) return c.json({ error: "This Gardener instance belongs to another GitHub user" }, 403);
  await c.env.DB.prepare("INSERT INTO identities (instance_id, github_user_id, github_login) VALUES (?, ?, ?) ON CONFLICT(instance_id, github_user_id) DO UPDATE SET github_login = excluded.github_login, last_login_at = CURRENT_TIMESTAMP")
    .bind(row.instance_id, user.id, user.login).run();
  const token = await signToken(c.env, { typ: "gardener-identity", sub: user.id, instanceId: row.instance_id, githubLogin: user.login }, row.instance_id, 28_800);
  const destination = typeof row.redirect_uri === "string" ? row.redirect_uri : await instanceCallback(c.env, row.instance_id);
  if (!destination) return c.json({ token }, 200, { "cache-control": "no-store" });
  const redirect = new URL(destination); redirect.hash = new URLSearchParams({ identity_token: token }).toString();
  return c.redirect(redirect.toString(), 302);
});

async function consumeState(env: Env, rawState: string, purpose: "login" | "installation"): Promise<{ instance_id: string; redirect_uri: string | null } | null> {
  const hash = await sha256(rawState);
  const row = await env.DB.prepare("SELECT instance_id, redirect_uri FROM oauth_states WHERE state_hash = ? AND purpose = ? AND consumed_at IS NULL AND expires_at > ?")
    .bind(hash, purpose, Math.floor(Date.now() / 1000)).first<{ instance_id: string; redirect_uri: string | null }>();
  if (!row) return null;
  const result = await env.DB.prepare("UPDATE oauth_states SET consumed_at = CURRENT_TIMESTAMP WHERE state_hash = ? AND consumed_at IS NULL").bind(hash).run();
  return (result.meta.changes ?? 0) === 1 ? row : null;
}
async function instanceCallback(env: Env, instanceId: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT callback_url FROM instances WHERE id = ?").bind(instanceId).first<{ callback_url: string | null }>(); return row?.callback_url ?? null;
}

async function authenticateIdentity(c: Context<AppBindings>, next: Next): Promise<Response | void> {
  const token = bearer(c.req.header("authorization")); if (!token) return c.json({ error: "Identity required" }, 401);
  try {
    const unverified = decodeJwt(token);
    if (typeof unverified.aud !== "string") throw new Error("Missing identity audience");
    const payload = await verifyToken(c.env, token, unverified.aud);
    if (payload.typ !== "gardener-identity" || typeof payload.aud !== "string" || typeof payload.sub !== "string" || typeof payload.githubLogin !== "string") return c.json({ error: "Invalid identity" }, 401);
    c.set("identity", { instanceId: payload.aud, githubUserId: payload.sub, githubLogin: payload.githubLogin }); await next();
  } catch { return c.json({ error: "Invalid or expired identity" }, 401); }
}

app.post("/v1/installations/setup", authenticateIdentity, async (c) => {
  const input = z.object({ redirectUri: callbackUrlSchema.optional() }).strict().parse(await c.req.json().catch(() => ({})));
  const identity = c.get("identity");
  const exists = await c.env.DB.prepare("SELECT 1 FROM identities JOIN instances ON instances.id = identities.instance_id WHERE identities.instance_id = ? AND identities.github_user_id = ? AND instances.revoked_at IS NULL")
    .bind(identity.instanceId, identity.githubUserId).first();
  if (!exists) return c.json({ error: "Identity is not registered" }, 403);
  const state = await createState(c.env, identity.instanceId, "installation", input.redirectUri);
  const url = new URL(`https://github.com/apps/${c.env.GITHUB_APP_SLUG}/installations/new`); url.searchParams.set("state", state);
  return c.json({ installationUrl: url.toString() }, 200, { "cache-control": "no-store" });
});

app.get("/v1/installations/callback", async (c) => {
  const input = z.object({ installation_id: z.string().regex(/^\d+$/), state: z.string().min(1), setup_action: z.string().optional() }).parse(c.req.query());
  const state = await consumeState(c.env, input.state, "installation"); if (!state) return c.json({ error: "Invalid or expired installation state" }, 400);
  const installation = await getInstallation(c.env, input.installation_id);
  await storeInstallation(c.env, state.instance_id, installation);
  const repositories = await syncInstallation(c.env, state.instance_id, installation.id);
  if (state.redirect_uri) { const destination = new URL(state.redirect_uri); destination.searchParams.set("installation", "complete"); destination.searchParams.set("repositories", String(repositories.length)); return c.redirect(destination.toString()); }
  return c.json({ installation, repositories });
});

async function storeInstallation(env: Env, instanceId: string, installation: { id: string; accountId: string; accountLogin: string }): Promise<void> {
  const owner = await env.DB.prepare("SELECT instance_id FROM installations WHERE id = ?").bind(installation.id).first<{ instance_id: string }>();
  if (owner && owner.instance_id !== instanceId) throw new Error("Installation is already assigned to another instance");
  await env.DB.prepare("INSERT INTO installations (id, instance_id, account_id, account_login) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET account_id = excluded.account_id, account_login = excluded.account_login, suspended_at = NULL, revoked_at = NULL, updated_at = CURRENT_TIMESTAMP")
    .bind(installation.id, instanceId, installation.accountId, installation.accountLogin).run();
}
async function syncInstallation(env: Env, instanceId: string, installationId: string) {
  const repositories = await discoverRepositories(env, installationId);
  await env.DB.prepare("UPDATE repositories SET active = 0, updated_at = CURRENT_TIMESTAMP WHERE installation_id = ? AND instance_id = ?").bind(installationId, instanceId).run();
  for (const repo of repositories) await env.DB.prepare("INSERT INTO repositories (id, installation_id, instance_id, owner, name, default_branch, active) VALUES (?, ?, ?, ?, ?, ?, 1) ON CONFLICT(id) DO UPDATE SET installation_id = excluded.installation_id, instance_id = excluded.instance_id, owner = excluded.owner, name = excluded.name, default_branch = excluded.default_branch, active = 1, updated_at = CURRENT_TIMESTAMP")
    .bind(repo.id, repo.installationId, instanceId, repo.owner, repo.name, repo.defaultBranch ?? null).run();
  return repositories;
}

app.get("/v1/repositories", async (c) => {
  const installations = await c.env.DB.prepare("SELECT id FROM installations WHERE instance_id = ? AND revoked_at IS NULL AND suspended_at IS NULL").bind(c.get("instanceId")).all<{ id: string }>();
  for (const installation of installations.results) await syncInstallation(c.env, c.get("instanceId"), installation.id);
  const repositories = await c.env.DB.prepare("SELECT 'github' AS provider, r.id, r.installation_id AS installationId, r.owner, r.name, r.default_branch AS defaultBranch FROM repositories r JOIN installations i ON i.id = r.installation_id WHERE r.instance_id = ? AND r.active = 1 AND i.revoked_at IS NULL AND i.suspended_at IS NULL ORDER BY r.owner, r.name").bind(c.get("instanceId")).all();
  return c.json({ repositories: repositories.results });
});

app.post("/v1/grants", async (c) => {
  const input = grantRequestSchema.parse(await c.req.json()); const instanceId = c.get("instanceId");
  if (input.instanceId !== instanceId) return c.json({ error: "Instance mismatch" }, 403);
  const repo = await c.env.DB.prepare("SELECT r.id, r.installation_id FROM repositories r JOIN installations i ON i.id = r.installation_id WHERE r.id = ? AND r.instance_id = ? AND r.owner = ? AND r.name = ? AND r.active = 1 AND i.revoked_at IS NULL AND i.suspended_at IS NULL").bind(input.repository.id, instanceId, input.repository.owner, input.repository.name).first<{ id: string; installation_id: string }>();
  if (!repo || repo.installation_id !== input.repository.installationId) return c.json({ error: "Repository is not authorized for this instance" }, 403);
  const delivered = await c.env.DB.prepare(
    "SELECT resource_kind, resource_number, normalized_event_json, normalized_event_hash FROM webhook_deliveries WHERE instance_id = ? AND repository_id = ? AND normalized_event_id = ? AND status IN ('relaying', 'relayed')",
  ).bind(instanceId, repo.id, input.eventId).first<{ resource_kind: string; resource_number: number; normalized_event_json: string; normalized_event_hash: string }>();
  if (!delivered || typeof delivered.normalized_event_json !== "string" || typeof delivered.normalized_event_hash !== "string" || await sha256(delivered.normalized_event_json) !== delivered.normalized_event_hash) {
    return c.json({ error: "Run grant must reference an intact V2 event delivered to this instance" }, 403);
  }
  const deliveredEvent = repositoryEventV2Schema.parse(JSON.parse(delivered.normalized_event_json));
  const eventBinding = eventScope(deliveredEvent);
  const resourceKind = eventBinding.resourceKind;
  const resourceNumber = eventBinding.resourceNumber;
  if (delivered.resource_kind !== resourceKind || delivered.resource_number !== resourceNumber || input.operations.some((operation) =>
    operation.repository.id !== repo.id || operation.repository.owner !== input.repository.owner || operation.repository.name !== input.repository.name || operation.repository.installationId !== repo.installation_id || !operationMatchesEvent(operation, deliveredEvent)
  )) return c.json({ error: "Requested operation is outside the delivered event scope or its attested live facts" }, 403);
  const operations = [...new Set(input.operations.map((operation) => operation.kind))];
  const operationHashes = await Promise.all(input.operations.map(canonicalOperationHash));
  const jti = crypto.randomUUID(); const expiresAt = Math.floor(Date.now() / 1000) + 300;
  await c.env.DB.prepare("INSERT INTO grants (jti, instance_id, run_id, event_id, repository_id, resource_kind, resource_number, operations, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(jti, instanceId, input.runId, input.eventId, repo.id, resourceKind, resourceNumber, JSON.stringify(operationHashes), expiresAt).run();
  const grant = await signToken(c.env, { typ: "gardener-run-grant", jti, instanceId, runId: input.runId, eventId: input.eventId, repositoryId: repo.id, owner: input.repository.owner, name: input.repository.name, installationId: repo.installation_id, resourceKind, resourceNumber, operations, operationHashes }, c.env.CONNECT_AUDIENCE, 300);
  return c.json({ grant, expiresAt }, 201, { "cache-control": "no-store" });
});

export async function canonicalOperationHash(operation: Operation): Promise<string> {
  return canonicalOperationHashV2(operation);
}

export function operationMatchesGrantResource(operation: Operation, grant: Pick<GrantClaims, "resourceKind" | "resourceNumber">): boolean {
  if ("issueNumber" in operation) return grant.resourceKind === "issue" && operation.issueNumber === grant.resourceNumber;
  if ("pullNumber" in operation) return grant.resourceKind === "pull_request" && operation.pullNumber === grant.resourceNumber;
  if ("discussionNumber" in operation) return grant.resourceKind === "discussion" && operation.discussionNumber === grant.resourceNumber;
  if (operation.kind === "check.rerun") return grant.resourceKind === "check" && Number(operation.checkRunId) === grant.resourceNumber;
  if (operation.kind.startsWith("release.") && "releaseId" in operation) return grant.resourceKind === "release" && Number(operation.releaseId) === grant.resourceNumber;
  // New branches, commits, draft pull requests, and draft releases remain issue-bound.
  return grant.resourceKind === "issue";
}

export function operationMatchesEvent(operation: Operation, event: RepositoryEventV2): boolean {
  const scope = eventScope(event);
  if (!operationMatchesGrantResource(operation, scope)) return false;
  if ("issueNumber" in operation) {
    const issue = event.kind === "github.issue" || event.kind === "github.issue_comment" ? event.issue : null;
    if (!issue || operation.expectedIssueState !== issue.state || operation.expectedIssueUpdatedAt !== issue.updatedAt) return false;
    if (operation.kind === "issue.comment.update" && event.kind === "github.issue_comment") return operation.commentId === event.comment.id && operation.expectedCommentUpdatedAt === event.comment.updatedAt;
  }
  if ("pullNumber" in operation) {
    if (!(event.kind === "github.pull_request" || event.kind === "github.pull_request_comment" || event.kind === "github.pull_request_review" || event.kind === "github.pull_request_review_comment")) return false;
    const pull = event.pullRequest;
    if (operation.expectedHeadSha !== pull.head.sha || operation.expectedBaseRef !== pull.base.ref || operation.expectedBaseSha !== pull.base.sha || operation.expectedState !== pull.state || operation.expectedDraft !== pull.draft || operation.expectedPullUpdatedAt !== pull.updatedAt) return false;
  }
  if ("discussionNumber" in operation) {
    if (!(event.kind === "github.discussion" || event.kind === "github.discussion_comment")) return false;
    if (operation.expectedDiscussionState !== event.discussion.state || operation.expectedDiscussionUpdatedAt !== event.discussion.updatedAt) return false;
  }
  if (operation.kind === "check.rerun") return event.kind === "github.check_run" && operation.checkRunId === event.checkRun.id && operation.expectedHeadSha === event.checkRun.headSha && operation.expectedStatus === event.checkRun.status && operation.expectedConclusion === event.checkRun.conclusion;
  if (operation.kind === "release.update" || operation.kind === "release.publish" || operation.kind === "release.delete") return event.kind === "github.release" && operation.releaseId === event.release.id && operation.expectedTagName === event.release.tagName && operation.expectedDraft === event.release.draft && operation.expectedReleaseUpdatedAt === event.release.updatedAt;
  return true;
}

app.post("/v1/operations", async (c) => {
  const token = bearer(c.req.header("authorization")); if (!token) return c.json({ error: "Run grant required" }, 401);
  let grant: GrantClaims;
  try {
    const p = await verifyToken(c.env, token, c.env.CONNECT_AUDIENCE);
    if (p.typ !== "gardener-run-grant" || typeof p.jti !== "string" || typeof p.instanceId !== "string" || typeof p.runId !== "string" || typeof p.eventId !== "string" || typeof p.repositoryId !== "string" || typeof p.owner !== "string" || typeof p.name !== "string" || typeof p.installationId !== "string" || !["issue", "pull_request", "discussion", "check", "release", "repository"].includes(String(p.resourceKind)) || typeof p.resourceNumber !== "number" || !Array.isArray(p.operations) || !Array.isArray(p.operationHashes) || !p.operationHashes.every((hash) => typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash))) throw new Error("bad claims");
    grant = p as unknown as GrantClaims;
  } catch { return c.json({ error: "Invalid or expired run grant" }, 401); }
  const stored = await c.env.DB.prepare("SELECT g.jti FROM grants g JOIN instances i ON i.id = g.instance_id JOIN repositories r ON r.id = g.repository_id JOIN installations ins ON ins.id = r.installation_id WHERE g.jti = ? AND g.instance_id = ? AND g.expires_at > ? AND i.revoked_at IS NULL AND r.active = 1 AND ins.revoked_at IS NULL AND ins.suspended_at IS NULL")
    .bind(grant.jti, grant.instanceId, Math.floor(Date.now() / 1000)).first(); if (!stored) return c.json({ error: "Revoked or expired run grant" }, 401);
  const operation = operationSchema.parse(z.object({ operation: z.unknown() }).parse(await c.req.json()).operation);
  const operationHash = await canonicalOperationHash(operation);
  if (operation.repository.id !== grant.repositoryId || operation.repository.owner !== grant.owner || operation.repository.name !== grant.name || operation.repository.installationId !== grant.installationId || !operationMatchesGrantResource(operation, grant) || !grant.operations.includes(operation.kind) || !grant.operationHashes.includes(operationHash)) return c.json({ error: "Operation is outside grant scope" }, 403);
  const serializedOperation = JSON.stringify(operation);
  const existing = await c.env.DB.prepare("SELECT instance_id, operation_kind, operation, operation_hash, repository_id, resource_number, status, receipt, lease_expires_at, attempt_count FROM operation_receipts WHERE operation_id = ?").bind(operation.id).first<{ instance_id: string; operation_kind: string; operation: string; operation_hash: string | null; repository_id: string; resource_number: number; status: string; receipt: string | null; lease_expires_at: number | null; attempt_count: number }>();
  if (existing && (existing.instance_id !== grant.instanceId || existing.operation_kind !== operation.kind || existing.operation !== serializedOperation || (existing.operation_hash !== null && existing.operation_hash !== operationHash) || existing.repository_id !== grant.repositoryId || existing.resource_number !== grant.resourceNumber)) return c.json({ error: "Operation id was already used for a different operation" }, 409);
  if (existing?.status === "applied" && existing.receipt) return c.json(operationReceiptSchema.parse(JSON.parse(existing.receipt)));
  if (existing?.status === "failed" && existing.receipt) {
    const priorReceipt = operationReceiptSchema.parse(JSON.parse(existing.receipt));
    if (priorReceipt.error?.retryable === false) return c.json(priorReceipt, priorReceipt.error.code === "unsupported_operation" ? 422 : 409);
  }
  const now = Math.floor(Date.now() / 1000);
  if (existing?.status === "executing" && (existing.lease_expires_at ?? Number.POSITIVE_INFINITY) > now) return c.json({ error: "Operation is already executing" }, 409);
  const attemptToken = crypto.randomUUID();
  const leaseExpiresAt = now + 600;
  if (!existing) await c.env.DB.prepare("INSERT INTO operation_receipts (operation_id, instance_id, grant_jti, operation_kind, operation, operation_hash, repository_id, resource_number, attempt_token, lease_expires_at, attempt_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)").bind(operation.id, grant.instanceId, grant.jti, operation.kind, serializedOperation, operationHash, grant.repositoryId, grant.resourceNumber, attemptToken, leaseExpiresAt).run();
  else {
    const claimed = await c.env.DB.prepare("UPDATE operation_receipts SET status = 'executing', grant_jti = ?, attempt_token = ?, lease_expires_at = ?, attempt_count = attempt_count + 1, operation_hash = ?, error = NULL, completed_at = NULL WHERE operation_id = ? AND attempt_count < 20 AND (status = 'failed' OR (status = 'executing' AND lease_expires_at <= ?))").bind(grant.jti, attemptToken, leaseExpiresAt, operationHash, operation.id, now).run();
    if ((claimed.meta.changes ?? 0) !== 1) return c.json({ error: "Operation retry was claimed by another request" }, 409);
  }
  const attemptedAt = new Date().toISOString();
  const attempt = (existing?.attempt_count ?? 0) + 1;
  try {
    const result = await executeGitHubOperation(c.env, operation);
    const receipt = operationReceiptSchema.parse({ schemaVersion: "v2", operationId: operation.id, operationHash, kind: operation.kind, status: result.status === "already-applied" ? "skipped" : "succeeded", attempt, attemptedAt, completedAt: new Date().toISOString(), ...(result.providerRequestId ? { providerRequestId: result.providerRequestId } : {}), ...(result.url ? { resourceUrl: result.url } : {}) });
    const completed = await c.env.DB.prepare("UPDATE operation_receipts SET status = 'applied', receipt = ?, error = NULL, completed_at = CURRENT_TIMESTAMP WHERE operation_id = ? AND attempt_token = ?").bind(JSON.stringify(receipt), operation.id, attemptToken).run();
    if ((completed.meta.changes ?? 0) !== 1) return c.json({ error: "Operation execution lease expired" }, 409);
    return c.json(receipt);
  } catch (error) {
    const typed = error instanceof ConnectOperationError ? error : new ConnectOperationError("github_execution_failed", error instanceof Error ? error.message : "Operation failed", error instanceof TypeError);
    const receipt = operationReceiptSchema.parse({ schemaVersion: "v2", operationId: operation.id, operationHash, kind: operation.kind, status: "failed", attempt, attemptedAt, completedAt: new Date().toISOString(), error: { code: typed.code, message: typed.message.slice(0, 2_000), retryable: typed.retryable } });
    await c.env.DB.prepare("UPDATE operation_receipts SET status = 'failed', receipt = ?, error = ?, completed_at = CURRENT_TIMESTAMP WHERE operation_id = ? AND attempt_token = ?").bind(JSON.stringify(receipt), typed.message.slice(0, 500), operation.id, attemptToken).run();
    return c.json(receipt, typed.code === "unsupported_operation" ? 422 : typed.retryable ? 503 : 409);
  }
});

function eventScope(event: RepositoryEventV2): { resourceKind: GrantClaims["resourceKind"]; resourceNumber: number; eventState: string | null; eventDraft: number | null; headSha: string | null; baseRef: string | null; baseSha: string | null } {
  if (event.kind === "github.issue") return { resourceKind: "issue", resourceNumber: event.issue.number, eventState: event.issue.state, eventDraft: null, headSha: null, baseRef: null, baseSha: null };
  if (event.kind === "github.issue_comment") return { resourceKind: "issue", resourceNumber: event.issue.number, eventState: event.issue.state, eventDraft: null, headSha: null, baseRef: null, baseSha: null };
  if (event.kind === "github.pull_request" || event.kind === "github.pull_request_comment" || event.kind === "github.pull_request_review" || event.kind === "github.pull_request_review_comment") {
    const pull = event.pullRequest;
    return { resourceKind: "pull_request", resourceNumber: pull.number, eventState: pull.state, eventDraft: pull.draft ? 1 : 0, headSha: pull.head.sha, baseRef: pull.base.ref, baseSha: pull.base.sha };
  }
  if (event.kind === "github.discussion" || event.kind === "github.discussion_comment") return { resourceKind: "discussion", resourceNumber: event.discussion.number, eventState: event.discussion.state, eventDraft: null, headSha: null, baseRef: null, baseSha: null };
  if (event.kind === "github.check_run") return { resourceKind: "check", resourceNumber: Number(event.checkRun.id), eventState: event.checkRun.status, eventDraft: null, headSha: event.checkRun.headSha, baseRef: null, baseSha: null };
  if (event.kind === "github.check_suite") return { resourceKind: "check", resourceNumber: Number(event.checkSuite.id), eventState: event.checkSuite.status, eventDraft: null, headSha: event.checkSuite.headSha, baseRef: null, baseSha: null };
  if (event.kind === "github.release") return { resourceKind: "release", resourceNumber: Number(event.release.id), eventState: event.release.draft ? "draft" : "published", eventDraft: event.release.draft ? 1 : 0, headSha: null, baseRef: null, baseSha: null };
  return { resourceKind: "repository", resourceNumber: 0, eventState: null, eventDraft: null, headSha: null, baseRef: null, baseSha: null };
}

app.post("/github/webhook", async (c) => {
  const raw = await c.req.text();
  if (!(await verifyWebhookSignature(c.env.GITHUB_WEBHOOK_SECRET, raw, c.req.header("x-hub-signature-256") ?? null))) return c.json({ error: "Invalid signature" }, 401);
  const deliveryId = c.req.header("x-github-delivery"); const eventName = c.req.header("x-github-event");
  if (!deliveryId || !/^[A-Za-z0-9-]{1,100}$/.test(deliveryId) || !eventName) return c.json({ error: "Missing webhook headers" }, 400);
  const inserted = await c.env.DB.prepare("INSERT OR IGNORE INTO webhook_deliveries (delivery_id, event_name) VALUES (?, ?)").bind(deliveryId, eventName).run();
  if ((inserted.meta.changes ?? 0) === 0) {
    const prior = await c.env.DB.prepare("SELECT status FROM webhook_deliveries WHERE delivery_id = ? AND event_name = ?").bind(deliveryId, eventName).first<{ status: string }>();
    if (!prior || !["relay_failed", "unroutable"].includes(prior.status)) return c.json({ accepted: true, duplicate: true });
    await c.env.DB.prepare("UPDATE webhook_deliveries SET status = 'received', error = NULL WHERE delivery_id = ?").bind(deliveryId).run();
  }
  let payload: unknown; try { payload = JSON.parse(raw); } catch { await markDelivery(c.env, deliveryId, "invalid", "Invalid JSON"); return c.json({ error: "Invalid JSON" }, 400); }
  if (eventName === "ping") { await markDelivery(c.env, deliveryId, "ignored"); return c.json({ accepted: true, pong: true }); }
  if (eventName === "installation" || eventName === "installation_repositories") { await handleInstallationWebhook(c.env, eventName, payload); await markDelivery(c.env, deliveryId, "processed"); return c.json({ accepted: true }); }
  const supportedEvents = new Set(["issues", "pull_request", "issue_comment", "pull_request_review", "pull_request_review_comment", "discussion", "discussion_comment", "check_run", "check_suite", "push", "release"]);
  if (!supportedEvents.has(eventName)) { await markDelivery(c.env, deliveryId, "ignored"); return c.json({ accepted: true, ignored: true }); }
  let pendingEvent = normalizeGitHubWebhook(eventName, payload, deliveryId);
  if (!pendingEvent && eventName === "issue_comment" && isRecord(payload) && isRecord(payload.issue) && payload.issue.pull_request !== undefined) {
    try {
      const pullRequest = await fetchPullRequestForWebhook(c.env, payload);
      if (pullRequest) pendingEvent = normalizeGitHubWebhook("pull_request_comment", { ...payload, pull_request: pullRequest }, deliveryId);
    } catch { /* incomplete or unauthorized enrichment fails closed below */ }
  }
  if (!pendingEvent) { await markDelivery(c.env, deliveryId, "invalid", `Unsupported or incomplete ${eventName} payload`); return c.json({ error: "Unsupported or incomplete webhook payload" }, 400); }
  const route = await c.env.DB.prepare("SELECT r.instance_id, i.callback_url, i.cloudflare_access_credentials FROM repositories r JOIN instances i ON i.id = r.instance_id JOIN installations ins ON ins.id = r.installation_id WHERE r.id = ? AND r.installation_id = ? AND r.active = 1 AND i.revoked_at IS NULL AND ins.revoked_at IS NULL AND ins.suspended_at IS NULL").bind(pendingEvent.repository.id, pendingEvent.repository.installationId).first<{ instance_id: string; callback_url: string; cloudflare_access_credentials: string | null }>();
  if (!route?.callback_url) { await markDelivery(c.env, deliveryId, "unroutable", "Repository is not claimed"); return c.json({ accepted: true, routed: false }); }
  const event = repositoryEventV2Schema.parse({ ...pendingEvent, instanceId: route.instance_id });
  const scope = eventScope(event);
  const eventJson = JSON.stringify(event);
  const eventHash = await sha256(eventJson);
  await c.env.DB.prepare("UPDATE webhook_deliveries SET status = 'relaying', instance_id = ?, repository_id = ?, normalized_event_id = ?, resource_kind = ?, resource_number = ?, event_action = ?, event_state = ?, event_draft = ?, head_sha = ?, base_ref = ?, base_sha = ?, normalized_event_json = ?, normalized_event_hash = ? WHERE delivery_id = ?")
    .bind(route.instance_id, event.repository.id, event.id, scope.resourceKind, scope.resourceNumber, event.action, scope.eventState, scope.eventDraft, scope.headSha, scope.baseRef, scope.baseSha, eventJson, eventHash, deliveryId).run();
  const eventToken = await signToken(c.env, { typ: "gardener-event", event, eventHash, jti: deliveryId }, route.instance_id, 300);
  let accessHeaders: Record<string, string>;
  try {
    accessHeaders = await cloudflareAccessRelayHeaders(c.env, route.instance_id, route.cloudflare_access_credentials);
  } catch {
    await markDelivery(c.env, deliveryId, "relay_failed", "Cloudflare Access credentials unavailable");
    return c.json({ error: "Instance relay credentials are unavailable" }, 502);
  }
  const response = await fetch(createEventRelayRequest(route.callback_url, eventToken, accessHeaders));
  if (!response.ok) { await response.body?.cancel(); await markDelivery(c.env, deliveryId, "relay_failed", `HTTP ${response.status}`); return c.json({ error: "Instance relay failed" }, 502); }
  await response.body?.cancel(); await c.env.DB.prepare("UPDATE webhook_deliveries SET status = 'relayed', relayed_at = CURRENT_TIMESTAMP WHERE delivery_id = ?")
    .bind(deliveryId).run();
  return c.json({ accepted: true, routed: true, schemaVersion: "v2" }, 202);
});

export function createEventRelayRequest(
  callbackUrl: string,
  eventToken: string,
  accessHeaders: Record<string, string> = {},
): Request {
  return new Request(callbackUrl, {
    method: "POST",
    headers: { ...accessHeaders, authorization: `Bearer ${eventToken}`, "user-agent": "gardener-connect" },
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });
}

export async function cloudflareAccessRelayHeaders(
  env: Pick<Env, "ACCESS_CREDENTIAL_ENCRYPTION_KEY">,
  instanceId: string,
  encrypted: string | null,
): Promise<Record<string, string>> {
  if (!encrypted) return {};
  if (!env.ACCESS_CREDENTIAL_ENCRYPTION_KEY) throw new Error("Access credential encryption is unavailable");
  const credentials = await decryptAccessCredentials(env.ACCESS_CREDENTIAL_ENCRYPTION_KEY, instanceId, encrypted);
  return {
    "CF-Access-Client-Id": credentials.clientId,
    "CF-Access-Client-Secret": credentials.clientSecret,
  };
}

async function markDelivery(env: Env, id: string, status: string, error?: string) { await env.DB.prepare("UPDATE webhook_deliveries SET status = ?, error = ? WHERE delivery_id = ?").bind(status, error ?? null, id).run(); }

async function handleInstallationWebhook(env: Env, eventName: string, payload: unknown): Promise<void> {
  if (!isRecord(payload) || !isRecord(payload.installation) || !isPositive(payload.installation.id)) return;
  const id = String(payload.installation.id); const action = typeof payload.action === "string" ? payload.action : "";
  if (eventName === "installation" && ["deleted", "unsuspend", "suspend"].includes(action)) {
    if (action === "deleted") {
      await env.DB.batch([
        env.DB.prepare("UPDATE installations SET revoked_at = CURRENT_TIMESTAMP WHERE id = ?").bind(id),
        env.DB.prepare("UPDATE repositories SET active = 0, updated_at = CURRENT_TIMESTAMP WHERE installation_id = ?").bind(id),
      ]);
    }
    else await env.DB.prepare(`UPDATE installations SET suspended_at = ${action === "suspend" ? "CURRENT_TIMESTAMP" : "NULL"} WHERE id = ?`).bind(id).run();
  }
  const known = await env.DB.prepare("SELECT instance_id FROM installations WHERE id = ? AND revoked_at IS NULL").bind(id).first<{ instance_id: string }>(); if (known && action !== "deleted") await syncInstallation(env, known.instance_id, id);
}

function isRecord(value: unknown): value is Row { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isPositive(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }

app.notFound((c) => c.json({ error: "Not found" }, 404));
export { app };
export default app;
