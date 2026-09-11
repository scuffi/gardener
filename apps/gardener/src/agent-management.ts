import {
  agentProvenanceV1Schema,
  agentSourceV1Schema,
  capabilityCatalog,
  compiledAgentRevisionV1Schema,
  observationCapabilityValues,
  operationKindSchema,
  repositoryEventV2Schema,
  workspaceCapabilityValues,
  type AgentProvenanceV1,
  type AgentSourceV1,
  type AuthoringPrincipal,
  type CompiledAgentRevisionV1,
  type RepositoryRef,
} from "@gardener/contracts";
import {
  canonicalJson,
  canonicalSha256,
  agentSourceText,
  compileAgentRevision,
  createAgentSource,
  diffAgentRevisions,
  parseAgentSource,
  validateAgentSource,
} from "@gardener/core";
import { Hono, type Context } from "hono";
import { getCookie } from "hono/cookie";
import { z } from "zod";
import { audit } from "./instance-state";
import type { Env } from "./env";
import {
  activateAgentRevision,
  createAgent,
  getAgent,
  getAgentDraft,
  getAgentRevision,
  listAgents,
  listOpenInbox,
  publishAgentDraft,
  resolveInboxItem,
  saveAgentDraft,
  setAgentEnabled,
} from "./persistence";
import type {
  AgentAuthoringService,
  GardenerMcpPrincipal,
  GardenerMcpServices,
  JsonObject,
  PausedDraftReceipt,
  RunTraceService,
} from "./mcp/services";
import type {
  CatalogInput,
  DiffInput,
  ExplainInput,
  GetAgentInput,
  GetRunTraceInput,
  ListAgentsInput,
  PublishDraftInput,
  SimulateInput,
  ValidateInput,
} from "./mcp/schemas";

export const AGENT_COMPILER_VERSION = "gardener-agent-compiler/1";
export const CAPABILITY_CATALOG_VERSION = "gardener-capabilities/1";
export const AGENT_RUNTIME_VERSION = "gardener-agent-runtime/1";

interface AgentBindings {
  Bindings: Env;
  Variables: { actor: string; actorLogin: string; identityToken: string };
}

const sourceRequestSchema = z.union([
  z.object({ source: agentSourceV1Schema }).strict(),
  z.object({
    sourceMd: z.string().min(1).max(262_144),
    agentId: z.string().optional(),
    thisRepositoryId: z.string().regex(/^[1-9][0-9]{0,31}$/).optional(),
  }).strict(),
]);
const createAgentRequestSchema = z.object({
  id: z.string().regex(/^[a-z0-9](?:[a-z0-9._-]{0,253}[a-z0-9])?$/).optional(),
  slug: z.string().regex(/^[a-z0-9](?:[a-z0-9._-]{0,98}[a-z0-9])?$/),
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(1_000).default(""),
}).strict();
const saveDraftRequestSchema = z.object({
  draftId: z.string().regex(/^[a-z0-9](?:[a-z0-9._-]{0,253}[a-z0-9])?$/).optional(),
  source: agentSourceV1Schema,
}).strict();
const reasonSchema = z.object({ reason: z.string().trim().max(1_000).nullable().default(null) }).strict();
const enableSchema = z.object({ enabled: z.boolean(), reason: z.string().trim().max(1_000).nullable().default(null) }).strict();
const dashboardSourceSchema = z.object({
  sourceMd: z.string().min(1).max(262_144),
  thisRepositoryId: z.string().regex(/^[1-9][0-9]{0,31}$/).optional(),
}).strict();
const inboxResponseSchema = z.object({ action: z.enum(["approve", "reject", "dismiss"]) }).strict();

function publicId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function authoringPrincipal(actor: string, displayName: string): AuthoringPrincipal {
  return { provider: "gardener", principal: { kind: "owner", id: actor, displayName } };
}

function provenance(
  source: AgentProvenanceV1["source"],
  principal: AuthoringPrincipal,
  authoredAt: string,
  publishedAt = authoredAt,
  thisRepositoryId?: string,
): AgentProvenanceV1 {
  return {
    source, authoredBy: principal, publishedBy: principal, authoredAt, publishedAt,
    ...(thisRepositoryId ? { repositoryContext: { repositoryId: thisRepositoryId } } : {}),
  };
}

