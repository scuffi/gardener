import {
  observationCapabilityValues, operationKindSchema, policyModeSchema, repositoryPolicyV1Schema,
  workspaceCapabilityValues, type PolicyMode, type RepositoryPolicyV1,
} from "@gardener/contracts";
import { calculateRepositoryPolicyHash, canonicalJson } from "@gardener/core";
import { Hono } from "hono";
import { z } from "zod";
import { auditActor, requirePermission, type AuthorizationVariables } from "./authorization";
import type { Env } from "./env";

const dashboardKinds = ["dashboard-session", "local-dev"] as const;
const rank: Record<PolicyMode, number> = { disabled: 0, approval: 1, automatic: 2 };
const policyInputSchema = z.object({
  expectedPolicyVersion: z.number().int().positive(), expectedPolicyHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  operationModes: z.record(operationKindSchema, policyModeSchema),
  allowedObservations: z.array(z.enum(observationCapabilityValues)).max(observationCapabilityValues.length),
  workspaceModes: z.record(z.enum(workspaceCapabilityValues), policyModeSchema),
}).strict();

type Bindings = { Bindings: Env; Variables: AuthorizationVariables };
interface RepoRow { id: string; owner: string; name: string; active: number }
interface OperationRow { operation_kind: string; mode: string; policy_version: number }
interface CapabilityRow { capability_kind: string; mode: string; constraints_json: string; policy_version: number }

export type RepositoryPolicyReadErrorCode =
  | "repository_operation_policy_invalid"
  | "repository_capability_policy_invalid"
  | "repository_policy_version_invalid";

export class RepositoryPolicyReadError extends Error {
  readonly code: RepositoryPolicyReadErrorCode;

  constructor(code: RepositoryPolicyReadErrorCode) {
    super(code);
    this.name = "RepositoryPolicyReadError";
    this.code = code;
  }
}

async function version(db: D1Database): Promise<number> {
  const row=await db.prepare("SELECT value FROM settings WHERE key='policy_version'").first<{value:string}>();
  const value=Number(row?.value); if(!Number.isSafeInteger(value)||value<1)throw new Error("policy_version_invalid"); return value;
}

async function repository(db:D1Database,id:string):Promise<RepoRow|null>{
  return db.prepare("SELECT id,owner,name,active FROM repositories WHERE id=?").bind(id).first<RepoRow>();
}

export interface RepositoryPolicyView {
  configured: boolean; message?: string; repository: { id:string; name:string; active:boolean };
  policy: RepositoryPolicyV1; policyVersion:number; policyHash:string; repositoryConstraints:Record<string,unknown>;
  workspaceCeilings: { operationModes:Record<string,PolicyMode>; observation:Record<string,PolicyMode>; workspaceModes:Record<string,PolicyMode>; constraints:Record<string,unknown> };
  effective: { operationModes:Record<string,PolicyMode>; allowedObservations:string[]; workspaceModes:Record<string,PolicyMode> };
}

