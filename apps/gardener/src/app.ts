import { canonicalSha256 } from "@gardener/core";
import { Hono } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { bearerToken, verifyEventToken, verifyIdentityToken } from "./auth";
import { auditActor, compareAndSetOperationPolicies, policyMutationPermission, requirePermission, resolveMcpAuthorization, resolveRequestAuthorization, type AuthorizationVariables } from "./authorization";
import {
  beginGitHubInstallation,
  beginGitHubLogin,
  claimGardenerInstance,
  ConnectUsernameResolutionError,
  listConnectedRepositories,
  resolveGitHubUser,
} from "./connect";
import {
  consumeIdentityAssertion, dashboardSessionPayload, IdentityExchangeError, INVITATION_TTL_SECONDS, issueDashboardSession,
  LOCAL_SESSION_COOKIE, resolveDashboardSession, revokeDashboardSession,
  SECURE_SESSION_COOKIE, sessionTokenFromRequest,
} from "./identity";
import { ensureDatabase } from "./database";
import { audit, getSetting, repositoryPauseSetting, setSetting } from "./instance-state";
import { operationKindSchema, policyModeSchema, type RepositoryEventV2 } from "./domain";
import { cloudflareAccessCredentials, instanceId, type Env } from "./env";
import { createGardenerMcpOAuthProvider, type ConsentConsumeResult, type ConsentStateStore, type GardenerMcpEnv, type StoredConsentState } from "./mcp";
import {
  admitRepositoryEvent,
  claimRepositoryEventAdmission,
  completeRepositoryEventAdmission,
  getRun,
  listAgents,
  listOpenInbox,
  listRepositoryEventRunIds,
  releaseRepositoryEventAdmission,
} from "./persistence";
import { setupPolicyProfile, setupProfileIds } from "./setup";
import { agentCatalog, agentManagement, createGardenerMcpServices } from "./agent-management";
import { admitAgentRunsForEvent } from "./run-admission";

interface AppBindings {
  Bindings: Env;
  Variables: AuthorizationVariables;
}

const dashboardPrincipalKinds = ["dashboard-session", "local-dev"] as const;
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
  const agentRuntime = { enabled: true, status: "bounded-issue-comment-v3" } as const;
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
  const admissionToken = crypto.randomUUID();
  const now = new Date();
  const claimed = await claimRepositoryEventAdmission(c.env.DB, {
    eventId: event.id,
    token: admissionToken,
    now: now.toISOString(),
    leaseExpiresAt: new Date(now.getTime() + 5 * 60_000).toISOString(),
  });
  if (!claimed) {
    const runIds = await listRepositoryEventRunIds(c.env.DB, event.id);
    return c.json({ accepted: true, duplicate: !admitted.admitted, runs: runIds.map((runId) => ({ runId, created: false })), runtime: "bounded-issue-comment-v3" }, 200);
  }
  try {
    const runs = await admitAgentRunsForEvent(c.env, admitted.event.envelope, admitted.event.envelopeHash);
    if (!await completeRepositoryEventAdmission(c.env.DB, { eventId: event.id, token: admissionToken, now: new Date().toISOString() })) {
      throw new Error("Repository event admission completion lost its lease");
    }
    return c.json({ accepted: true, duplicate: !admitted.admitted, runs, runtime: "bounded-issue-comment-v3" }, admitted.admitted ? 202 : 200);
  } catch (error) {
    await releaseRepositoryEventAdmission(c.env.DB, { eventId: event.id, token: admissionToken });
    throw error;
  }
});

