import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { bearerToken, verifyEventToken, verifyIdentityToken } from "./auth";
import {
  beginGitHubInstallation,
  beginGitHubLogin,
  executeThroughConnect,
  listConnectedRepositories,
} from "./connect";
import { ensureDatabase } from "./database";
import { audit, createRunsForEvent, getSetting, ingestEvent, pauseScope, policySnapshot, repositoryPauseSetting, setSetting } from "./db";
import {
  operationSchema,
  policyModeSchema,
  type ConnectEvent,
  type PolicyMode,
  type RunQueueMessage,
} from "./domain";
import { instanceId, type Env } from "./env";
import { runIssueGardener } from "./runtime";
import { setupPolicyProfile, setupProfileIds } from "./setup";

interface AppBindings {
  Bindings: Env;
  Variables: { actor: string; actorLogin: string; identityToken: string };
}

const sessionCookie = "gardener_session";
const app = new Hono<AppBindings>();

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
  try {
    await c.env.DB.prepare("SELECT 1").first();
    database = true;
  } catch {
    // Report unhealthy without leaking the database error.
  }
  const queue = Boolean(c.env.RUN_QUEUE);
  const workersAi = Boolean(c.env.AI && c.env.AI_MODEL);
  let connectConfigured = false;
  try {
    connectConfigured = Boolean(c.env.CONNECT_URL && c.env.CONNECT_ISSUER && instanceId(c.env));
  } catch {
    // Invalid or missing bootstrap token.
  }
  return c.json({
    ok: database && queue && workersAi && connectConfigured,
    database,
    queue,
    workersAi,
    connectConfigured,
    localDevelopment: c.env.LOCAL_DEV_BYPASS === "true",
    codeExecution: { enabled: false, status: "deferred", experimental: true },
  });
});

app.post("/hooks/connect", async (c) => {
  const headerToken = bearerToken(c.req.header("authorization"));
  let bodyToken: string | undefined;
  if (!headerToken) {
    const body = z.object({ token: z.string().min(1).max(20_000) }).strict().parse(await c.req.json());
    bodyToken = body.token;
  }
  let event: ConnectEvent;
  try {
    event = await verifyEventToken(headerToken ?? bodyToken ?? "", c.env);
  } catch {
    return c.json({ error: "Invalid or expired event signature" }, 401);
  }
  const inserted = await ingestEvent(c.env.DB, event);
  if (!inserted) {
    const queued = await c.env.DB.prepare("SELECT id FROM runs WHERE event_id = ? AND status = 'queued'")
      .bind(event.id).all<{ id: string }>();
    await Promise.all(queued.results.map((run) => c.env.RUN_QUEUE.send({ runId: run.id })));
    return c.json({ accepted: true, duplicate: true, runs: queued.results.map((run) => run.id) });
  }

  await audit(c.env.DB, "connect", "event.received", "event", event.id, {
    deliveryId: event.deliveryId,
    kind: event.kind,
    action: event.action,
  });
  const pausedBy = await pauseScope(c.env.DB, event.repository.id);
  const runs = pausedBy ? [] : await createRunsForEvent(c.env, event);
  return c.json({ accepted: true, duplicate: false, paused: Boolean(pausedBy), pausedBy, runs }, 202);
});

app.get("/api/auth/start", async (c) => {
  const origin = new URL(c.req.url).origin;
  const authorizationUrl = await beginGitHubLogin(c.env, origin);
  return c.redirect(authorizationUrl, 302);
});

app.post("/api/auth/session", async (c) => {
  const { token } = z.object({ token: z.string().min(1).max(20_000) }).strict().parse(await c.req.json());
  const identity = await verifyIdentityToken(token, c.env);
  const now = Math.floor(Date.now() / 1_000);
  const maxAge = typeof identity.exp === "number" ? Math.max(1, Math.min(28_800, identity.exp - now)) : 28_800;
  setCookie(c, sessionCookie, token, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === "https:",
    sameSite: "Strict",
    path: "/",
    maxAge,
  });
  return c.json({ authenticated: true, githubLogin: typeof identity.githubLogin === "string" ? identity.githubLogin : "GitHub user" });
});

