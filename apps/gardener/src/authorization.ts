import { workspaceRoleHasPermission, type PrincipalKind, type WorkspacePermission, type WorkspaceRole } from "@gardener/contracts";
import { canonicalJson } from "@gardener/core";
import type { Context } from "hono";
import type { Env } from "./env";
import { activePrincipalBySubject, resolveDashboardSession, sessionTokenFromRequest, type IdentitySnapshot } from "./identity";
import type { ActiveGardenerMcpPrincipal, GardenerMcpPrincipal } from "./mcp/services";

export interface AuthorizationContext {
  userId: string;
  role: WorkspaceRole;
  displayName: string;
  identity: IdentitySnapshot;
  principalKind: PrincipalKind;
}

export interface AuthorizationVariables {
  authorization: AuthorizationContext;
  actor: string;
  actorLogin: string;
}

export async function resolveRequestAuthorization(request: Request, env: Env): Promise<AuthorizationContext | null> {
  if (env.LOCAL_DEV_BYPASS === "true") {
    let owner = await env.DB.prepare("SELECT u.id user_id, u.display_name, e.provider_subject, e.username FROM memberships m JOIN users u ON u.id=m.user_id LEFT JOIN external_identities e ON e.user_id=u.id AND e.provider='github' WHERE m.role='owner' LIMIT 1").first<{user_id:string;display_name:string;provider_subject:string|null;username:string|null}>();
    if (!owner) {
      await env.DB.batch([
        env.DB.prepare("INSERT OR IGNORE INTO users(id,display_name) VALUES('local-development','Local developer')"),
        env.DB.prepare("INSERT OR IGNORE INTO external_identities(id,user_id,provider,provider_subject,username) VALUES('identity_local_development','local-development','github','local-development','local-development')"),
        env.DB.prepare("INSERT OR IGNORE INTO memberships(id,user_id,role,permanent) VALUES('membership_local_development','local-development','owner',1)"),
      ]);
      owner={user_id:"local-development",display_name:"Local developer",provider_subject:"local-development",username:"local-development"};
    }
    return { userId: owner.user_id, role: "owner", displayName: "Local developer", identity: { provider: "github", providerSubject: owner.provider_subject ?? "local-development", login: owner.username ?? "local-development" }, principalKind: "local-dev" };
  }
  const token = sessionTokenFromRequest(request); if (!token) return null;
  const session = await resolveDashboardSession(env.DB, token); if (!session) return null;
  return { userId: session.userId, role: session.role, displayName: session.displayName, identity: session.identity, principalKind: "dashboard-session" };
}

const policyRanks={disabled:0,approval:1,automatic:2} as const;
export function policyMutationPermission(currentMode:keyof typeof policyRanks,nextMode:keyof typeof policyRanks,currentConstraints?:unknown,nextConstraints?:unknown):"policy.narrow"|"policy.widen"{
  if(policyRanks[nextMode]>policyRanks[currentMode])return "policy.widen";
  if(policyRanks[nextMode]<policyRanks[currentMode])return "policy.narrow";
  if(currentConstraints===undefined&&nextConstraints===undefined)return "policy.narrow";
  return canonicalJson(currentConstraints)===canonicalJson(nextConstraints)?"policy.narrow":"policy.widen";
}

export interface OperationPolicyCas { operation:string; expectedMode:keyof typeof policyRanks; nextMode:keyof typeof policyRanks; }
export interface PolicyAuditActor { actor:string; actorUserId:string|null; actorIdentityJson:string; }
export async function compareAndSetOperationPolicies(db:D1Database,changes:readonly OperationPolicyCas[],audit:PolicyAuditActor):Promise<"updated"|"conflict">{
  const actionable=changes.filter(change=>change.expectedMode!==change.nextMode); if(actionable.length===0)return "updated";
  const stalePredicate=actionable.map(()=>"(operation_kind=? AND mode<>?)").join(" OR ");
  const guardValues=actionable.flatMap(change=>[change.operation,change.expectedMode]);
  let results;
  try {
    results=await db.batch([
      db.prepare(`UPDATE operation_policies SET mode=NULL WHERE ${stalePredicate}`).bind(...guardValues),
      ...actionable.map(change=>db.prepare("UPDATE operation_policies SET mode=?, updated_at=CURRENT_TIMESTAMP WHERE operation_kind=? AND mode=?").bind(change.nextMode,change.operation,change.expectedMode)),
      ...actionable.map((change) => db.prepare(
        "INSERT INTO audit_records(actor,actor_user_id,actor_identity_json,action,resource_type,resource_id,detail_json) " +
        "SELECT ?,?,?,'policy.updated','operation',?,? WHERE EXISTS (" +
        "SELECT 1 FROM operation_policies WHERE operation_kind=? AND mode=?)",
      ).bind(
        audit.actor,
        audit.actorUserId,
        audit.actorIdentityJson,
        change.operation,
        canonicalJson({ mode: change.nextMode }),
        change.operation,
        change.nextMode,
      )),
    ]);
  } catch(originalError){
    try {
      const placeholders=actionable.map(()=>"?").join(",");
      const current=(await db.prepare(`SELECT operation_kind,mode FROM operation_policies WHERE operation_kind IN (${placeholders})`).bind(...actionable.map(change=>change.operation)).all<{operation_kind:string;mode:keyof typeof policyRanks}>()).results;
      const modes=new Map(current.map(row=>[row.operation_kind,row.mode]));
      if(actionable.some(change=>modes.get(change.operation)!==change.expectedMode))return "conflict";
    } catch { /* preserve the original infrastructure failure */ }
    throw originalError;
  }
  if(actionable.some((_,index)=>(results[index+1]?.meta.changes??0)!==1))throw new Error("Atomic policy compare-and-set changed an unexpected row count");
  return "updated";
}

export async function resolveMcpAuthorization(db:D1Database,expectedInstanceId:string,principal:GardenerMcpPrincipal):Promise<ActiveGardenerMcpPrincipal|null>{
  if(principal.owner.instanceId!==expectedInstanceId)return null;
  const active=await activePrincipalBySubject(db,principal.owner.githubUserId);
  if(!active||active.role!=="owner")return null;
  return {...principal,userId:active.userId,role:"owner",principalKind:"mcp-token",owner:{...principal.owner,githubLogin:active.identity.login}};
}

export function requirePermission(
  c: Context<{ Bindings: Env; Variables: AuthorizationVariables }>,
  permission: WorkspacePermission,
  principalKinds: readonly PrincipalKind[] = ["dashboard-session"],
): Response | null {
  const principal = c.get("authorization");
  if (!principal) return c.json({ error: "authentication_required", message: "Authentication required" }, 401);
  if (!principalKinds.includes(principal.principalKind) || !workspaceRoleHasPermission(principal.role, permission)) {
    return c.json({ error: "forbidden", message: "Permission denied" }, 403);
  }
  return null;
}

export function auditActor(principal: AuthorizationContext): { actor: string; actorUserId: string | null; actorIdentityJson: string } {
  return { actor: principal.displayName, actorUserId: principal.principalKind === "local-dev" ? null : principal.userId, actorIdentityJson: JSON.stringify(principal.identity) };
}