app.get("/api/auth/start", async (c) => c.redirect(await beginGitHubLogin(c.env, new URL(c.req.url).origin), 302));
app.post("/api/auth/session", async (c) => {
  if (c.req.header("origin") !== new URL(c.req.url).origin) return c.json({ error: "invalid_origin" }, 403);
  const { token } = z.object({ token: z.string().min(1).max(20_000) }).strict().parse(await c.req.json());
  let assertion; try { assertion=await verifyIdentityToken(token,c.env); } catch { return c.json({error:"invalid_identity_assertion"},401); }
  let principal;
  try { principal = await consumeIdentityAssertion(c.env.DB, assertion, c.env.CONNECT_ISSUER); }
  catch (error) {
    if (error instanceof IdentityExchangeError) return c.json({ error: error.code }, error.code === "identity_not_authorized" ? 403 : 409);
    throw error;
  }
  clearSessionCookies(c);
  const secure = new URL(c.req.url).protocol === "https:";
  const session = await issueDashboardSession(c.env.DB, principal, secure);
  setCookie(c, session.cookieName, session.token, { httpOnly: true, secure, sameSite: "Lax", path: "/", maxAge: session.maxAge });
  return c.json(dashboardSessionPayload(principal));
});
app.get("/api/auth/session", async (c) => {
  const token = sessionTokenFromRequest(c.req.raw); const session = token ? await resolveDashboardSession(c.env.DB, token) : null;
  if (!session) { clearSessionCookies(c); return c.json({ authenticated: false }); }
  if (session.role === "owner" && cloudflareAccessCredentials(c.env)) await claimGardenerInstance(c.env, new URL(c.req.url).origin);
  return c.json(dashboardSessionPayload(session));
});
app.post("/api/auth/logout", async (c) => {
  if (c.req.header("origin") !== new URL(c.req.url).origin) return c.json({ error: "invalid_origin" }, 403);
  const token = sessionTokenFromRequest(c.req.raw); if (token) await revokeDashboardSession(c.env.DB, token);
  clearSessionCookies(c); return c.json({ signedOut: true });
});

app.use("/api/*", async (c, next) => {
  const principal = await resolveRequestAuthorization(c.req.raw, c.env);
  if (!principal) return c.json({ error: "authentication_required", message: "Authentication required" }, 401);
  if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method) && c.req.header("origin") !== new URL(c.req.url).origin) return c.json({ error: "invalid_origin", message: "Invalid request origin" }, 403);
  c.set("authorization", principal); c.set("actor", principal.userId); c.set("actorLogin", principal.displayName);
  if (principal.principalKind === "dashboard-session") {
    const token=sessionTokenFromRequest(c.req.raw); const secure=new URL(c.req.url).protocol==="https:";
    if(token)setCookie(c,secure?SECURE_SESSION_COOKIE:LOCAL_SESSION_COOKIE,token,{httpOnly:true,secure,sameSite:"Lax",path:"/",maxAge:30*60});
  }
  return next();
});