app.get("/api/auth/session", async (c) => {
  const token = getCookie(c, sessionCookie);
  if (!token) return c.json({ authenticated: false });
  try {
    const identity = await verifyIdentityToken(token, c.env);
    return c.json({ authenticated: true, githubLogin: typeof identity.githubLogin === "string" ? identity.githubLogin : "GitHub user" });
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
    c.set("actor", "local-development");
    c.set("actorLogin", "Local developer");
    c.set("identityToken", "local-development");
    return next();
  }
  const bearer = bearerToken(c.req.header("authorization"));
  const cookie = getCookie(c, sessionCookie);
  const token = bearer ?? cookie;
  if (!token) return c.json({ error: "Authentication required" }, 401);
  if (!bearer && !["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
    const origin = c.req.header("origin");
    if (origin !== new URL(c.req.url).origin) return c.json({ error: "Invalid request origin" }, 403);
  }
  try {
    const identity = await verifyIdentityToken(token, c.env);
    c.set("actor", identity.sub as string);
    c.set("actorLogin", typeof identity.githubLogin === "string" ? identity.githubLogin : "GitHub user");
    c.set("identityToken", token);
    return next();
  } catch {
    return c.json({ error: "Invalid or expired session" }, 401);
  }
});

app.post("/api/health/ai", async (c) => {
  const result = await runIssueGardener({
    ai: c.env.AI,
    model: c.env.AI_MODEL,
    runId: `smoke-${crypto.randomUUID()}`,
    instructions: "Classify this synthetic issue for a deployment health check. Do not propose a comment.",
    event: {
      schemaVersion: "v1",
      id: "smoke-event",
      deliveryId: "smoke-delivery",
      instanceId: instanceId(c.env),
      kind: "github.issue",
      action: "opened",
      occurredAt: new Date().toISOString(),
      repository: { provider: "github", id: "smoke-repository", installationId: "smoke-installation", owner: "gardener-smoke", name: "health-check" },
      issue: { id: "smoke-issue", number: 1, title: "Documentation needs a clearer setup example", body: "This is synthetic data used only to verify Workers AI JSON Schema output.", state: "open", labels: [], author: "gardener", htmlUrl: "https://github.com/gardener-smoke/health-check/issues/1" },
    },
  });
  await audit(c.env.DB, c.get("actor"), "workers_ai.smoke_tested", "instance", instanceId(c.env), { model: result.usage.model });
  return c.json({ ok: true, model: result.usage.model, usage: result.usage, proposals: result.proposals.map((proposal) => proposal.operation.kind) });
});

app.post("/api/install/start", async (c) => {
  const installationUrl = await beginGitHubInstallation(c.env, c.get("identityToken"), new URL(c.req.url).origin);
  return c.json({ installationUrl });
});

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

app.get("/api/workflows", async (c) => {
  const workflows = await c.env.DB
    .prepare("SELECT id, name, version, enabled, trigger_kind, instructions, compiled_plan, created_at, updated_at FROM workflows ORDER BY name")
    .all();
  return c.json({ workflows: workflows.results });
});

app.get("/api/policies", async (c) => {
  const policies = await c.env.DB
    .prepare("SELECT operation_kind, mode, updated_at FROM operation_policies ORDER BY operation_kind")
    .all();
  return c.json({ policies: policies.results });
});

app.get("/api/runs", async (c) => {
  const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) }).parse(c.req.query());
  const runs = await c.env.DB
    .prepare(
      "SELECT r.id, r.status, r.summary, r.usage, r.error, r.created_at, r.started_at, r.completed_at, " +
        "w.name AS workflow_name, e.action, repo.owner, repo.name FROM runs r " +
        "JOIN workflows w ON w.id = r.workflow_id JOIN events e ON e.id = r.event_id " +
        "JOIN repositories repo ON repo.id = e.repository_id ORDER BY r.created_at DESC LIMIT ?",
    )
    .bind(limit)
    .all();
  return c.json({ runs: runs.results });
});