async function repositories(db: D1Database): Promise<RepositoryRef[]> {
  const { results } = await db.prepare(
    "SELECT id, installation_id, owner, name, default_branch FROM repositories WHERE active = 1 ORDER BY id",
  ).all<{ id: string; installation_id: string; owner: string; name: string; default_branch: string | null }>();
  return results.flatMap((row) => {
    const parsed = z.object({
      provider: z.literal("github"),
      id: z.string().regex(/^[1-9][0-9]{0,31}$/),
      installationId: z.string().regex(/^[1-9][0-9]{0,31}$/),
      owner: z.string(), name: z.string(), defaultBranch: z.string().min(1),
    }).safeParse({ provider: "github", id: row.id, installationId: row.installation_id, owner: row.owner, name: row.name, defaultBranch: row.default_branch });
    return parsed.success ? [parsed.data] : [];
  });
}

function storedSource(value: string): AgentSourceV1 {
  return agentSourceV1Schema.parse(JSON.parse(value));
}

function dashboardSource(value: string): AgentSourceV1 {
  return createAgentSource(value);
}

function slugFromName(name: string): string {
  const normalized = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 72);
  return normalized || "agent";
}

async function latestEditingDraft(db: D1Database, agentId: string) {
  const row = await db.prepare(
    "SELECT id FROM agent_drafts WHERE agent_id = ? AND status = 'editing' ORDER BY updated_at DESC, id DESC LIMIT 1",
  ).bind(agentId).first<{ id: string }>();
  return row ? getAgentDraft(db, row.id) : null;
}

async function revisionByNumber(db: D1Database, agentId: string, revision: number) {
  const row = await db.prepare("SELECT id FROM agent_revisions WHERE agent_id = ? AND revision = ?")
    .bind(agentId, revision).first<{ id: string }>();
  return row ? getAgentRevision(db, row.id) : null;
}

async function saveDraft(
  db: D1Database,
  input: {
    draftId: string; agentId: string; source: AgentSourceV1; actor: string; actorLogin: string;
    sourceKind: AgentProvenanceV1["source"]; thisRepositoryId?: string;
    expectedVersion?: number; idempotencyKeyHash?: string | null;
  },
) {
  const validation = validateAgentSource(input.source);
  if (!validation.valid || !validation.spec) throw new Error(validation.issues.map((issue) => issue.message).join("; ") || "Invalid Agent source");
  const sourceHash = await canonicalSha256(input.source);
  const now = new Date().toISOString();
  return saveAgentDraft(db, {
    id: input.draftId,
    agentId: input.agentId,
    sourceMd: canonicalJson(input.source),
    sourceHash,
    parsed: validation.spec,
    validation,
    provenance: provenance(
      input.sourceKind,
      authoringPrincipal(input.actor, input.actorLogin),
      now,
      now,
      validation.spec.repositories.includes("this") ? input.thisRepositoryId : undefined,
    ),
    compilerVersion: AGENT_COMPILER_VERSION,
    catalogVersion: CAPABILITY_CATALOG_VERSION,
    runtimeVersion: AGENT_RUNTIME_VERSION,
    actorId: input.actor,
    ...(input.expectedVersion === undefined ? {} : { expectedVersion: input.expectedVersion }),
    ...(input.idempotencyKeyHash === undefined ? {} : { idempotencyKeyHash: input.idempotencyKeyHash }),
  });
}

async function compileDraft(db: D1Database, agentId: string, draftId: string, actor: string, actorLogin: string) {
  const [agent, draft, available] = await Promise.all([getAgent(db, agentId), getAgentDraft(db, draftId), repositories(db)]);
  if (!agent || !draft || draft.agentId !== agentId || draft.status !== "editing") throw new Error("Editing Agent draft not found");
  const revision = agent.revisionCounter + 1;
  const now = new Date().toISOString();
  const draftProvenance = agentProvenanceV1Schema.parse(draft.provenance);
  const thisRepositoryId = draftProvenance.repositoryContext?.repositoryId;
  const publishedProvenance = agentProvenanceV1Schema.parse({
    ...draftProvenance,
    publishedBy: authoringPrincipal(actor, actorLogin),
    publishedAt: now,
  });
  const compiled = await compileAgentRevision(storedSource(draft.sourceMd), {
    agentId,
    revision,
    revisionId: publicId("revision"),
    provenance: publishedProvenance,
    repositories: available,
    ...(thisRepositoryId ? { thisRepositoryId } : available.length === 1 ? { thisRepositoryId: available[0]!.id } : {}),
    compilerVersion: AGENT_COMPILER_VERSION,
    capabilityCatalogVersion: CAPABILITY_CATALOG_VERSION,
    runtimeVersion: AGENT_RUNTIME_VERSION,
    now: () => new Date(now),
  });
  return { agent, draft, revisionNumber: revision, publishedProvenance, ...compiled };
}

