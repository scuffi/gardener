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
  type AssignmentHistoryDetails,
  type AuthoringPrincipal,
  type CompiledAgentRevisionV1,
  type PolicyMode,
} from "@gardener/contracts";
import {
  canonicalJson,
  canonicalSha256,
  analyzeAssignmentOverlap,
  agentSourceText,
  compileAgentRevision,
  createAgentSource,
  diffAgentRevisions,
  parseAgentSource,
  validateAgentSource,
} from "@gardener/core";
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "./env";
import { auditActor, requirePermission, type AuthorizationVariables } from "./authorization";
import { repositoryPolicyRoutes } from "./repository-policy";
import {
  activateAgentRevisionGuarded,
  createAgent,
  getAgent,
  getAgentDraft,
  getAgentRevision,
  listAgents,
  listOpenInbox,
  publishAgentDraft,
  resolveInboxItem,
  saveAgentDraft,
  findAssignment,
  getAssignment,
  getAssignmentEpoch,
  listAssignmentsByAgent,
  listAssignmentsByRepository,
  writeAssignment,
  writeAssignmentsAtomic,
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
  Variables: AuthorizationVariables;
}
const dashboardKinds = ["dashboard-session", "local-dev"] as const;
async function auditWithPrincipal(c: any, action: string, resourceType: string, resourceId: string, detail: unknown = {}): Promise<void> {
  const actor=auditActor(c.get("authorization"));
  await c.env.DB.prepare("INSERT INTO audit_records(actor,actor_user_id,actor_identity_json,action,resource_type,resource_id,detail_json)VALUES(?,?,?,?,?,?,?)")
    .bind(actor.actor,actor.actorUserId,actor.actorIdentityJson,action,resourceType,resourceId,canonicalJson(detail)).run();
}