export async function getRepositoryPolicy(db:D1Database,repositoryId:string):Promise<RepositoryPolicyView|null>{
  const repo=await repository(db,repositoryId); if(!repo)return null;
  const [policyVersion,operations,capabilities,workspaceOperations,workspaceCapabilities]=await Promise.all([
    version(db),
    db.prepare("SELECT operation_kind,mode,policy_version FROM repository_operation_policies WHERE repository_id=? ORDER BY operation_kind").bind(repositoryId).all<OperationRow>(),
    db.prepare("SELECT capability_kind,mode,constraints_json,policy_version FROM repository_capability_policies WHERE repository_id=? ORDER BY capability_kind").bind(repositoryId).all<CapabilityRow>(),
    db.prepare("SELECT operation_kind,mode FROM operation_policies").all<{operation_kind:string;mode:PolicyMode}>(),
    db.prepare("SELECT capability_kind,mode,constraints_json FROM instance_capability_policies").all<{capability_kind:string;mode:PolicyMode;constraints_json:string}>(),
  ]);
  const operationRows=new Map<string,{mode:PolicyMode;policyVersion:number}>();
  const capabilityRows=new Map<string,{mode:PolicyMode;constraints:unknown;policyVersion:number}>();
  const rowVersions:number[]=[];
  for(const row of operations.results){
    const kind=operationKindSchema.safeParse(row.operation_kind); const mode=policyModeSchema.safeParse(row.mode);
    if (!kind.success || !mode.success || !Number.isSafeInteger(row.policy_version) || row.policy_version < 1) {
      throw new RepositoryPolicyReadError("repository_operation_policy_invalid");
    }
    operationRows.set(kind.data,{mode:mode.data,policyVersion:row.policy_version}); rowVersions.push(row.policy_version);
  }
  for(const row of capabilities.results){
    const known=(observationCapabilityValues as readonly string[]).includes(row.capability_kind)||(workspaceCapabilityValues as readonly string[]).includes(row.capability_kind);
    const mode=policyModeSchema.safeParse(row.mode); let constraints:unknown;
    try {
      constraints = JSON.parse(row.constraints_json);
    } catch {
      throw new RepositoryPolicyReadError("repository_capability_policy_invalid");
    }
    if (!known || !mode.success || !Number.isSafeInteger(row.policy_version) || row.policy_version < 1) {
      throw new RepositoryPolicyReadError("repository_capability_policy_invalid");
    }
    capabilityRows.set(row.capability_kind,{mode:mode.data,constraints,policyVersion:row.policy_version}); rowVersions.push(row.policy_version);
  }
  const localVersion=rowVersions[0]??1;
  if (rowVersions.some((rowVersion) => rowVersion !== localVersion)) {
    throw new RepositoryPolicyReadError("repository_policy_version_invalid");
  }
  const configured=operationKindSchema.options.every(key=>operationRows.has(key)) &&
    [...observationCapabilityValues,...workspaceCapabilityValues].every(key=>capabilityRows.has(key));
  const operationModes:Record<string,PolicyMode>={}; for(const key of operationKindSchema.options)operationModes[key]="disabled";
  const workspaceModes:Record<string,PolicyMode>={}; const allowedObservations:string[]=[];
  if(configured){
    for(const key of operationKindSchema.options)operationModes[key]=operationRows.get(key)!.mode;
    for(const key of observationCapabilityValues)if(capabilityRows.get(key)!.mode!=="disabled")allowedObservations.push(key);
    for(const key of workspaceCapabilityValues)workspaceModes[key]=capabilityRows.get(key)!.mode;
  }
  const draft={schemaVersion:"v1" as const,repositoryId,repositoryDisplayName:`${repo.owner}/${repo.name}`,version:localVersion,
    policyHash:"0".repeat(64),operationModes,allowedObservations:allowedObservations.sort(),workspaceModes};
  const parsedDraft=repositoryPolicyV1Schema.parse(draft); const hash=await calculateRepositoryPolicyHash(parsedDraft); const policy=repositoryPolicyV1Schema.parse({...parsedDraft,policyHash:hash});
  const workspaceOp=Object.fromEntries(workspaceOperations.results.map(row=>[row.operation_kind,row.mode])) as Record<string,PolicyMode>;
  const workspaceCap=Object.fromEntries(workspaceCapabilities.results.map(row=>[row.capability_kind,row.mode])) as Record<string,PolicyMode>;
  const constraints=Object.fromEntries(workspaceCapabilities.results.map(row=>[row.capability_kind,JSON.parse(row.constraints_json)]));
  const repositoryConstraints=Object.fromEntries(Array.from(capabilityRows,([key,row])=>[key,row.constraints]));
  const effectiveOps=Object.fromEntries(operationKindSchema.options.map(key=>[key,rank[operationModes[key]!]<=rank[workspaceOp[key]??"disabled"]?operationModes[key]:workspaceOp[key]??"disabled"])) as Record<string,PolicyMode>;
  const effectiveWorkspace=Object.fromEntries(workspaceCapabilityValues.map(key=>[key,rank[workspaceModes[key]??"disabled"]<=rank[workspaceCap[key]??"disabled"]?(workspaceModes[key]??"disabled"):(workspaceCap[key]??"disabled")])) as Record<string,PolicyMode>;
  return {configured,...(!configured?{message:"Policy not configured — nothing will run"}:{}),repository:{id:repo.id,name:`${repo.owner}/${repo.name}`,active:repo.active===1},policy,policyVersion,policyHash:hash,repositoryConstraints,
    workspaceCeilings:{operationModes:workspaceOp,observation:workspaceCap,workspaceModes:workspaceCap,constraints},
    effective:{operationModes:effectiveOps,allowedObservations:allowedObservations.filter(key=>(workspaceCap[key]??"disabled")!=="disabled"),workspaceModes:effectiveWorkspace}};
}