function requireOwnerDashboard(c: Context<AgentBindings>): Response | null {
  if (c.env.LOCAL_DEV_BYPASS === "true") return null;
  if (c.req.header("authorization") || !getCookie(c, "gardener_session")) {
    return c.json({ error: "This action requires an authenticated owner dashboard session" }, 403);
  }
  return null;
}

export const agentManagement = new Hono<AgentBindings>();

agentManagement.get("/agents", async (c) => {
  const agents = await listAgents(c.env.DB);
  const summaries = await Promise.all(agents.map(async (agent) => {
    const draft = await latestEditingDraft(c.env.DB, agent.id);
    return {
      id: agent.id,
      slug: agent.slug,
      name: agent.name,
      description: agent.description,
      enabled: agent.enabled,
      lifecycle: agent.enabled ? "active" : agent.activeRevisionId ? "paused" : "draft",
      activeRevision: agent.activeRevisionId
        ? (await getAgentRevision(c.env.DB, agent.activeRevisionId))?.revision ?? null
        : null,
      latestRevision: agent.revisionCounter || null,
      hasDraft: draft !== null,
      updatedAt: agent.updatedAt,
    };
  }));
  return c.json({ agents: summaries });
});
agentManagement.post("/agents", async (c) => {
  const body = await c.req.json();
  if (typeof body === "object" && body !== null && "sourceMd" in body) {
    const { sourceMd, thisRepositoryId } = dashboardSourceSchema.parse(body);
    const source = dashboardSource(sourceMd);
    const spec = parseAgentSource(source);
    const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 10);
    const agent = await createAgent(c.env.DB, {
      id: publicId("agent"),
      slug: `${slugFromName(spec.name).slice(0, 88)}-${suffix}`,
      name: spec.name,
      description: spec.description,
      createdBy: c.get("actor"),
    });
    const draft = await saveDraft(c.env.DB, {
      draftId: publicId("draft"), agentId: agent.id, source,
      actor: c.get("actor"), actorLogin: c.get("actorLogin"), sourceKind: "dashboard",
      ...(thisRepositoryId ? { thisRepositoryId } : {}),
    });
    await audit(c.env.DB, c.get("actor"), "agent.created", "agent", agent.id, { slug: agent.slug, draftId: draft.id });
    return c.json({ agent: { ...agent, lifecycle: "draft", activeRevision: null, latestRevision: null, hasDraft: true, updatedAt: agent.updatedAt }, draftId: draft.id }, 201);
  }
  const input = createAgentRequestSchema.parse(body);
  const agent = await createAgent(c.env.DB, {
    id: input.id ?? publicId("agent"), slug: input.slug, name: input.name,
    description: input.description, createdBy: c.get("actor"),
  });
  await audit(c.env.DB, c.get("actor"), "agent.created", "agent", agent.id, { slug: agent.slug });
  return c.json({ agent }, 201);
});
agentManagement.get("/agents/:id", async (c) => {
  const agent = await getAgent(c.env.DB, c.req.param("id"));
  if (!agent) return c.json({ error: "Agent not found" }, 404);
  const [rows, draft] = await Promise.all([
    c.env.DB.prepare(
      "SELECT id, revision, source_md, source_hash, compiled_hash, provenance_json, published_at, published_by FROM agent_revisions WHERE agent_id = ? ORDER BY revision DESC",
    ).bind(agent.id).all<{ id: string; revision: number; source_md: string; source_hash: string; compiled_hash: string; provenance_json: string; published_at: string; published_by: string }>(),
    latestEditingDraft(c.env.DB, agent.id),
  ]);
  const active = agent.activeRevisionId;
  return c.json({
    agent: {
      id: agent.id, slug: agent.slug, name: agent.name, description: agent.description, enabled: agent.enabled,
      lifecycle: agent.enabled ? "active" : active ? "paused" : "draft",
      activeRevision: active ? rows.results.find((row) => row.id === active)?.revision ?? null : null,
      latestRevision: agent.revisionCounter || null, hasDraft: draft !== null, updatedAt: agent.updatedAt,
    },
    draft: draft ? {
      id: draft.id, sourceMd: agentSourceText(storedSource(draft.sourceMd)), sourceHash: draft.sourceHash, updatedAt: draft.updatedAt,
      thisRepositoryId: agentProvenanceV1Schema.parse(draft.provenance).repositoryContext?.repositoryId,
    } : null,
    sourceMd: draft ? undefined : rows.results[0] ? agentSourceText(storedSource(rows.results[0].source_md)) : undefined,
    thisRepositoryId: draft
      ? agentProvenanceV1Schema.parse(draft.provenance).repositoryContext?.repositoryId
      : rows.results[0] ? agentProvenanceV1Schema.parse(JSON.parse(rows.results[0].provenance_json)).repositoryContext?.repositoryId : undefined,
    revisions: rows.results.map((row) => ({ id: row.id, revision: row.revision, sourceHash: row.source_hash, compiledHash: row.compiled_hash, publishedAt: row.published_at, publishedBy: row.published_by, active: row.id === active })),
  });
});
agentManagement.post("/agents/validate", async (c) => {
  const input = sourceRequestSchema.parse(await c.req.json());
  const source = "source" in input ? input.source : dashboardSource(input.sourceMd);
  const validation = validateAgentSource(source);
  const available = await repositories(c.env.DB);
  const availableIds = new Set(available.map((repository) => repository.id));
  const requested = validation.spec?.repositories ?? [];
  const requestedContext = "thisRepositoryId" in input ? input.thisRepositoryId : undefined;
  const effectiveContext = requestedContext ?? (available.length === 1 ? available[0]!.id : undefined);
  const repositoryDiagnostics: Array<{ code: string; path: string; message: string; severity: "error" }> = [];
  if (requested.includes("this") && !effectiveContext) repositoryDiagnostics.push({ code: "missing_repository_context", path: "repositories", message: "Choose which active repository 'this' identifies", severity: "error" });
  if (effectiveContext && !availableIds.has(effectiveContext)) repositoryDiagnostics.push({ code: "inactive_repository_context", path: "repositories", message: "The selected repository is not active in this Gardener instance", severity: "error" });
  for (const reference of requested) {
    if (reference !== "this" && !availableIds.has(reference)) repositoryDiagnostics.push({ code: "unavailable_repository", path: "repositories", message: `Repository ${reference} is not active in this Gardener instance`, severity: "error" });
  }
  const diagnostics = [
    ...validation.issues.map((issue) => ({ code: "invalid_agent_source", path: String(issue.path), message: issue.message, severity: "error" as const })),
    ...repositoryDiagnostics,
  ];
  const publishable = validation.valid && diagnostics.length === 0;
  return c.json({
    ...validation,
    diagnostics,
    capabilities: validation.spec?.requestedCapabilities,
    publishable,
    sourceHash: await canonicalSha256(source),
    activatable: publishable,
  });
});
agentManagement.post("/agents/:id/drafts", async (c) => {
  const agent = await getAgent(c.env.DB, c.req.param("id"));
  if (!agent) return c.json({ error: "Agent not found" }, 404);
  const input = saveDraftRequestSchema.parse(await c.req.json());
  const draft = await saveDraft(c.env.DB, {
    draftId: input.draftId ?? publicId("draft"), agentId: agent.id, source: input.source,
    actor: c.get("actor"), actorLogin: c.get("actorLogin"), sourceKind: "dashboard",
  });
  await audit(c.env.DB, c.get("actor"), "agent.draft.saved", "agent_draft", draft.id, { agentId: agent.id, sourceHash: draft.sourceHash });
  return c.json({ draft }, 201);
});
agentManagement.get("/agents/:id/drafts/:draftId", async (c) => {
  const draft = await getAgentDraft(c.env.DB, c.req.param("draftId"));
  if (!draft || draft.agentId !== c.req.param("id")) return c.json({ error: "Draft not found" }, 404);
  return c.json({ draft: { ...draft, source: storedSource(draft.sourceMd), sourceMd: undefined } });
});
agentManagement.post("/agents/:id/drafts/:draftId/simulate", async (c) => {
  const draft = await getAgentDraft(c.env.DB, c.req.param("draftId"));
  if (!draft || draft.agentId !== c.req.param("id")) return c.json({ error: "Draft not found" }, 404);
  return c.json({ mode: "validate-only", executed: false, persistentEffects: false, validation: draft.validation, blockedReason: "Simulation is validation-only; live execution is limited to the bounded issue-comment runtime" });
});
agentManagement.post("/agents/:id/drafts/:draftId/publish", async (c) => {
  const denied = requireOwnerDashboard(c); if (denied) return denied;
  const built = await compileDraft(c.env.DB, c.req.param("id"), c.req.param("draftId"), c.get("actor"), c.get("actorLogin"));
  const revision = await publishAgentDraft(c.env.DB, {
    revisionId: built.revision.revisionId,
    revision: built.revisionNumber,
    draftId: built.draft.id,
    parsedHash: await canonicalSha256(built.revision.spec),
    compiled: built.compiled,
    compiledHash: await canonicalSha256(built.compiled),
    provenance: built.publishedProvenance,
    provenanceHash: await canonicalSha256(built.publishedProvenance),
    publishedBy: c.get("actor"),
  });
  await audit(c.env.DB, c.get("actor"), "agent.revision.published_paused", "agent_revision", revision.id, { agentId: revision.agentId, revision: revision.revision });
  return c.json({ revision, active: false, enabled: false }, 201);
});
agentManagement.post("/agents/:id/revisions/:revisionId/activate", async (c) => {
  const denied = requireOwnerDashboard(c); if (denied) return denied;
  const input = reasonSchema.parse(await c.req.json().catch(() => ({})));
  const requested = c.req.param("revisionId");
  const revision = /^\d+$/.test(requested)
    ? await revisionByNumber(c.env.DB, c.req.param("id"), Number(requested))
    : await getAgentRevision(c.env.DB, requested);
  if (!revision || revision.agentId !== c.req.param("id")) return c.json({ error: "Revision not found" }, 404);
  const compiled = compiledAgentRevisionV1Schema.parse(revision.compiled);
  const activeRepositoryIds = new Set((await repositories(c.env.DB)).map((repository) => repository.id));
  if (compiled.repositories.some((repository) => !activeRepositoryIds.has(repository.id))) return c.json({ error: "Revision contains an inactive repository" }, 409);
  const agent = await activateAgentRevision(c.env.DB, { historyId: publicId("activation"), agentId: revision.agentId, revisionId: revision.id, actorId: c.get("actor"), reason: input.reason });
  await audit(c.env.DB, c.get("actor"), "agent.revision.activated", "agent_revision", revision.id, { agentId: agent.id });
  return c.json({ activated: true, agent });
});
agentManagement.post("/agents/:id/enable", async (c) => {
  const denied = requireOwnerDashboard(c); if (denied) return denied;
  const input = enableSchema.parse(await c.req.json());
  const current = await getAgent(c.env.DB, c.req.param("id"));
  if (!current) return c.json({ error: "Agent not found" }, 404);
  if (input.enabled && !current.activeRevisionId) return c.json({ error: "Activate an immutable revision before enabling this Agent" }, 409);
  const agent = await setAgentEnabled(c.env.DB, { historyId: publicId("enablement"), agentId: current.id, enabled: input.enabled, actorId: c.get("actor"), reason: input.reason });
  await audit(c.env.DB, c.get("actor"), input.enabled ? "agent.enabled" : "agent.disabled", "agent", agent.id);
  return c.json({ agent });
});
agentManagement.put("/agents/:id/draft", async (c) => {
  const agent = await getAgent(c.env.DB, c.req.param("id"));
  if (!agent) return c.json({ error: "Agent not found" }, 404);
  const { sourceMd, thisRepositoryId } = dashboardSourceSchema.parse(await c.req.json());
  const existing = await latestEditingDraft(c.env.DB, agent.id);
  const draft = await saveDraft(c.env.DB, {
    draftId: existing?.id ?? publicId("draft"), agentId: agent.id, source: dashboardSource(sourceMd),
    actor: c.get("actor"), actorLogin: c.get("actorLogin"), sourceKind: "dashboard",
    ...(thisRepositoryId ? { thisRepositoryId } : {}),
  });
  await audit(c.env.DB, c.get("actor"), "agent.draft.saved", "agent_draft", draft.id, { agentId: agent.id, sourceHash: draft.sourceHash });
  return c.json({ draftId: draft.id, sourceHash: draft.sourceHash });
});
agentManagement.post("/agents/simulate", async (c) => {
  const input = sourceRequestSchema.parse(await c.req.json());
  const source = "source" in input ? input.source : dashboardSource(input.sourceMd);
  const validation = validateAgentSource(source);
  return c.json({
    status: validation.valid ? "blocked" : "failed",
    summary: validation.valid
      ? "Source is valid. Simulation is validation-only and cannot invoke the bounded live runtime or persistent effects."
      : "Source validation failed; no simulation or persistent effect was executed.",
    diagnostics: validation.issues.map((issue) => ({ code: "invalid_agent_source", path: issue.path, message: issue.message, severity: "error" as const })),
    proposedEffects: [], executed: false,
  });
});
agentManagement.post("/agents/:id/revisions", async (c) => {
  const denied = requireOwnerDashboard(c); if (denied) return denied;
  const agent = await getAgent(c.env.DB, c.req.param("id"));
  if (!agent) return c.json({ error: "Agent not found" }, 404);
  const { sourceMd, thisRepositoryId } = dashboardSourceSchema.parse(await c.req.json());
  const existing = await latestEditingDraft(c.env.DB, agent.id);
  const draft = await saveDraft(c.env.DB, {
    draftId: existing?.id ?? publicId("draft"), agentId: agent.id, source: dashboardSource(sourceMd),
    actor: c.get("actor"), actorLogin: c.get("actorLogin"), sourceKind: "dashboard",
    ...(thisRepositoryId ? { thisRepositoryId } : {}),
  });
  const built = await compileDraft(c.env.DB, agent.id, draft.id, c.get("actor"), c.get("actorLogin"));
  const revision = await publishAgentDraft(c.env.DB, {
    revisionId: built.revision.revisionId, revision: built.revisionNumber, draftId: built.draft.id,
    parsedHash: await canonicalSha256(built.revision.spec), compiled: built.compiled,
    compiledHash: await canonicalSha256(built.compiled), provenance: built.publishedProvenance,
    provenanceHash: await canonicalSha256(built.publishedProvenance), publishedBy: c.get("actor"),
  });
  await audit(c.env.DB, c.get("actor"), "agent.revision.published_paused", "agent_revision", revision.id, { agentId: agent.id, revision: revision.revision });
  return c.json({ revision: revision.revision, paused: true as const }, 201);
});
agentManagement.get("/agents/:id/revisions/:revision", async (c) => {
  const number = z.coerce.number().int().positive().safeParse(c.req.param("revision"));
  if (!number.success) return c.json({ error: "Revision not found" }, 404);
  const revision = await revisionByNumber(c.env.DB, c.req.param("id"), number.data);
  if (!revision) return c.json({ error: "Revision not found" }, 404);
  return c.json({ revision: revision.revision, sourceMd: agentSourceText(storedSource(revision.sourceMd)), sourceHash: revision.sourceHash, compiledHash: revision.compiledHash });
});
agentManagement.post("/agents/:id/status", async (c) => {
  const denied = requireOwnerDashboard(c); if (denied) return denied;
  const input = enableSchema.parse(await c.req.json());
  const current = await getAgent(c.env.DB, c.req.param("id"));
  if (!current) return c.json({ error: "Agent not found" }, 404);
  if (input.enabled && !current.activeRevisionId) return c.json({ error: "Activate an immutable revision before enabling this Agent" }, 409);
  const agent = await setAgentEnabled(c.env.DB, { historyId: publicId("enablement"), agentId: current.id, enabled: input.enabled, actorId: c.get("actor"), reason: input.reason });
  await audit(c.env.DB, c.get("actor"), input.enabled ? "agent.enabled" : "agent.disabled", "agent", agent.id);
  return c.json({ enabled: agent.enabled });
});
agentManagement.get("/inbox", async (c) => c.json({ items: await listOpenInbox(c.env.DB) }));
agentManagement.post("/inbox/:id/respond", async (c) => {
  const denied = requireOwnerDashboard(c); if (denied) return denied;
  const { action } = inboxResponseSchema.parse(await c.req.json());
  if (action !== "dismiss") return c.json({ error: "Typed interruption or exact-effect decision endpoint required" }, 409);
  const changed = await resolveInboxItem(c.env.DB, c.req.param("id"), "dismissed");
  if (!changed) return c.json({ error: "Open Inbox item not found" }, 404);
  const item = { id: c.req.param("id"), status: "dismissed" as const };
  await audit(c.env.DB, c.get("actor"), "inbox.dismissed", "inbox_item", item.id);
  return c.json({ item });
});
agentManagement.get("/history", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT id, actor, action, resource_type, resource_id, detail_json, created_at FROM audit_records ORDER BY created_at DESC LIMIT 100",
  ).all<{ id: number; actor: string; action: string; resource_type: string; resource_id: string; detail_json: string | null; created_at: string }>();
  return c.json({ items: results.map((row) => ({
    id: String(row.id), kind: row.resource_type === "agent_revision" ? "revision" : row.resource_type === "agent" ? "agent" : "decision",
    title: row.action, summary: row.detail_json ?? undefined, actor: row.actor, agentId: row.resource_type.startsWith("agent") ? row.resource_id : undefined,
    createdAt: row.created_at,
  })) });
});