app.get("/api/state", async (c) => {
  const [paused, onboardingCompleted, setupProfile, workflows, policies, repositories, repositoryPauses, runs, approvals, audits] = await Promise.all([
    getSetting(c.env.DB, "global_paused"),
    getSetting(c.env.DB, "onboarding_completed"),
    getSetting(c.env.DB, "setup_profile"),
    c.env.DB.prepare("SELECT id, name, version, enabled, trigger_kind, updated_at FROM workflows ORDER BY name").all(),
    c.env.DB.prepare("SELECT operation_kind, mode, updated_at FROM operation_policies ORDER BY operation_kind").all(),
    c.env.DB.prepare("SELECT id, owner, name, default_branch, active, updated_at FROM repositories ORDER BY owner, name").all(),
    c.env.DB.prepare("SELECT key, value FROM settings WHERE key LIKE 'repository_paused:%'").all<{ key: string; value: string }>(),
    c.env.DB
      .prepare(
        "SELECT r.id, r.status, r.workflow_version, r.summary, r.usage, r.error, r.created_at, r.started_at, r.completed_at, w.name AS workflow_name, " +
          "e.action, repo.owner, repo.name FROM runs r JOIN workflows w ON w.id = r.workflow_id " +
          "JOIN events e ON e.id = r.event_id JOIN repositories repo ON repo.id = e.repository_id " +
          "ORDER BY r.created_at DESC LIMIT 50",
      )
      .all(),
    c.env.DB
      .prepare(
        "SELECT p.id, p.run_id, p.operation_kind, p.policy_mode, p.rationale, p.operation, p.created_at, " +
          "r.summary, e.event_kind, e.action, e.resource_id, repo.owner, repo.name " +
          "FROM proposals p JOIN runs r ON r.id = p.run_id JOIN events e ON e.id = r.event_id " +
          "JOIN repositories repo ON repo.id = e.repository_id WHERE p.status = 'pending' " +
          "ORDER BY p.created_at DESC LIMIT 50",
      )
      .all(),
    c.env.DB
      .prepare("SELECT actor, action, resource_type, resource_id, created_at FROM audit_records ORDER BY created_at DESC LIMIT 30")
      .all(),
  ]);

  const pausedRepositories = new Set(repositoryPauses.results.filter((setting) => setting.value === "true").map((setting) => setting.key.slice("repository_paused:".length)));
  return c.json({
    globalPaused: paused !== "false",
    viewer: { login: c.get("actorLogin") },
    setup: {
      completed: onboardingCompleted === "true",
      profile: setupProfile,
      activeRepositories: repositories.results.filter((repository) => Boolean(repository.active)).length,
    },
    workflows: workflows.results,
    policies: policies.results,
    repositories: repositories.results.map((repository) => ({ ...repository, paused: pausedRepositories.has(String(repository.id)) })),
    runs: runs.results,
    approvals: approvals.results,
    audits: audits.results,
    capabilities: {
      issueGardening: "available",
      pullRequestReview: "planned",
      computerCodeChanges: "deferred-preview",
      protectedMerge: "planned",
    },
  });
});

app.get("/api/runs/:id", async (c) => {
  const run = await c.env.DB.prepare("SELECT * FROM runs WHERE id = ?").bind(c.req.param("id")).first();
  if (!run) return c.json({ error: "Run not found" }, 404);
  const proposals = await c.env.DB
    .prepare("SELECT * FROM proposals WHERE run_id = ? ORDER BY created_at, id")
    .bind(c.req.param("id"))
    .all();
  return c.json({ run, proposals: proposals.results });
});