app.get("/api/members", async (c) => {
  const denied=requirePermission(c, "workspace.view", dashboardPrincipalKinds); if(denied) return denied;
  const [members, invitations] = await Promise.all([
    c.env.DB.prepare("SELECT u.id, u.display_name, m.role, m.permanent, e.username, e.provider_subject FROM memberships m JOIN users u ON u.id=m.user_id JOIN external_identities e ON e.user_id=u.id AND e.provider='github' ORDER BY CASE m.role WHEN 'owner' THEN 0 ELSE 1 END, u.display_name").all(),
    c.env.DB.prepare("SELECT id, username, provider_subject, created_at, datetime(created_at, ?) expires_at FROM invitations WHERE status='pending' AND created_at >= datetime('now', ?) ORDER BY created_at").bind(`+${INVITATION_TTL_SECONDS} seconds`, `-${INVITATION_TTL_SECONDS} seconds`).all(),
  ]);
  return c.json({ members: members.results, invitations: invitations.results });
});
app.post("/api/invitations", async (c) => {
  const denied=requirePermission(c, "member.manage", dashboardPrincipalKinds); if(denied) return denied;
  const { githubUsername }=z.object({ githubUsername:z.string().trim().min(1).max(39).regex(/^(?!.*--)[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/) }).strict().parse(await c.req.json());
  let resolved; try { resolved=await resolveGitHubUser(c.env, githubUsername); } catch(error) { if(error instanceof ConnectUsernameResolutionError) return c.json({ error:`github_user_resolution_${error.status}` }, error.status); throw error; }
  const existing=await c.env.DB.prepare("SELECT m.id FROM memberships m JOIN external_identities e ON e.user_id=m.user_id WHERE e.provider='github' AND e.provider_subject=?").bind(resolved.githubUserId).first();
  if(existing) return c.json({ error:"already_a_member" },409);
  const id=`invitation_${crypto.randomUUID().replaceAll("-","")}`; const actor=auditActor(c.get("authorization"));
  const inserted=await c.env.DB.batch([
    c.env.DB.prepare("UPDATE invitations SET status='revoked', revoked_at=CURRENT_TIMESTAMP WHERE provider='github' AND provider_subject=? AND status='pending' AND created_at < datetime('now', ?)").bind(resolved.githubUserId,`-${INVITATION_TTL_SECONDS} seconds`),
    c.env.DB.prepare("INSERT INTO invitations (id, provider, provider_subject, username, role, invited_by_user_id) SELECT ?, 'github', ?, ?, 'member', ? WHERE NOT EXISTS (SELECT 1 FROM invitations WHERE provider='github' AND provider_subject=? AND status='pending')").bind(id,resolved.githubUserId,resolved.githubLogin,c.get("authorization").userId,resolved.githubUserId),
    c.env.DB.prepare("INSERT INTO audit_records (actor, actor_user_id, actor_identity_json, action, resource_type, resource_id, detail_json) SELECT ?, ?, ?, 'membership.invited', 'invitation', ?, ? WHERE EXISTS (SELECT 1 FROM invitations WHERE id=?)").bind(actor.actor,actor.actorUserId,actor.actorIdentityJson,id,JSON.stringify({ provider:"github", providerSubject:resolved.githubUserId, login:resolved.githubLogin }),id),
  ]);
  if((inserted[1]?.meta.changes??0)!==1)return c.json({error:"invitation_already_pending"},409);
  return c.json({ invitation:{ id, githubUsername:resolved.githubLogin, role:"member" } },201);
});
app.delete("/api/invitations/:id", async(c)=>{
  const denied=requirePermission(c,"member.manage",dashboardPrincipalKinds); if(denied)return denied; const id=c.req.param("id"); const actor=auditActor(c.get("authorization"));
  const result=await c.env.DB.batch([
    c.env.DB.prepare("UPDATE invitations SET status='revoked', revoked_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending'").bind(id),
    c.env.DB.prepare("INSERT INTO audit_records (actor, actor_user_id, actor_identity_json, action, resource_type, resource_id, detail_json) SELECT ?, ?, ?, 'membership.invitation_revoked', 'invitation', ?, '{}' WHERE EXISTS (SELECT 1 FROM invitations WHERE id=? AND status='revoked')").bind(actor.actor,actor.actorUserId,actor.actorIdentityJson,id,id),
  ]); if((result[0]?.meta.changes??0)!==1)return c.json({error:"pending_invitation_not_found"},404); return c.json({revoked:true});
});
app.delete("/api/members/:id", async(c)=>{
  const denied=requirePermission(c,"member.manage",dashboardPrincipalKinds); if(denied)return denied; const target=await c.env.DB.prepare("SELECT m.user_id,m.role,m.permanent,u.display_name,e.provider_subject,e.username FROM memberships m JOIN users u ON u.id=m.user_id JOIN external_identities e ON e.user_id=u.id AND e.provider='github' WHERE m.user_id=?").bind(c.req.param("id")).first<{user_id:string;role:string;permanent:number;display_name:string;provider_subject:string;username:string}>();
  if(!target)return c.json({error:"member_not_found"},404); if(target.role==="owner"||target.permanent)return c.json({error:"owner_membership_permanent"},409);
  const actor=auditActor(c.get("authorization")); await c.env.DB.batch([
    c.env.DB.prepare("UPDATE dashboard_sessions SET revoked_at=CURRENT_TIMESTAMP WHERE user_id=? AND revoked_at IS NULL").bind(target.user_id),
    c.env.DB.prepare("DELETE FROM memberships WHERE user_id=? AND role='member' AND permanent=0").bind(target.user_id),
    c.env.DB.prepare("INSERT INTO audit_records (actor, actor_user_id, actor_identity_json, action, resource_type, resource_id, detail_json) VALUES (?, ?, ?, 'membership.removed', 'membership', ?, ?)").bind(actor.actor,actor.actorUserId,actor.actorIdentityJson,target.user_id,JSON.stringify({displayName:target.display_name,identity:{provider:"github",providerSubject:target.provider_subject,login:target.username}})),
  ]); return c.json({removed:true});
});

app.route("/api", agentManagement);
app.get("/api/agent-catalog", (c) => { const denied=requirePermission(c,"workspace.view",dashboardPrincipalKinds); return denied??c.json(agentCatalog); });
app.post("/api/install/start", async (c) => {
  const denied=requirePermission(c,"installation.manage",dashboardPrincipalKinds); if(denied)return denied;
  const body=z.object({redirectUri:z.string().url().max(2048).optional()}).strict().parse(await c.req.json().catch(()=>({})));
  const origin=new URL(c.req.url).origin; const redirectUri=body.redirectUri??`${origin}/`; if(new URL(redirectUri).origin!==origin)return c.json({error:"invalid_redirect_uri"},400);
  return c.json({ installationUrl: await beginGitHubInstallation(c.env, c.get("authorization").identity.providerSubject, redirectUri) });
});
app.post("/api/repositories/sync", async (c) => {
  const denied=requirePermission(c,"repository.sync",dashboardPrincipalKinds); if(denied)return denied;
  const repositories = await listConnectedRepositories(c.env);
  await c.env.DB.prepare("UPDATE repositories SET active = 0, updated_at = CURRENT_TIMESTAMP").run();
  for (const repository of repositories) {
    await c.env.DB.prepare(
      "INSERT INTO repositories (id, installation_id, owner, name, default_branch, active) VALUES (?, ?, ?, ?, ?, 1) " +
      "ON CONFLICT(id) DO UPDATE SET installation_id = excluded.installation_id, owner = excluded.owner, name = excluded.name, default_branch = excluded.default_branch, active = 1, updated_at = CURRENT_TIMESTAMP",
    ).bind(repository.id, repository.installationId, repository.owner, repository.name, repository.defaultBranch ?? null).run();
  }
  await auditWithPrincipal(c.env.DB,c.get("authorization"),"repositories.synced","instance",instanceId(c.env),{count:repositories.length});
  return c.json({ repositories });
});
app.get("/api/policies", async (c) => { const denied=requirePermission(c,"workspace.view",dashboardPrincipalKinds); if(denied)return denied; return c.json({ policies: (await c.env.DB.prepare("SELECT operation_kind, mode, updated_at FROM operation_policies ORDER BY operation_kind").all()).results }); });
app.put("/api/policies", async (c) => {
  const body = z.object({ policies: z.array(z.object({ operation: operationKindSchema, mode: policyModeSchema }).strict()).min(1).max(operationKindSchema.options.length) }).strict().parse(await c.req.json());
  if (new Set(body.policies.map((item) => item.operation)).size !== body.policies.length) return c.json({ error: "Duplicate policy operation" }, 400);
  const current = new Map((await c.env.DB.prepare("SELECT operation_kind, mode FROM operation_policies").all<{operation_kind:string;mode:z.infer<typeof policyModeSchema>}>()).results.map(row=>[row.operation_kind,row.mode]));
  const changes=body.policies.map(item=>({operation:item.operation,expectedMode:current.get(item.operation)??"disabled",nextMode:item.mode}));
  const permission = changes.some(item=>policyMutationPermission(item.expectedMode,item.nextMode)==="policy.widen") ? "policy.widen" : "policy.narrow";
  const denied=requirePermission(c,permission,dashboardPrincipalKinds); if(denied)return denied;
  if(await compareAndSetOperationPolicies(c.env.DB,changes,auditActor(c.get("authorization")))==="conflict")return c.json({error:"policy_changed"},409);
  return c.json(body);
});
app.put("/api/policies/:operation", async (c) => {
  const operation = operationKindSchema.safeParse(c.req.param("operation"));
  if (!operation.success) return c.json({ error: "Unknown operation" }, 404);
  const { mode } = z.object({ mode: policyModeSchema }).strict().parse(await c.req.json());
  const current=await c.env.DB.prepare("SELECT mode FROM operation_policies WHERE operation_kind=?").bind(operation.data).first<{mode:z.infer<typeof policyModeSchema>}>();
  const expectedMode=current?.mode??"disabled"; const denied=requirePermission(c,policyMutationPermission(expectedMode,mode),dashboardPrincipalKinds); if(denied)return denied;
  if(await compareAndSetOperationPolicies(c.env.DB,[{operation:operation.data,expectedMode,nextMode:mode}],auditActor(c.get("authorization")))==="conflict")return c.json({error:"policy_changed"},409);
  return c.json({ operation: operation.data, mode });
});
app.post("/api/setup/activate", async (c) => {
  const denied=requirePermission(c,"policy.widen",dashboardPrincipalKinds); if(denied)return denied;
  const { profile } = z.object({ profile: z.enum(setupProfileIds) }).strict().parse(await c.req.json());
  if (!await c.env.DB.prepare("SELECT 1 FROM repositories WHERE active = 1 LIMIT 1").first()) return c.json({ error: "Connect at least one repository before completing setup" }, 409);
  const policies = setupPolicyProfile(profile);
  await c.env.DB.batch([
    ...Object.entries(policies).map(([operation, mode]) => c.env.DB.prepare("UPDATE operation_policies SET mode = ?, updated_at = CURRENT_TIMESTAMP WHERE operation_kind = ?").bind(mode, operation)),
    c.env.DB.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('global_paused', 'false', CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP"),
    c.env.DB.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('onboarding_completed', 'true', CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP"),
    c.env.DB.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('setup_profile', ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP").bind(profile),
  ]);
  await auditWithPrincipal(c.env.DB,c.get("authorization"),"setup.completed","instance",instanceId(c.env),{profile});
  return c.json({ activated: true, profile, agentsEnabled: false });
});
app.post("/api/settings/pause", async (c) => {
  const { paused } = z.object({ paused: z.boolean() }).strict().parse(await c.req.json());
  const denied=requirePermission(c,paused?"policy.narrow":"policy.widen",dashboardPrincipalKinds); if(denied)return denied;
  await setSetting(c.env.DB, "global_paused", String(paused));
  await auditWithPrincipal(c.env.DB,c.get("authorization"),paused?"system.paused":"system.resumed","instance",instanceId(c.env));
  return c.json({ globalPaused: paused });
});
app.put("/api/repositories/:id/pause", async (c) => {
  const id = c.req.param("id"); const { paused } = z.object({ paused: z.boolean() }).strict().parse(await c.req.json());
  const denied=requirePermission(c,paused?"assignment.pause":"assignment.resume",dashboardPrincipalKinds); if(denied)return denied;
  const repository = await c.env.DB.prepare("SELECT owner, name FROM repositories WHERE id = ? AND active = 1").bind(id).first<{ owner: string; name: string }>();
  if (!repository) return c.json({ error: "Active repository not found" }, 404);
  await setSetting(c.env.DB, repositoryPauseSetting(id), String(paused));
  await auditWithPrincipal(c.env.DB,c.get("authorization"),paused?"repository.paused":"repository.resumed","repository",id,repository);
  return c.json({ id, paused });
});
app.get("/api/runs", async (c) => {
  const denied=requirePermission(c,"workspace.view",dashboardPrincipalKinds); if(denied)return denied;
  const limit = z.coerce.number().int().min(1).max(100).default(50).parse(c.req.query("limit"));
  return c.json({ runs: (await c.env.DB.prepare("SELECT id, kind, agent_id, agent_revision_id, status, harness_id, harness_version, created_at, started_at, completed_at FROM agent_runs ORDER BY created_at DESC LIMIT ?").bind(limit).all()).results });
});
app.get("/api/runs/:id", async (c) => {
  const denied=requirePermission(c,"workspace.view",dashboardPrincipalKinds); if(denied)return denied;
  const run = await getRun(c.env.DB, c.req.param("id")); if (!run) return c.json({ error: "Run not found" }, 404);
  const [tasks, steps, effects] = await Promise.all([
    c.env.DB.prepare("SELECT id, parent_task_id, stable_key, kind, status, parallel_group, depth, created_at, started_at, completed_at FROM run_tasks WHERE run_id = ? ORDER BY created_at").bind(run.id).all(),
    c.env.DB.prepare("SELECT id, task_id, stable_key, kind, status, attempt_count, max_attempts, created_at, started_at, completed_at FROM run_steps WHERE run_id = ? ORDER BY created_at").bind(run.id).all(),
    c.env.DB.prepare("SELECT id, operation_id, effect_kind, policy_mode, status, created_at, decided_at, executed_at FROM effects WHERE run_id = ? ORDER BY created_at").bind(run.id).all(),
  ]);
  return c.json({ run, tasks: tasks.results, steps: steps.results, effects: effects.results });
});
app.get("/api/state", async (c) => {
  const denied=requirePermission(c,"workspace.view",dashboardPrincipalKinds); if(denied)return denied;
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
    capabilities: { agentAuthoring: "available", agentRuntime: "bounded-issue-comment", computerWorkspace: "preview", oauthMcp: c.env.OAUTH_KV ? "available" : "needs-kv-binding" },
  });
});

app.notFound((c) => {
  const path = new URL(c.req.url).pathname;
  if (path.startsWith("/api/") || path.startsWith("/hooks/") || path === "/mcp" || path.startsWith("/oauth/")) {
    return c.json({ error: "Not found" }, 404);
  }
  return c.env.ASSETS.fetch(c.req.raw);
});

async function auditWithPrincipal(db:D1Database,principal:AuthorizationVariables["authorization"],action:string,resourceType:string,resourceId:string,detail:unknown={}):Promise<void>{
  const actor=auditActor(principal); await db.prepare("INSERT INTO audit_records(actor,actor_user_id,actor_identity_json,action,resource_type,resource_id,detail_json) VALUES(?,?,?,?,?,?,?)").bind(actor.actor,actor.actorUserId,actor.actorIdentityJson,action,resourceType,resourceId,JSON.stringify(detail)).run();
}

function clearSessionCookies(c: Parameters<typeof deleteCookie>[0]): void {
  deleteCookie(c, SECURE_SESSION_COOKIE, { path: "/", secure: true });
  deleteCookie(c, LOCAL_SESSION_COOKIE, { path: "/" });
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
        const token = sessionTokenFromRequest(ownerRequest); if (!token) return null;
        const session = await resolveDashboardSession(ownerEnv.DB, token);
        if (!session || session.role !== "owner") return null;
        return { githubUserId: session.identity.providerSubject, githubLogin: session.identity.login, instanceId: instanceId(ownerEnv) };
      },
      services: (ownerEnv) => {
        const services = createGardenerMcpServices(ownerEnv);
        return { ...services, resolvePrincipal: (tokenPrincipal) => resolveMcpAuthorization(ownerEnv.DB,instanceId(ownerEnv),tokenPrincipal) };
      },
      consentState: (ownerEnv) => new D1ConsentStateStore(ownerEnv.DB),
    }, { issuer: origin, audience: `${origin}/mcp` });
    return provider.fetch(request, env as GardenerMcpEnv & Env, ctx);
  },
} satisfies ExportedHandler<Env>;

// Flue consumes the Hono route map; src/index.ts remains the authored Worker
// entry and composes these routes with OAuth plus Flue's generated exports.
export default app;