const sourceRequestSchema = z.union([
  z.object({ source: agentSourceV1Schema }).strict(),
  z.object({
    sourceMd: z.string().min(1).max(262_144),
    agentId: z.string().optional(),
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
const enableSchema = z.object({ enabled: z.boolean(), reason: z.string().trim().max(1_000).nullable().default(null) }).strict();
const dashboardSourceSchema = z.object({ sourceMd: z.string().min(1).max(262_144) }).strict();
const inboxResponseSchema = z.object({ action: z.enum(["approve", "reject", "dismiss"]) }).strict();

function publicId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function authoringPrincipal(actor: string, displayName: string, kind: "owner" | "member" = "owner"): AuthoringPrincipal {
  return { provider: "gardener", principal: { kind, id: actor, displayName } };
}

function provenance(
  source: AgentProvenanceV1["source"],
  principal: AuthoringPrincipal,
  authoredAt: string,
  publishedAt = authoredAt,
): AgentProvenanceV1 {
  return { source, authoredBy: principal, publishedBy: principal, authoredAt, publishedAt };
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
    sourceKind: AgentProvenanceV1["source"]; actorRole?: "owner" | "member";
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
      authoringPrincipal(input.actor, input.actorLogin, input.actorRole),
      now,
      now,
    ),
    compilerVersion: AGENT_COMPILER_VERSION,
    catalogVersion: CAPABILITY_CATALOG_VERSION,
    runtimeVersion: AGENT_RUNTIME_VERSION,
    actorId: input.actor,
    ...(input.expectedVersion === undefined ? {} : { expectedVersion: input.expectedVersion }),
    ...(input.idempotencyKeyHash === undefined ? {} : { idempotencyKeyHash: input.idempotencyKeyHash }),
  });
}

async function compileDraft(db: D1Database, agentId: string, draftId: string, actor: string, actorLogin: string, actorRole: "owner" | "member" = "owner") {
  const [agent, draft] = await Promise.all([getAgent(db, agentId), getAgentDraft(db, draftId)]);
  if (!agent || !draft || draft.agentId !== agentId || draft.status !== "editing") throw new Error("Editing Agent draft not found");
  const revision = agent.revisionCounter + 1;
  const now = new Date().toISOString();
  const draftProvenance = agentProvenanceV1Schema.parse(draft.provenance);
  const publishedProvenance = agentProvenanceV1Schema.parse({
    ...draftProvenance,
    publishedBy: authoringPrincipal(actor, actorLogin, actorRole),
    publishedAt: now,
  });
  const compiled = await compileAgentRevision(storedSource(draft.sourceMd), {
    agentId,
    revision,
    revisionId: publicId("revision"),
    provenance: publishedProvenance,
    compilerVersion: AGENT_COMPILER_VERSION,
    capabilityCatalogVersion: CAPABILITY_CATALOG_VERSION,
    runtimeVersion: AGENT_RUNTIME_VERSION,
    now: () => new Date(now),
  });
  return { agent, draft, revisionNumber: revision, publishedProvenance, ...compiled };
}

export const agentManagement = new Hono<AgentBindings>();

async function assignmentProjection(db:D1Database,agentId:string){
  const assignments=await listAssignmentsByAgent(db,agentId); const enabled=assignments.filter(item=>item.enabled&&item.removedAt===null).length;
  return {enabled:enabled>0,enabledAssignments:enabled,assignmentCount:assignments.filter(item=>item.removedAt===null).length};
}
async function checkedCompiled(revision:Awaited<ReturnType<typeof getAgentRevision>>){
  if(!revision)throw new Error("revision_not_found"); const compiled=compiledAgentRevisionV1Schema.parse(revision.compiled);
  if(await canonicalSha256(compiled)!==revision.compiledHash)throw new Error("compiled_hash_invalid"); return compiled;
}
async function overlapFor(db:D1Database,agentId:string,repositoryId:string,assignmentId:string,assignmentVersion:number,revisionId?:string){
  const agent=await getAgent(db,agentId); const targetId=revisionId??agent?.activeRevisionId; if(!targetId)return null;
  const revision=await getAgentRevision(db,targetId); if(!revision||revision.agentId!==agentId)return null; const candidate=await checkedCompiled(revision);
  const rows=await db.prepare(`SELECT ar.id,ar.repository_id,ar.version,ar.agent_id,a.name agent_name,aa.revision_id,r.compiled_json,r.compiled_hash
    FROM agent_repository_assignments ar JOIN agents a ON a.id=ar.agent_id JOIN agent_activations aa ON aa.agent_id=ar.agent_id
    JOIN agent_revisions r ON r.id=aa.revision_id WHERE ar.repository_id=? AND ar.enabled=1 AND ar.removed_at IS NULL`).bind(repositoryId).all<{id:string;repository_id:string;version:number;agent_id:string;agent_name:string;revision_id:string;compiled_json:string;compiled_hash:string}>();
  const existing=[]; for(const row of rows.results){const compiled=compiledAgentRevisionV1Schema.parse(JSON.parse(row.compiled_json));if(await canonicalSha256(compiled)!==row.compiled_hash)throw new Error("compiled_hash_invalid");existing.push({repositoryId:row.repository_id,assignmentId:row.id,assignmentVersion:row.version,enabled:true,agentId:row.agent_id,agentDisplayName:row.agent_name,revisionId:row.revision_id,revisionCompiledHash:row.compiled_hash,triggers:compiled.spec.triggers,effects:compiled.spec.requestedCapabilities.effects});}
  const warning=await analyzeAssignmentOverlap({assignmentEpoch:await getAssignmentEpoch(db),repositoryId,candidate:{assignmentId,assignmentVersion,agentId,...(agent?.name?{agentDisplayName:agent.name}:{}),revisionId:targetId,revisionCompiledHash:revision.compiledHash,triggers:candidate.spec.triggers,effects:candidate.spec.requestedCapabilities.effects},existing});
  if(!warning)return null; const repo=await db.prepare("SELECT owner,name FROM repositories WHERE id=?").bind(repositoryId).first<{owner:string;name:string}>();
  return {...warning,...(repo?{repositoryDisplayName:`${repo.owner}/${repo.name}`}:{})};
}
const assignmentCreateSchema=z.object({repositoryId:z.string().regex(/^[1-9][0-9]{0,31}$/).optional(),allCurrent:z.literal(true).optional(),authorityCeiling:z.enum(["disabled","approval","automatic"]).default("disabled"),expectedAssignmentEpoch:z.number().int().nonnegative(),expectedVersion:z.number().int().positive().optional(),expectedConfigHash:z.string().regex(/^[a-f0-9]{64}$/).optional(),expectedActiveRevisionId:z.string().nullable().optional(),materializedRepositoryIds:z.array(z.string().regex(/^[1-9][0-9]{0,31}$/)).max(500).optional(),overlapFingerprint:z.string().regex(/^[a-f0-9]{64}$/).optional()}).strict().refine(value=>(value.repositoryId!==undefined)!==(value.allCurrent===true),"Choose one repository or all current repositories");
const assignmentActionSchema=z.object({expectedVersion:z.number().int().positive(),expectedConfigHash:z.string().regex(/^[a-f0-9]{64}$/),expectedAssignmentEpoch:z.number().int().nonnegative(),authorityCeiling:z.enum(["disabled","approval","automatic"]).optional(),reason:z.string().trim().max(1000).nullable().default(null),expectedActiveRevisionId:z.string().nullable().optional(),overlapFingerprint:z.string().regex(/^[a-f0-9]{64}$/).optional()}).strict();
const assignmentAuthoritySchema=z.object({authorityCeiling:z.enum(["disabled","approval","automatic"]),expectedVersion:z.number().int().positive(),expectedConfigHash:z.string().regex(/^[a-f0-9]{64}$/),expectedAssignmentEpoch:z.number().int().nonnegative(),reason:z.string().trim().max(1000).nullable().default(null)}).strict();
const activationSchema=z.object({reason:z.string().trim().max(1000).nullable().default(null),expectedAssignmentEpoch:z.number().int().nonnegative(),expectedCurrentRevisionId:z.string().nullable(),overlapFingerprint:z.string().regex(/^[a-f0-9]{64}$/).optional()}).strict();

agentManagement.get("/agents",async c=>{const denied=requirePermission(c,"workspace.view",dashboardKinds);if(denied)return denied;const agents=await listAgents(c.env.DB);return c.json({agents:await Promise.all(agents.map(async agent=>{const draft=await latestEditingDraft(c.env.DB,agent.id);const projection=await assignmentProjection(c.env.DB,agent.id);return{id:agent.id,slug:agent.slug,name:agent.name,description:agent.description,...projection,lifecycle:projection.enabled?"active":agent.activeRevisionId?"paused":"draft",activeRevision:agent.activeRevisionId?(await getAgentRevision(c.env.DB,agent.activeRevisionId))?.revision??null:null,latestRevision:agent.revisionCounter||null,hasDraft:draft!==null,updatedAt:agent.updatedAt};}))});});
agentManagement.post("/agents",async c=>{const denied=requirePermission(c,"agent.draft.save",dashboardKinds);if(denied)return denied;const body=await c.req.json();if(typeof body==="object"&&body!==null&&"sourceMd" in body){const {sourceMd}=dashboardSourceSchema.parse(body);const source=dashboardSource(sourceMd);const spec=parseAgentSource(source);const suffix=crypto.randomUUID().replaceAll("-","").slice(0,10);const agent=await createAgent(c.env.DB,{id:publicId("agent"),slug:`${slugFromName(spec.name).slice(0,88)}-${suffix}`,name:spec.name,description:spec.description,createdBy:c.get("actor")});const draft=await saveDraft(c.env.DB,{draftId:publicId("draft"),agentId:agent.id,source,actor:c.get("actor"),actorLogin:c.get("actorLogin"),sourceKind:"dashboard",actorRole:c.get("authorization").role});await auditWithPrincipal(c,"agent.created","agent",agent.id,{slug:agent.slug,draftId:draft.id});return c.json({agent:{...agent,enabled:false,lifecycle:"draft",activeRevision:null,latestRevision:null,hasDraft:true,updatedAt:agent.updatedAt},draftId:draft.id},201);}const input=createAgentRequestSchema.parse(body);const agent=await createAgent(c.env.DB,{id:input.id??publicId("agent"),slug:input.slug,name:input.name,description:input.description,createdBy:c.get("actor")});await auditWithPrincipal(c,"agent.created","agent",agent.id,{slug:agent.slug});return c.json({agent:{...agent,enabled:false,enabledAssignments:0,assignmentCount:0}},201);});
agentManagement.get("/agents/:id",async c=>{const denied=requirePermission(c,"workspace.view",dashboardKinds);if(denied)return denied;const agent=await getAgent(c.env.DB,c.req.param("id"));if(!agent)return c.json({error:"agent_not_found"},404);const [rows,draft,projection,assignments]=await Promise.all([c.env.DB.prepare("SELECT id,revision,source_md,source_hash,compiled_hash,published_at,published_by FROM agent_revisions WHERE agent_id=? ORDER BY revision DESC").bind(agent.id).all<{id:string;revision:number;source_md:string;source_hash:string;compiled_hash:string;published_at:string;published_by:string}>(),latestEditingDraft(c.env.DB,agent.id),assignmentProjection(c.env.DB,agent.id),listAssignmentsByAgent(c.env.DB,agent.id)]);const active=agent.activeRevisionId;return c.json({agent:{id:agent.id,slug:agent.slug,name:agent.name,description:agent.description,...projection,lifecycle:projection.enabled?"active":active?"paused":"draft",activeRevision:active?rows.results.find(row=>row.id===active)?.revision??null:null,latestRevision:agent.revisionCounter||null,hasDraft:draft!==null,updatedAt:agent.updatedAt},draft:draft?{id:draft.id,sourceMd:agentSourceText(storedSource(draft.sourceMd)),sourceHash:draft.sourceHash,updatedAt:draft.updatedAt}:null,sourceMd:draft?undefined:rows.results[0]?agentSourceText(storedSource(rows.results[0].source_md)):undefined,revisions:rows.results.map(row=>({id:row.id,revision:row.revision,sourceHash:row.source_hash,compiledHash:row.compiled_hash,publishedAt:row.published_at,publishedBy:row.published_by,active:row.id===active})),assignments});});
agentManagement.post("/agents/validate",async c=>{const denied=requirePermission(c,"agent.validate",dashboardKinds);if(denied)return denied;const input=sourceRequestSchema.parse(await c.req.json());const source="source" in input?input.source:dashboardSource(input.sourceMd);const validation=validateAgentSource(source);const diagnostics=validation.issues.map(issue=>({code:"invalid_agent_source",path:String(issue.path),message:issue.message,severity:"error" as const}));return c.json({...validation,diagnostics,capabilities:validation.spec?.requestedCapabilities,publishable:validation.valid,sourceHash:await canonicalSha256(source),activatable:validation.valid});});
agentManagement.post("/agents/:id/drafts",async c=>{const denied=requirePermission(c,"agent.draft.save",dashboardKinds);if(denied)return denied;const agent=await getAgent(c.env.DB,c.req.param("id"));if(!agent)return c.json({error:"agent_not_found"},404);const input=saveDraftRequestSchema.parse(await c.req.json());const draft=await saveDraft(c.env.DB,{draftId:input.draftId??publicId("draft"),agentId:agent.id,source:input.source,actor:c.get("actor"),actorLogin:c.get("actorLogin"),sourceKind:"dashboard",actorRole:c.get("authorization").role});await auditWithPrincipal(c,"agent.draft.saved","agent_draft",draft.id,{agentId:agent.id,sourceHash:draft.sourceHash});return c.json({draft},201);});
agentManagement.get("/agents/:id/drafts/:draftId",async c=>{const denied=requirePermission(c,"workspace.view",dashboardKinds);if(denied)return denied;const draft=await getAgentDraft(c.env.DB,c.req.param("draftId"));if(!draft||draft.agentId!==c.req.param("id"))return c.json({error:"draft_not_found"},404);return c.json({draft:{...draft,source:storedSource(draft.sourceMd),sourceMd:undefined}});});
agentManagement.post("/agents/:id/drafts/:draftId/simulate",async c=>{const denied=requirePermission(c,"agent.simulate",dashboardKinds);if(denied)return denied;const draft=await getAgentDraft(c.env.DB,c.req.param("draftId"));if(!draft||draft.agentId!==c.req.param("id"))return c.json({error:"draft_not_found"},404);return c.json({mode:"validate-only",executed:false,persistentEffects:false,validation:draft.validation,blockedReason:"Simulation is validation-only; live execution is limited to the bounded issue-comment runtime"});});
async function publish(c:any,agentId:string,draftId:string){const built=await compileDraft(c.env.DB,agentId,draftId,c.get("actor"),c.get("actorLogin"),c.get("authorization").role);const revision=await publishAgentDraft(c.env.DB,{revisionId:built.revision.revisionId,revision:built.revisionNumber,draftId:built.draft.id,parsedHash:await canonicalSha256(built.revision.spec),compiled:built.compiled,compiledHash:await canonicalSha256(built.compiled),provenance:built.publishedProvenance,provenanceHash:await canonicalSha256(built.publishedProvenance),publishedBy:c.get("actor")});await auditWithPrincipal(c,"agent.revision.published_paused","agent_revision",revision.id,{agentId:revision.agentId,revision:revision.revision});return revision;}
agentManagement.post("/agents/:id/drafts/:draftId/publish",async c=>{const denied=requirePermission(c,"agent.revision.publish_paused",dashboardKinds);if(denied)return denied;return c.json({revision:await publish(c,c.req.param("id"),c.req.param("draftId")),active:false,enabled:false},201);});
agentManagement.post("/agents/:id/revisions/:revisionId/activate",async c=>{const denied=requirePermission(c,"agent.revision.activate",dashboardKinds);if(denied)return denied;const input=activationSchema.parse(await c.req.json());const requested=c.req.param("revisionId");const revision=/^\d+$/.test(requested)?await revisionByNumber(c.env.DB,c.req.param("id"),Number(requested)):await getAgentRevision(c.env.DB,requested);if(!revision||revision.agentId!==c.req.param("id")||!revision.publishedPaused)return c.json({error:"revision_not_found"},404);await checkedCompiled(revision);const agent=await getAgent(c.env.DB,revision.agentId);if(agent?.activeRevisionId!==input.expectedCurrentRevisionId)return c.json({error:"activation_changed",assignmentEpoch:await getAssignmentEpoch(c.env.DB),currentRevisionId:agent?.activeRevisionId??null},409);const assignments=(await listAssignmentsByAgent(c.env.DB,revision.agentId)).filter(item=>item.enabled&&item.removedAt===null);if(assignments.length){const ids=assignments.map(item=>item.repositoryId);const placeholders=ids.map(()=>"?").join(",");const active=await c.env.DB.prepare(`SELECT id FROM repositories WHERE active=1 AND id IN (${placeholders})`).bind(...ids).all<{id:string}>();if(active.results.length!==new Set(ids).size)return c.json({error:"assigned_repository_inactive"},409);}const warnings=[];for(const item of assignments){const warning=await overlapFor(c.env.DB,revision.agentId,item.repositoryId,item.id,item.version,revision.id);if(warning)warnings.push(warning);}const fingerprint=warnings.length?await canonicalSha256({assignmentEpoch:input.expectedAssignmentEpoch,agentId:revision.agentId,revisionId:revision.id,expectedCurrentRevisionId:input.expectedCurrentRevisionId,warnings:warnings.map(w=>({repositoryId:w.repositoryId,candidate:w.candidate,conflicts:w.conflicts})).sort((a,b)=>a.repositoryId.localeCompare(b.repositoryId))}):null;if(fingerprint&&input.overlapFingerprint!==fingerprint)return c.json({error:"overlap_confirmation_required",warning:{assignmentEpoch:await getAssignmentEpoch(c.env.DB),agent:{id:revision.agentId,name:agent?.name},repositories:warnings,fingerprint}},409);if(await getAssignmentEpoch(c.env.DB)!==input.expectedAssignmentEpoch)return c.json({error:"assignment_changed",assignmentEpoch:await getAssignmentEpoch(c.env.DB)},409);const activated=await activateAgentRevisionGuarded(c.env.DB,{historyId:publicId("activation"),agentId:revision.agentId,revisionId:revision.id,expectedRevisionId:input.expectedCurrentRevisionId,expectedEpoch:input.expectedAssignmentEpoch,actorId:c.get("actor"),reason:input.reason,actor:auditActor(c.get("authorization")),...(fingerprint?{overlapFingerprint:fingerprint}:{})});if(!activated)return c.json({error:"activation_changed",assignmentEpoch:await getAssignmentEpoch(c.env.DB)},409);return c.json({activated:true,agent:{...activated,...await assignmentProjection(c.env.DB,activated.id)}});});
agentManagement.post("/agents/:id/enable",async c=>{const input=enableSchema.parse(await c.req.json());const denied=requirePermission(c,input.enabled?"assignment.enable":"assignment.disable",dashboardKinds);if(denied)return denied;return c.json({error:"agent_global_enablement_replaced",message:"Enable or disable explicit repository assignments instead."},409);});
agentManagement.put("/agents/:id/draft",async c=>{const denied=requirePermission(c,"agent.draft.save",dashboardKinds);if(denied)return denied;const agent=await getAgent(c.env.DB,c.req.param("id"));if(!agent)return c.json({error:"agent_not_found"},404);const {sourceMd}=dashboardSourceSchema.parse(await c.req.json());const existing=await latestEditingDraft(c.env.DB,agent.id);const draft=await saveDraft(c.env.DB,{draftId:existing?.id??publicId("draft"),agentId:agent.id,source:dashboardSource(sourceMd),actor:c.get("actor"),actorLogin:c.get("actorLogin"),sourceKind:"dashboard",actorRole:c.get("authorization").role});await auditWithPrincipal(c,"agent.draft.saved","agent_draft",draft.id,{agentId:agent.id,sourceHash:draft.sourceHash});return c.json({draftId:draft.id,sourceHash:draft.sourceHash});});
agentManagement.post("/agents/simulate",async c=>{const denied=requirePermission(c,"agent.simulate",dashboardKinds);if(denied)return denied;const input=sourceRequestSchema.parse(await c.req.json());const source="source" in input?input.source:dashboardSource(input.sourceMd);const validation=validateAgentSource(source);return c.json({status:validation.valid?"blocked":"failed",summary:validation.valid?"Source is valid. Simulation is validation-only and cannot invoke the bounded live runtime or persistent effects.":"Source validation failed; no simulation or persistent effect was executed.",diagnostics:validation.issues.map(issue=>({code:"invalid_agent_source",path:issue.path,message:issue.message,severity:"error" as const})),proposedEffects:[],executed:false});});
agentManagement.post("/agents/:id/revisions",async c=>{const denied=requirePermission(c,"agent.revision.publish_paused",dashboardKinds);if(denied)return denied;const agent=await getAgent(c.env.DB,c.req.param("id"));if(!agent)return c.json({error:"agent_not_found"},404);const {sourceMd}=dashboardSourceSchema.parse(await c.req.json());const existing=await latestEditingDraft(c.env.DB,agent.id);const draft=await saveDraft(c.env.DB,{draftId:existing?.id??publicId("draft"),agentId:agent.id,source:dashboardSource(sourceMd),actor:c.get("actor"),actorLogin:c.get("actorLogin"),sourceKind:"dashboard",actorRole:c.get("authorization").role});const revision=await publish(c,agent.id,draft.id);return c.json({revision:revision.revision,paused:true},201);});
agentManagement.get("/agents/:id/revisions/:revision",async c=>{const denied=requirePermission(c,"workspace.view",dashboardKinds);if(denied)return denied;const number=z.coerce.number().int().positive().safeParse(c.req.param("revision"));if(!number.success)return c.json({error:"revision_not_found"},404);const revision=await revisionByNumber(c.env.DB,c.req.param("id"),number.data);if(!revision)return c.json({error:"revision_not_found"},404);return c.json({revision:revision.revision,sourceMd:agentSourceText(storedSource(revision.sourceMd)),sourceHash:revision.sourceHash,compiledHash:revision.compiledHash});});
agentManagement.post("/agents/:id/status",async c=>{const input=enableSchema.parse(await c.req.json());const denied=requirePermission(c,input.enabled?"assignment.enable":"assignment.disable",dashboardKinds);if(denied)return denied;return c.json({error:"agent_global_enablement_replaced",message:"Use explicit repository assignments."},409);});

agentManagement.get("/agents/:id/assignments",async c=>{const denied=requirePermission(c,"workspace.view",dashboardKinds);if(denied)return denied;if(!await getAgent(c.env.DB,c.req.param("id")))return c.json({error:"agent_not_found"},404);return c.json({assignmentEpoch:await getAssignmentEpoch(c.env.DB),assignments:await listAssignmentsByAgent(c.env.DB,c.req.param("id"))});});
agentManagement.get("/repositories/:id/assignments",async c=>{const denied=requirePermission(c,"workspace.view",dashboardKinds);if(denied)return denied;return c.json({assignmentEpoch:await getAssignmentEpoch(c.env.DB),assignments:await listAssignmentsByRepository(c.env.DB,c.req.param("id"))});});
agentManagement.post("/agents/:id/assignments",async c=>{
  const basicDenied=requirePermission(c,"workspace.view",dashboardKinds);if(basicDenied)return basicDenied;
  const input=assignmentCreateSchema.parse(await c.req.json());
  const denied=requirePermission(c,input.allCurrent?"assignment.expand":"assignment.add",dashboardKinds);if(denied)return denied;
  const agent=await getAgent(c.env.DB,c.req.param("id"));if(!agent)return c.json({error:"agent_not_found"},404);
  const epoch=await getAssignmentEpoch(c.env.DB);
  if(epoch!==input.expectedAssignmentEpoch)return c.json({error:"assignment_changed",assignmentEpoch:epoch},409);
  const repositories=input.repositoryId
    ? (await c.env.DB.prepare("SELECT id,owner,name FROM repositories WHERE id=? AND active=1").bind(input.repositoryId).all<{id:string;owner:string;name:string}>()).results
    : (await c.env.DB.prepare("SELECT id,owner,name FROM repositories WHERE active=1 ORDER BY id LIMIT 501").all<{id:string;owner:string;name:string}>()).results;
  if(repositories.length>500)return c.json({error:"assignment_expansion_too_large",maximum:500},400);
  if(input.repositoryId&&repositories.length===0)return c.json({error:"active_repository_not_found"},404);
  const repositoryIds=repositories.map(repository=>repository.id).sort();
  if(input.overlapFingerprint&&canonicalJson([...(input.materializedRepositoryIds??[])].sort())!==canonicalJson(repositoryIds))
    return c.json({error:"assignment_changed",assignmentEpoch:epoch,materializedRepositoryIds:repositoryIds},409);
  const plans=[]; const warnings=[];
  for(const repository of repositories){
    const existing=await findAssignment(c.env.DB,agent.id,repository.id);
    if(input.repositoryId&&existing&&(input.expectedVersion!==existing.version||input.expectedConfigHash!==existing.configHash))
      return c.json({error:"assignment_changed",assignment:existing,assignmentEpoch:epoch},409);
    if(existing&&existing.removedAt===null)continue;
    const id=existing?.id??`assignment_${(await canonicalSha256({agentId:agent.id,repositoryId:repository.id})).slice(0,48)}`;
    const warning=await overlapFor(c.env.DB,agent.id,repository.id,id,existing?existing.version+1:1);
    if(warning)warnings.push(warning);
    plans.push({id,agentId:agent.id,repositoryId:repository.id,enabled:false,authorityCeiling:input.authorityCeiling,
      removedAt:null,expectedEpoch:epoch,...(existing?{expectedVersion:existing.version,expectedConfigHash:existing.configHash}:{}),
      action:"added" as const,details:{action:"added" as const,repositoryId:repository.id,agentId:agent.id},
      actor:auditActor(c.get("authorization")),actorUserId:c.get("authorization").userId});
  }
  const preconditions=plans.map(plan=>({repositoryId:plan.repositoryId,assignmentId:plan.id,
    expectedVersion:plan.expectedVersion??null,expectedConfigHash:plan.expectedConfigHash??null})).sort((a,b)=>a.repositoryId.localeCompare(b.repositoryId));
  const aggregateFingerprint=warnings.length?await canonicalSha256({assignmentEpoch:epoch,agentId:agent.id,
    activeRevisionId:agent.activeRevisionId,preconditions,warnings:warnings.map(warning=>({repositoryId:warning.repositoryId,
      candidate:warning.candidate,conflicts:warning.conflicts})).sort((a,b)=>a.repositoryId.localeCompare(b.repositoryId))}):null;
  if(aggregateFingerprint&&input.overlapFingerprint!==aggregateFingerprint)return c.json({error:"overlap_confirmation_required",
    warning:{schemaVersion:"v1",assignmentEpoch:epoch,agent:{id:agent.id,name:agent.name},repositories:warnings,
      preconditions,materializedRepositoryIds:repositoryIds,fingerprint:aggregateFingerprint,currentActiveRevisionId:agent.activeRevisionId}},409);
  if(aggregateFingerprint&&input.expectedActiveRevisionId!==agent.activeRevisionId)return c.json({error:"assignment_changed",
    assignmentEpoch:epoch,currentActiveRevisionId:agent.activeRevisionId},409);
  const changed=await writeAssignmentsAtomic(c.env.DB,plans.map(plan=>({...plan,...(aggregateFingerprint?{overlapFingerprint:aggregateFingerprint}:{})})));
  if(!changed)return c.json({error:"assignment_changed",assignmentEpoch:await getAssignmentEpoch(c.env.DB)},409);
  const assignments=await listAssignmentsByAgent(c.env.DB,agent.id);
  return c.json({assignments,assignmentEpoch:plans.length?epoch+1:epoch,materializedRepositoryCount:repositories.length},201);
});

async function assignmentMutation(c:any,action:"enable"|"disable"|"remove"|"re-add"){
  const permission=action==="re-add"?"assignment.add":action==="enable"?"assignment.enable":action==="remove"?"assignment.remove":"assignment.disable";
  const denied=requirePermission(c,permission,dashboardKinds);if(denied)return denied;
  const input=assignmentActionSchema.parse(await c.req.json());
  const current=await getAssignment(c.env.DB,c.req.param("id"));if(!current)return c.json({error:"assignment_not_found"},404);
  if(current.version!==input.expectedVersion||current.configHash!==input.expectedConfigHash)return c.json({error:"assignment_changed",assignment:current,assignmentEpoch:await getAssignmentEpoch(c.env.DB)},409);
  const requestedCeiling=input.authorityCeiling??current.authorityCeiling;
  if(action!=="re-add"&&requestedCeiling!==current.authorityCeiling)return c.json({error:"use_assignment_authority_endpoint"},400);
  const noop=(action==="enable"&&current.enabled&&current.removedAt===null)||(action==="disable"&&!current.enabled&&current.removedAt===null)||
    (action==="remove"&&current.removedAt!==null)||(action==="re-add"&&current.removedAt===null&&requestedCeiling===current.authorityCeiling);
  if(noop)return c.json({assignment:current,assignmentEpoch:await getAssignmentEpoch(c.env.DB),result:"noop"});
  if(action!=="re-add"&&current.removedAt!==null)return c.json({error:"assignment_removed"},409);
  if(action==="re-add"&&current.removedAt===null)return c.json({error:"use_assignment_authority_endpoint"},400);
  const enabled=action==="enable";const removedAt=action==="remove"?new Date().toISOString():null;
  let warning=null;if(action==="enable"||action==="re-add")warning=await overlapFor(c.env.DB,current.agentId,current.repositoryId,current.id,current.version+1);
  if(warning&&input.overlapFingerprint!==warning.fingerprint)return c.json({error:"overlap_confirmation_required",warning:{...warning,currentActiveRevisionId:warning.candidate.revisionId}},409);
  if(warning&&input.expectedActiveRevisionId!==warning.candidate.revisionId)return c.json({error:"assignment_changed",assignmentEpoch:await getAssignmentEpoch(c.env.DB),currentActiveRevisionId:warning.candidate.revisionId},409);
  if(await getAssignmentEpoch(c.env.DB)!==input.expectedAssignmentEpoch)return c.json({error:"assignment_changed",assignmentEpoch:await getAssignmentEpoch(c.env.DB)},409);
  const historyAction=action==="enable"?"enabled":action==="disable"?"disabled":action==="remove"?"removed":"added";
  const details:AssignmentHistoryDetails=historyAction==="added"?{action:"added",repositoryId:current.repositoryId,agentId:current.agentId}:{action:historyAction};
  const result=await writeAssignment(c.env.DB,{id:current.id,agentId:current.agentId,repositoryId:current.repositoryId,enabled,
    authorityCeiling:requestedCeiling,removedAt,expectedEpoch:input.expectedAssignmentEpoch,expectedVersion:input.expectedVersion,
    expectedConfigHash:input.expectedConfigHash,action:historyAction,details,actor:auditActor(c.get("authorization")),
    actorUserId:c.get("authorization").userId,reason:input.reason,...(warning?{overlapFingerprint:warning.fingerprint}:{})});
  return result?c.json({assignment:result,assignmentEpoch:input.expectedAssignmentEpoch+1,result:"updated"}):
    c.json({error:"assignment_changed",assignmentEpoch:await getAssignmentEpoch(c.env.DB)},409);
}
function rankMode(mode:PolicyMode){return mode==="disabled"?0:mode==="approval"?1:2;}
for(const action of ["enable","disable","remove","re-add"] as const)agentManagement.post(`/assignments/:id/${action}`,c=>assignmentMutation(c,action));

agentManagement.put("/assignments/:id/authority",async c=>{
  const basicDenied=requirePermission(c,"workspace.view",dashboardKinds);if(basicDenied)return basicDenied;
  const input=assignmentAuthoritySchema.parse(await c.req.json());
  const current=await getAssignment(c.env.DB,c.req.param("id"));if(!current)return c.json({error:"assignment_not_found"},404);
  if(current.removedAt!==null)return c.json({error:"assignment_removed"},409);
  const permission=rankMode(input.authorityCeiling)>rankMode(current.authorityCeiling)?"assignment.expand":"policy.narrow";
  const denied=requirePermission(c,permission,dashboardKinds);if(denied)return denied;
  if(current.version!==input.expectedVersion||current.configHash!==input.expectedConfigHash)return c.json({error:"assignment_changed",assignment:current,assignmentEpoch:await getAssignmentEpoch(c.env.DB)},409);
  if(input.authorityCeiling===current.authorityCeiling)return c.json({assignment:current,assignmentEpoch:await getAssignmentEpoch(c.env.DB),result:"noop"});
  const widening=rankMode(input.authorityCeiling)>rankMode(current.authorityCeiling);
  const details=widening?{action:"authority_widened" as const,from:current.authorityCeiling,to:input.authorityCeiling}:
    {action:"authority_narrowed" as const,from:current.authorityCeiling,to:input.authorityCeiling};
  const result=await writeAssignment(c.env.DB,{id:current.id,agentId:current.agentId,repositoryId:current.repositoryId,
    enabled:current.enabled,authorityCeiling:input.authorityCeiling,removedAt:current.removedAt,
    expectedEpoch:input.expectedAssignmentEpoch,expectedVersion:input.expectedVersion,expectedConfigHash:input.expectedConfigHash,
    action:details.action,details,actor:auditActor(c.get("authorization")),actorUserId:c.get("authorization").userId,reason:input.reason});
  return result?c.json({assignment:result,assignmentEpoch:input.expectedAssignmentEpoch+1,result:"updated"}):
    c.json({error:"assignment_changed",assignmentEpoch:await getAssignmentEpoch(c.env.DB)},409);
});

agentManagement.get("/inbox",async c=>{const denied=requirePermission(c,"workspace.view",dashboardKinds);return denied??c.json({items:await listOpenInbox(c.env.DB)});});
agentManagement.post("/inbox/:id/respond",async c=>{const {action}=inboxResponseSchema.parse(await c.req.json());const denied=requirePermission(c,action==="dismiss"?"inbox.dismiss":"run.approve",dashboardKinds);if(denied)return denied;if(action!=="dismiss")return c.json({error:"typed_run_approval_endpoint_required"},409);const changed=await resolveInboxItem(c.env.DB,c.req.param("id"),"dismissed");if(!changed)return c.json({error:"inbox_item_not_found"},404);await auditWithPrincipal(c,"inbox.dismissed","inbox_item",c.req.param("id"));return c.json({item:{id:c.req.param("id"),status:"dismissed"}});});
agentManagement.get("/history",async c=>{const denied=requirePermission(c,"workspace.view",dashboardKinds);if(denied)return denied;const {results}=await c.env.DB.prepare("SELECT id,actor,action,resource_type,resource_id,detail_json,created_at FROM audit_records ORDER BY created_at DESC LIMIT 100").all<{id:number;actor:string;action:string;resource_type:string;resource_id:string;detail_json:string|null;created_at:string}>();return c.json({items:results.map(row=>({id:String(row.id),kind:row.resource_type==="agent_revision"?"revision":row.resource_type==="agent"?"agent":"decision",title:row.action,summary:row.detail_json??undefined,actor:row.actor,agentId:row.resource_type.startsWith("agent")?row.resource_id:undefined,createdAt:row.created_at}))});});
agentManagement.route("/",repositoryPolicyRoutes);

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
    return { agents: await Promise.all(agents.map(async (agent) => ({ id: agent.id, name: agent.name, lifecycle: (await assignmentProjection(this.db,agent.id)).enabled ? "enabled" : agent.activeRevisionId ? "active_paused" : "draft" }))), nextCursor: agents.length === input.limit ? agents.at(-1)!.id : null };
  }
  async get(input: GetAgentInput): Promise<JsonObject> {
    const agent = await getAgent(this.db, input.agentId);
    if (!agent) throw new Error("Agent not found");
    const revision = input.revisionId ? await getAgentRevision(this.db, input.revisionId) : null;
    if (revision && revision.agentId !== agent.id) throw new Error("Revision not found");
    const projection=await assignmentProjection(this.db,agent.id);
    return JSON.parse(JSON.stringify({ agent:{...agent,...projection}, revision: revision ? { ...revision, sourceMd: undefined, ...(input.includeSource ? { source: storedSource(revision.sourceMd) } : {}) } : null })) as JsonObject;
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