app.post("/api/setup/activate", async (c) => {
  const { profile } = z.object({ profile: z.enum(setupProfileIds) }).strict().parse(await c.req.json());
  const repository = await c.env.DB.prepare("SELECT 1 FROM repositories WHERE active = 1 LIMIT 1").first();
  if (!repository) return c.json({ error: "Connect at least one repository before activating Gardener" }, 409);

  const policies = setupPolicyProfile(profile);
  await c.env.DB.batch([
    ...Object.entries(policies).map(([operation, mode]) => c.env.DB
      .prepare("UPDATE operation_policies SET mode = ?, updated_at = CURRENT_TIMESTAMP WHERE operation_kind = ?")
      .bind(mode, operation)),
    c.env.DB.prepare("UPDATE workflows SET enabled = 1, updated_at = CURRENT_TIMESTAMP WHERE id = 'issue-gardener'"),
    c.env.DB.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('global_paused', 'false', CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP"),
    c.env.DB.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('onboarding_completed', 'true', CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP"),
    c.env.DB.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('setup_profile', ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP").bind(profile),
  ]);
  await audit(c.env.DB, c.get("actor"), "setup.activated", "instance", instanceId(c.env), { profile });
  return c.json({ activated: true, profile });
});

app.post("/api/settings/pause", async (c) => {
  const { paused } = z.object({ paused: z.boolean() }).parse(await c.req.json());
  await setSetting(c.env.DB, "global_paused", String(paused));
  await audit(c.env.DB, c.get("actor"), paused ? "system.paused" : "system.resumed", "instance", instanceId(c.env));
  return c.json({ globalPaused: paused });
});

app.put("/api/repositories/:id/pause", async (c) => {
  const id = c.req.param("id");
  const { paused } = z.object({ paused: z.boolean() }).strict().parse(await c.req.json());
  const repository = await c.env.DB.prepare("SELECT owner, name FROM repositories WHERE id = ? AND active = 1").bind(id).first<{ owner: string; name: string }>();
  if (!repository) return c.json({ error: "Active repository not found" }, 404);
  await setSetting(c.env.DB, repositoryPauseSetting(id), String(paused));
  await audit(c.env.DB, c.get("actor"), paused ? "repository.paused" : "repository.resumed", "repository", id, { owner: repository.owner, name: repository.name });
  return c.json({ id, paused });
});

app.post("/api/workflows/:id/status", async (c) => {
  const { enabled } = z.object({ enabled: z.boolean() }).parse(await c.req.json());
  const id = c.req.param("id");
  const result = await c.env.DB
    .prepare("UPDATE workflows SET enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .bind(enabled ? 1 : 0, id)
    .run();
  if ((result.meta.changes ?? 0) === 0) return c.json({ error: "Workflow not found" }, 404);
  await audit(c.env.DB, c.get("actor"), enabled ? "workflow.enabled" : "workflow.disabled", "workflow", id);
  return c.json({ id, enabled });
});

app.put("/api/policies", async (c) => {
  const { policies } = z.object({
    policies: z.array(z.object({ operation: z.string().min(1).max(100), mode: policyModeSchema }).strict()).min(1).max(50),
  }).strict().parse(await c.req.json());
  const uniqueOperations = new Set(policies.map((policy) => policy.operation));
  if (uniqueOperations.size !== policies.length) return c.json({ error: "Duplicate policy operation" }, 400);
  const known = await c.env.DB.prepare("SELECT operation_kind FROM operation_policies").all<{ operation_kind: string }>();
  const knownOperations = new Set(known.results.map((policy) => policy.operation_kind));
  if (policies.some((policy) => !knownOperations.has(policy.operation))) return c.json({ error: "Unknown operation" }, 400);

  await c.env.DB.batch(policies.flatMap((policy) => [
    c.env.DB.prepare("UPDATE operation_policies SET mode = ?, updated_at = CURRENT_TIMESTAMP WHERE operation_kind = ?").bind(policy.mode, policy.operation),
    c.env.DB.prepare("INSERT INTO audit_records (actor, action, resource_type, resource_id, detail) VALUES (?, 'policy.updated', 'operation', ?, ?)")
      .bind(c.get("actor"), policy.operation, JSON.stringify({ mode: policy.mode })),
  ]));
  return c.json({ policies });
});

app.put("/api/policies/:operation", async (c) => {
  const operation = c.req.param("operation");
  const { mode } = z.object({ mode: policyModeSchema }).parse(await c.req.json());
  const result = await c.env.DB
    .prepare("UPDATE operation_policies SET mode = ?, updated_at = CURRENT_TIMESTAMP WHERE operation_kind = ?")
    .bind(mode, operation)
    .run();
  if ((result.meta.changes ?? 0) === 0) return c.json({ error: "Unknown operation" }, 404);
  await audit(c.env.DB, c.get("actor"), "policy.updated", "operation", operation, { mode });
  return c.json({ operation, mode });
});

app.post("/api/approvals/:id/reject", async (c) => {
  const id = c.req.param("id");
  const result = await c.env.DB
    .prepare("UPDATE proposals SET status = 'rejected', decided_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'pending'")
    .bind(id)
    .run();
  if ((result.meta.changes ?? 0) === 0) return c.json({ error: "Proposal is not pending" }, 409);
  await audit(c.env.DB, c.get("actor"), "proposal.rejected", "proposal", id);
  return c.json({ id, status: "rejected" });
});

app.post("/api/approvals/:id/approve", async (c) => {
  const id = c.req.param("id");
  const row = await c.env.DB
    .prepare("SELECT p.operation, p.run_id, r.event_id, e.repository_id FROM proposals p JOIN runs r ON r.id = p.run_id JOIN events e ON e.id = r.event_id WHERE p.id = ? AND p.status = 'pending'")
    .bind(id)
    .first<{ operation: string; run_id: string; event_id: string; repository_id: string }>();
  if (!row) return c.json({ error: "Proposal is not pending" }, 409);
  const initiallyPausedBy = await pauseScope(c.env.DB, row.repository_id);
  if (initiallyPausedBy) {
    return c.json({ error: initiallyPausedBy === "global" ? "Gardener is paused; resume before executing an approval" : "This repository is paused; resume it before executing an approval" }, 409);
  }

  const claimed = await c.env.DB
    .prepare("UPDATE proposals SET status = 'executing', decided_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'pending'")
    .bind(id)
    .run();
  if ((claimed.meta.changes ?? 0) === 0) return c.json({ error: "Proposal is not pending" }, 409);

  try {
    const operation = operationSchema.parse(JSON.parse(row.operation));
    const pausedBy = await pauseScope(c.env.DB, row.repository_id);
    if (pausedBy) {
      await c.env.DB
        .prepare("UPDATE proposals SET status = 'pending', decided_at = NULL WHERE id = ? AND status = 'executing'")
        .bind(id)
        .run();
      return c.json({ error: pausedBy === "global" ? "Gardener was paused before execution" : "Repository was paused before execution" }, 409);
    }
    const receipt = await executeThroughConnect(c.env, row.run_id, row.event_id, operation);
    await c.env.DB
      .prepare("UPDATE proposals SET status = 'executed', receipt = ?, error = NULL WHERE id = ?")
      .bind(JSON.stringify(receipt), id)
      .run();
    await audit(c.env.DB, c.get("actor"), "proposal.executed", "proposal", id, { operationId: operation.id });
    return c.json({ id, status: "executed", receipt });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Execution failed";
    await c.env.DB.prepare("UPDATE proposals SET status = 'failed', error = ? WHERE id = ?").bind(message, id).run();
    await audit(c.env.DB, c.get("actor"), "proposal.failed", "proposal", id, { error: message });
    return c.json({ error: message }, 502);
  }
});

app.notFound((c) => c.env.ASSETS.fetch(c.req.raw));

interface RunRow {
  id: string;
  status: string;
  policy_snapshot: string;
  envelope: string;
  instructions: string;
  attempt_count: number;
  repository_id: string;
}

async function processRun(env: Env, runId: string): Promise<void> {
  const row = await env.DB
    .prepare(
      "SELECT r.id, r.status, r.policy_snapshot, r.attempt_count, e.envelope, e.repository_id, w.instructions FROM runs r " +
        "JOIN events e ON e.id = r.event_id JOIN workflows w ON w.id = r.workflow_id WHERE r.id = ?",
    )
    .bind(runId)
    .first<RunRow>();
  if (!row || row.status !== "queued") return;

  const pausedBy = await pauseScope(env.DB, row.repository_id);
  if (pausedBy) {
    const message = pausedBy === "global" ? "Gardener paused" : "Repository paused";
    await env.DB
      .prepare("UPDATE runs SET status = 'cancelled', error = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'queued'")
      .bind(message, runId)
      .run();
    return;
  }

  const claimed = await env.DB
    .prepare(
      "UPDATE runs SET status = 'running', attempt_count = attempt_count + 1, started_at = COALESCE(started_at, CURRENT_TIMESTAMP), error = NULL " +
        "WHERE id = ? AND status = 'queued'",
    )
    .bind(runId)
    .run();
  if ((claimed.meta.changes ?? 0) === 0) return;

  try {
    const event = JSON.parse(row.envelope) as ConnectEvent;
    if (event.kind !== "github.issue") throw new Error(`No runtime is configured for ${event.kind}`);
    const result = await runIssueGardener({
      ai: env.AI,
      model: env.AI_MODEL,
      runId,
      event,
      instructions: row.instructions,
    });
    const policies = JSON.parse(row.policy_snapshot) as Record<string, PolicyMode>;
    let executionErrors = 0;

    for (const proposal of result.proposals) {
      const operation = operationSchema.parse(proposal.operation);
      const mode = policies[operation.kind] ?? "disabled";
      const status = mode === "automatic" ? "executing" : mode === "approval" ? "pending" : "disabled";
      const proposalId = crypto.randomUUID();
      const inserted = await env.DB
        .prepare(
          "INSERT OR IGNORE INTO proposals " +
            "(id, operation_id, run_id, operation_kind, operation, policy_mode, status, rationale) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(proposalId, operation.id, runId, operation.kind, JSON.stringify(operation), mode, status, proposal.rationale)
        .run();
      if ((inserted.meta.changes ?? 0) > 0) {
        await audit(env.DB, "agent", "proposal.created", "proposal", proposalId, {
          operationId: operation.id,
          operationKind: operation.kind,
          policyMode: mode,
        });
      }

      if (mode === "automatic") {
        const pausedBeforeExecution = await pauseScope(env.DB, event.repository.id);
        if (pausedBeforeExecution) {
          executionErrors += 1;
          const message = pausedBeforeExecution === "global" ? "Gardener paused before automatic execution" : "Repository paused before automatic execution";
          await env.DB
            .prepare("UPDATE proposals SET status = 'failed', error = ?, decided_at = CURRENT_TIMESTAMP WHERE operation_id = ?")
            .bind(message, operation.id)
            .run();
          await audit(env.DB, "system", "proposal.failed", "proposal", proposalId, { error: message });
          continue;
        }
        try {
          const receipt = await executeThroughConnect(env, runId, event.id, operation);
          await env.DB
            .prepare("UPDATE proposals SET status = 'executed', receipt = ?, error = NULL, decided_at = CURRENT_TIMESTAMP WHERE operation_id = ?")
            .bind(JSON.stringify(receipt), operation.id)
            .run();
          await audit(env.DB, "agent", "proposal.executed", "proposal", proposalId, { operationId: operation.id });
        } catch (error) {
          executionErrors += 1;
          const message = error instanceof Error ? error.message : "Execution failed";
          await env.DB
            .prepare("UPDATE proposals SET status = 'failed', error = ?, decided_at = CURRENT_TIMESTAMP WHERE operation_id = ?")
            .bind(message, operation.id)
            .run();
          await audit(env.DB, "agent", "proposal.failed", "proposal", proposalId, { error: message });
        }
      }
    }

    await env.DB
      .prepare(
        "UPDATE runs SET status = ?, summary = ?, evidence = ?, usage = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?",
      )
      .bind(
        executionErrors ? "completed_with_errors" : "completed",
        result.summary,
        JSON.stringify(result.evidence),
        JSON.stringify(result.usage),
        runId,
      )
      .run();
    await audit(env.DB, "agent", "run.completed", "run", runId, {
      proposals: result.proposals.length,
      executionErrors,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Run failed";
    const attempt = row.attempt_count + 1;
    const final = attempt >= 3;
    await env.DB.prepare(
      "UPDATE runs SET status = ?, error = ?, completed_at = CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE NULL END WHERE id = ?",
    ).bind(final ? "failed" : "queued", message, final ? 1 : 0, runId).run();
    await audit(env.DB, "agent", final ? "run.failed" : "run.retrying", "run", runId, { error: message, attempt });
    if (!final) throw error;
  }
}

export { app, processRun };

export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch<RunQueueMessage>, env: Env): Promise<void> {
    await ensureDatabase(env.DB);
    for (const message of batch.messages) {
      try {
        await processRun(env, message.body.runId);
        message.ack();
      } catch {
        message.retry();
      }
    }
  },
} satisfies ExportedHandler<Env, RunQueueMessage>;