function sourceFromMcp(input: { source: string; supportingFiles?: readonly { path: string; content: string }[] }): AgentSourceV1 {
  return createAgentSource(input.source, (input.supportingFiles ?? []).map((file) => ({
    path: file.path,
    mediaType: /\.json$/i.test(file.path) ? "application/json" : /\.ya?ml$/i.test(file.path) ? "application/yaml" : "text/markdown",
    bytesBase64: bytesBase64(new TextEncoder().encode(file.content)),
  })));
}

function bytesBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function mcpPrincipal(principal: GardenerMcpPrincipal): { actor: string; actorLogin: string } {
  return { actor: `oauth:${principal.owner.githubUserId}`, actorLogin: principal.owner.githubLogin };
}

class D1AgentAuthoringService implements AgentAuthoringService {
  constructor(private readonly db: D1Database) {}
  async list(input: ListAgentsInput): Promise<{ agents: Array<{ id: string; name: string; lifecycle: string }>; nextCursor: string | null }> {
    const agents = (await listAgents(this.db)).filter((agent) => !input.cursor || agent.id > input.cursor).slice(0, input.limit);
    return { agents: agents.map((agent) => ({ id: agent.id, name: agent.name, lifecycle: agent.enabled ? "enabled" : agent.activeRevisionId ? "active_paused" : "draft" })), nextCursor: agents.length === input.limit ? agents.at(-1)!.id : null };
  }
  async get(input: GetAgentInput): Promise<JsonObject> {
    const agent = await getAgent(this.db, input.agentId);
    if (!agent) throw new Error("Agent not found");
    const revision = input.revisionId ? await getAgentRevision(this.db, input.revisionId) : null;
    if (revision && revision.agentId !== agent.id) throw new Error("Revision not found");
    return JSON.parse(JSON.stringify({ agent, revision: revision ? { ...revision, sourceMd: undefined, ...(input.includeSource ? { source: storedSource(revision.sourceMd) } : {}) } : null })) as JsonObject;
  }
  async catalog(input: CatalogInput): Promise<JsonObject> {
    const entries = capabilityCatalog.filter((entry) => !input.query || entry.id.includes(input.query)).slice(0, input.limit);
    return { version: CAPABILITY_CATALOG_VERSION, capabilities: entries as unknown as JsonObject["capabilities"], harnesses: ["flue"] } as JsonObject;
  }
  async validate(input: ValidateInput): Promise<JsonObject> {
    const source = sourceFromMcp(input); const validation = validateAgentSource(source);
    return JSON.parse(JSON.stringify({ ...validation, sourceHash: await canonicalSha256(source) })) as JsonObject;
  }
  async explain(input: ExplainInput): Promise<JsonObject> {
    if (input.source) {
      const spec = parseAgentSource(createAgentSource(input.source));
      return JSON.parse(JSON.stringify({ spec, authorityGranted: false })) as JsonObject;
    }
    const agent = await getAgent(this.db, input.agentId!); if (!agent) throw new Error("Agent not found");
    const revisionId = input.revisionId ?? agent.activeRevisionId; if (!revisionId) return { agentId: agent.id, activeRevisionId: null, authorityGranted: false };
    const revision = await getAgentRevision(this.db, revisionId); if (!revision || revision.agentId !== agent.id) throw new Error("Revision not found");
    return JSON.parse(JSON.stringify({ agentId: agent.id, revisionId, spec: revision.parsed, authorityGranted: false })) as JsonObject;
  }
  async diff(input: DiffInput): Promise<JsonObject> {
    const [from, to] = await Promise.all([getAgentRevision(this.db, input.fromRevisionId), getAgentRevision(this.db, input.toRevisionId)]);
    if (!from || !to || from.agentId !== input.agentId || to.agentId !== input.agentId) throw new Error("Revision not found");
    return JSON.parse(JSON.stringify(diffAgentRevisions(from.compiled, to.compiled))) as JsonObject;
  }
  async simulate(input: SimulateInput): Promise<JsonObject> {
    const validation = input.source ? validateAgentSource(createAgentSource(input.source)) : { valid: true, issues: [] };
    return JSON.parse(JSON.stringify({ mode: "validate-only", executed: false, persistentEffects: false, validation, event: input.event, blockedReason: "Simulation is validation-only; live execution is limited to the bounded issue-comment runtime" })) as JsonObject;
  }
  async savePausedDraft(input: PublishDraftInput, principal: GardenerMcpPrincipal): Promise<PausedDraftReceipt> {
    if (!input.agentId && input.expectedDraftVersion !== undefined && input.expectedDraftVersion !== 0) {
      throw new Error("A new Agent draft requires expectedDraftVersion 0");
    }
    const source = sourceFromMcp(input); const sourceHash = await canonicalSha256(source);
    if (input.sourceHash && input.sourceHash !== sourceHash) throw new Error("Source hash mismatch");
    const parsed = parseAgentSource(source);
    const ids = mcpPrincipal(principal);
    let agent = input.agentId ? await getAgent(this.db, input.agentId) : null;
    if (input.agentId && !agent) throw new Error("Agent not found");
    if (!agent) {
      const digest = await canonicalSha256({ key: input.idempotencyKey, owner: principal.owner.githubUserId });
      const id = `agent_${digest.slice(0, 48)}`;
      agent = await getAgent(this.db, id) ?? await createAgent(this.db, { id, slug: `mcp-${digest.slice(0, 24)}`, name: parsed.name, description: parsed.description, createdBy: ids.actor });
    }
    const idempotencyKeyHash = await canonicalSha256({ key: input.idempotencyKey, clientId: principal.clientId, agentId: agent.id });
    const existing = await latestEditingDraft(this.db, agent.id);
    if (existing?.idempotencyKeyHash === idempotencyKeyHash) {
      if (existing.sourceHash !== sourceHash) throw new Error("Idempotency key was reused with different Agent source");
      return { lifecycle: "paused_draft", draftId: existing.id, contentHash: existing.sourceHash, updatedAt: new Date(existing.updatedAt).toISOString(), active: false, enabled: false, immutableRevisionCreated: false };
    }
    if (existing && input.expectedDraftVersion === undefined) {
      throw new Error("Updating an existing MCP draft requires expectedDraftVersion");
    }
    if (existing && input.expectedDraftVersion !== existing.version) throw new Error("Agent draft changed since it was read");
    if (!existing && input.expectedDraftVersion !== undefined && input.expectedDraftVersion !== 0) throw new Error("A new Agent draft requires expectedDraftVersion 0");
    const draftId = existing?.id ?? `draft_${(await canonicalSha256({ agentId: agent.id, channel: "mcp" })).slice(0, 48)}`;
    const draft = await saveDraft(this.db, {
      draftId, agentId: agent.id, source, actor: ids.actor, actorLogin: ids.actorLogin, sourceKind: "mcp",
      ...(input.expectedDraftVersion === undefined ? {} : { expectedVersion: input.expectedDraftVersion }),
      idempotencyKeyHash,
    });
    return { lifecycle: "paused_draft", draftId: draft.id, contentHash: draft.sourceHash, updatedAt: new Date(draft.updatedAt).toISOString(), active: false, enabled: false, immutableRevisionCreated: false };
  }
}