export async function putRepositoryPolicy(db:D1Database,repositoryId:string,input:z.infer<typeof policyInputSchema>,actor:ReturnType<typeof auditActor>):Promise<"updated"|"conflict"|"noop">{
  const current=await getRepositoryPolicy(db,repositoryId); if(!current)return "conflict";
  if(current.policyVersion!==input.expectedPolicyVersion||(current.configured?current.policyHash:null)!==input.expectedPolicyHash)return "conflict";
  const nextDraft={schemaVersion:"v1" as const,repositoryId,repositoryDisplayName:current.repository.name,version:current.policyVersion+1,policyHash:"0".repeat(64),operationModes:input.operationModes,allowedObservations:[...input.allowedObservations].sort(),workspaceModes:input.workspaceModes};
  // Version is transport metadata and is excluded by the canonical calculator.
  const nextHash=await calculateRepositoryPolicyHash(nextDraft);
  if(current.configured&&nextHash===current.policyHash)return "noop";
  const nextVersion=current.policyVersion+1; const observationSet=new Set(input.allowedObservations);
  const counts=await db.prepare(`SELECT
    (SELECT COUNT(*) FROM repository_operation_policies WHERE repository_id=?) operation_count,
    (SELECT COUNT(*) FROM repository_capability_policies WHERE repository_id=?) capability_count`).bind(repositoryId,repositoryId).first<{operation_count:number;capability_count:number}>();
  if(!counts)throw new Error("repository policy counts unavailable");
  const statements:D1PreparedStatement[]=[
    db.prepare(`UPDATE settings SET value=CASE WHEN value=? AND
      (SELECT COUNT(*) FROM repository_operation_policies WHERE repository_id=?)=? AND
      (SELECT COUNT(*) FROM repository_capability_policies WHERE repository_id=?)=? THEN value ELSE NULL END
      WHERE key='policy_version'`).bind(String(current.policyVersion),repositoryId,counts.operation_count,repositoryId,counts.capability_count),
    db.prepare("UPDATE settings SET value=CAST(value AS INTEGER)+1,updated_at=CURRENT_TIMESTAMP WHERE key='policy_version'"),
  ];
  for(const key of operationKindSchema.options)statements.push(db.prepare(`INSERT INTO repository_operation_policies(repository_id,operation_kind,mode,policy_version,updated_by_user_id)
    VALUES(?,?,?,?,?) ON CONFLICT(repository_id,operation_kind) DO UPDATE SET mode=excluded.mode,policy_version=excluded.policy_version,
    updated_by_user_id=excluded.updated_by_user_id,updated_at=CURRENT_TIMESTAMP`).bind(repositoryId,key,input.operationModes[key],nextVersion,actor.actorUserId));
  for(const key of observationCapabilityValues)statements.push(db.prepare(`INSERT INTO repository_capability_policies(repository_id,capability_kind,mode,constraints_json,policy_version,updated_by_user_id)
    VALUES(?,?,?,'{}',?,?) ON CONFLICT(repository_id,capability_kind) DO UPDATE SET mode=excluded.mode,
    policy_version=excluded.policy_version,updated_by_user_id=excluded.updated_by_user_id,updated_at=CURRENT_TIMESTAMP`).bind(repositoryId,key,observationSet.has(key)?"automatic":"disabled",nextVersion,actor.actorUserId));
  for(const key of workspaceCapabilityValues)statements.push(db.prepare(`INSERT INTO repository_capability_policies(repository_id,capability_kind,mode,constraints_json,policy_version,updated_by_user_id)
    VALUES(?,?,?,'{}',?,?) ON CONFLICT(repository_id,capability_kind) DO UPDATE SET mode=excluded.mode,
    policy_version=excluded.policy_version,updated_by_user_id=excluded.updated_by_user_id,updated_at=CURRENT_TIMESTAMP`).bind(repositoryId,key,input.workspaceModes[key],nextVersion,actor.actorUserId));
  statements.push(db.prepare("INSERT INTO audit_records(actor,actor_user_id,actor_identity_json,action,resource_type,resource_id,detail_json)VALUES(?,?,?,'repository.policy_updated','repository',?,?)").bind(actor.actor,actor.actorUserId,actor.actorIdentityJson,repositoryId,canonicalJson({policyVersion:nextVersion,policyHash:nextHash})));
  try{
    const results=await db.batch(statements);
    if((results[0]?.meta.changes??0)!==1||(results[1]?.meta.changes??0)!==1)throw new Error("repository policy guard invariant failed");
  }catch(error){
    const [freshVersion,freshCounts]=await Promise.all([version(db),db.prepare(`SELECT
      (SELECT COUNT(*) FROM repository_operation_policies WHERE repository_id=?) operation_count,
      (SELECT COUNT(*) FROM repository_capability_policies WHERE repository_id=?) capability_count`).bind(repositoryId,repositoryId).first<{operation_count:number;capability_count:number}>()]);
    if(freshVersion!==current.policyVersion||freshCounts?.operation_count!==counts.operation_count||freshCounts?.capability_count!==counts.capability_count)return "conflict";
    throw error;
  }
  return "updated";
}

export const repositoryPolicyRoutes=new Hono<Bindings>();
repositoryPolicyRoutes.get("/repositories/:id/policy",async c=>{const denied=requirePermission(c,"workspace.view",dashboardKinds);if(denied)return denied;const view=await getRepositoryPolicy(c.env.DB,c.req.param("id"));return view?c.json(view):c.json({error:"repository_not_found"},404);});
repositoryPolicyRoutes.put("/repositories/:id/policy",async c=>{
  const basicDenied=requirePermission(c,"workspace.view",dashboardKinds);if(basicDenied)return basicDenied;
  const input=policyInputSchema.parse(await c.req.json()); const current=await getRepositoryPolicy(c.env.DB,c.req.param("id")); if(!current)return c.json({error:"repository_not_found"},404);
  const allChanges:[PolicyMode,PolicyMode][]=[...operationKindSchema.options.map(key=>[current.policy.operationModes[key]??"disabled",input.operationModes[key]] as [PolicyMode,PolicyMode]),...workspaceCapabilityValues.map(key=>[current.policy.workspaceModes[key]??"disabled",input.workspaceModes[key]] as [PolicyMode,PolicyMode]),...observationCapabilityValues.map(key=>[current.policy.allowedObservations.includes(key)?"automatic":"disabled",input.allowedObservations.includes(key)?"automatic":"disabled"] as [PolicyMode,PolicyMode])];
  const widens=allChanges.some(([from,to])=>rank[to]>rank[from]);
  for(const key of operationKindSchema.options)if(rank[input.operationModes[key]]>rank[current.workspaceCeilings.operationModes[key]??"disabled"])return c.json({error:"repository_policy_exceeds_workspace_ceiling"},400);
  for(const key of workspaceCapabilityValues)if(rank[input.workspaceModes[key]]>rank[current.workspaceCeilings.workspaceModes[key]??"disabled"])return c.json({error:"repository_policy_exceeds_workspace_ceiling"},400);
  for(const key of input.allowedObservations)if((current.workspaceCeilings.observation[key]??"disabled")==="disabled")return c.json({error:"repository_policy_exceeds_workspace_ceiling"},400);
  const denied=requirePermission(c,!current.configured||widens?"policy.widen":"policy.narrow",dashboardKinds);if(denied)return denied;
  const result=await putRepositoryPolicy(c.env.DB,c.req.param("id"),input,auditActor(c.get("authorization")));if(result==="conflict")return c.json({error:"repository_policy_changed"},409);
  return c.json({result,policy:await getRepositoryPolicy(c.env.DB,c.req.param("id"))});
});