class D1RunTraceService implements RunTraceService {
  constructor(private readonly db: D1Database) {}
  async getTrace(input: GetRunTraceInput): Promise<JsonObject> {
    const run = await this.db.prepare("SELECT id, kind, status, harness_id, harness_version, created_at, started_at, completed_at FROM agent_runs WHERE id = ?")
      .bind(input.runId).first<Record<string, unknown>>();
    if (!run) throw new Error("Run not found");
    const steps = await this.db.prepare("SELECT id, task_id, stable_key, kind, status, attempt_count, max_attempts, created_at, started_at, completed_at FROM run_steps WHERE run_id = ? ORDER BY created_at, id LIMIT ?")
      .bind(input.runId, input.limit).all<Record<string, unknown>>();
    return JSON.parse(JSON.stringify({ run, steps: steps.results, nextCursor: null })) as JsonObject;
  }
}

export function createGardenerMcpServices(env: Pick<Env, "DB">): GardenerMcpServices {
  return { agents: new D1AgentAuthoringService(env.DB), runs: new D1RunTraceService(env.DB) };
}

export const agentCatalog = {
  compilerVersion: AGENT_COMPILER_VERSION,
  capabilityCatalogVersion: CAPABILITY_CATALOG_VERSION,
  runtimeVersion: AGENT_RUNTIME_VERSION,
  capabilities: capabilityCatalog,
  triggers: [],
  observations: observationCapabilityValues,
  workspace: workspaceCapabilityValues,
  effects: operationKindSchema.options,
};
