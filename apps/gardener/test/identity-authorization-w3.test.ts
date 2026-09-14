/// <reference types="node" />
import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { beforeAll, describe, expect, it } from "vitest";
import { consumeIdentityAssertion, dashboardSessionPayload, IdentityExchangeError, issueDashboardSession, resolveDashboardSession } from "../src/identity";
import { compareAndSetOperationPolicies, policyMutationPermission, resolveMcpAuthorization } from "../src/authorization";
import type { GardenerMcpPrincipal } from "../src/mcp/services";
import type { VerifiedIdentityAssertion } from "../src/auth";
import { d1Database } from "./persistence-test-db";

beforeAll(() => { if (!globalThis.crypto) Object.defineProperty(globalThis, "crypto", { value: webcrypto }); });
const migration=(name:string)=>readFileSync(new URL(`../migrations/${name}`,import.meta.url),"utf8");
function database(){ const sqlite=new DatabaseSync(":memory:"); sqlite.exec(migration("0001_initial.sql")); sqlite.exec("INSERT INTO gardener_schema(singleton,version)VALUES(1,4)"); sqlite.exec(migration("0005_agent_runtime_admission.sql")); sqlite.exec(migration("0006_flue_harness_requests.sql")); sqlite.exec(migration("0007_team_workspace_foundation.sql")); return {sqlite,db:d1Database(sqlite)}; }
function assertion(sub:string,jti:string,instanceOwner=false,login=`user-${sub}`):VerifiedIdentityAssertion{return {typ:"gardener-identity",sub,instanceId:"instance-1",githubLogin:login,instanceOwner,jti,iss:"https://connect.example",aud:"instance-1",iat:1,exp:4_000_000_000};}

describe("W3 identity exchange and opaque sessions",()=>{
  it("classifies policy narrowing, widening, no-ops, and capability constraint changes",()=>{
    expect(policyMutationPermission("automatic","approval")).toBe("policy.narrow"); expect(policyMutationPermission("disabled","approval")).toBe("policy.widen"); expect(policyMutationPermission("approval","approval")).toBe("policy.narrow"); expect(policyMutationPermission("approval","approval",{b:2,a:1},{a:1,b:2})).toBe("policy.narrow"); expect(policyMutationPermission("approval","approval",{a:1},{a:2})).toBe("policy.widen"); expect(policyMutationPermission("automatic","disabled",{a:1},{a:2})).toBe("policy.narrow");
  });
  it("compare-and-sets policy modes, rolls back mixed stale batches, and treats no-ops as success",async()=>{const {sqlite,db}=database();try{
    sqlite.prepare("UPDATE operation_policies SET mode='automatic' WHERE operation_kind='issue.comment.create'").run(); sqlite.prepare("UPDATE operation_policies SET mode='approval' WHERE operation_kind='issue.close'").run();
    const audit={actor:"Owner Name",actorUserId:null,actorIdentityJson:'{"provider":"github","providerSubject":"101","login":"owner"}'};
    await expect(compareAndSetOperationPolicies(db,[{operation:"issue.comment.create",expectedMode:"automatic",nextMode:"approval"}],audit)).resolves.toBe("updated"); expect(sqlite.prepare("SELECT mode FROM operation_policies WHERE operation_kind='issue.comment.create'").get()).toEqual({mode:"approval"}); expect(sqlite.prepare("SELECT actor,detail_json FROM audit_records WHERE action='policy.updated'").get()).toEqual({actor:"Owner Name",detail_json:'{"mode":"approval"}'});
    await expect(compareAndSetOperationPolicies(db,[{operation:"issue.comment.create",expectedMode:"approval",nextMode:"disabled"},{operation:"issue.close",expectedMode:"automatic",nextMode:"disabled"}],audit)).resolves.toBe("conflict"); expect(sqlite.prepare("SELECT mode FROM operation_policies WHERE operation_kind='issue.comment.create'").get()).toEqual({mode:"approval"}); expect(sqlite.prepare("SELECT mode FROM operation_policies WHERE operation_kind='issue.close'").get()).toEqual({mode:"approval"}); expect(sqlite.prepare("SELECT COUNT(*) count FROM audit_records WHERE action='policy.updated'").get()).toEqual({count:1});
    await expect(compareAndSetOperationPolicies(db,[{operation:"issue.close",expectedMode:"approval",nextMode:"disabled"}],{...audit,actorIdentityJson:"not-json"})).rejects.toBeTruthy(); expect(sqlite.prepare("SELECT mode FROM operation_policies WHERE operation_kind='issue.close'").get()).toEqual({mode:"approval"}); expect(sqlite.prepare("SELECT COUNT(*) count FROM audit_records WHERE action='policy.updated'").get()).toEqual({count:1});
    await expect(compareAndSetOperationPolicies(db,[{operation:"issue.close",expectedMode:"approval",nextMode:"approval"}],audit)).resolves.toBe("updated"); expect(sqlite.prepare("SELECT COUNT(*) count FROM audit_records WHERE action='policy.updated'").get()).toEqual({count:1});
    sqlite.prepare("DELETE FROM operation_policies WHERE operation_kind='issue.reopen'").run();
    await expect(compareAndSetOperationPolicies(db,[{operation:"issue.reopen",expectedMode:"disabled",nextMode:"approval"}],audit)).rejects.toThrow(/unexpected row count/);
    expect(sqlite.prepare("SELECT COUNT(*) count FROM audit_records WHERE action='policy.updated'").get()).toEqual({count:1});
  }finally{sqlite.close();}});

  it("bootstraps only the signed owner, is idempotent across assertions, and consumes each jti once",async()=>{const {sqlite,db}=database();try{
    sqlite.prepare("INSERT INTO consumed_identity_assertions(issuer,jti_hash,subject,expires_at)VALUES('old',?,'999',1)").run("f".repeat(64));
    const owner=await consumeIdentityAssertion(db,assertion("101","identity_owner_first",true),"https://connect.example"); expect(sqlite.prepare("SELECT COUNT(*) count FROM consumed_identity_assertions WHERE issuer='old'").get()).toEqual({count:0}); expect(owner.role).toBe("owner"); expect(owner.permanent).toBe(true); expect(dashboardSessionPayload(owner)).toMatchObject({authenticated:true,githubLogin:"user-101",user:{role:"owner",identity:{providerSubject:"101"}}});
    await expect(consumeIdentityAssertion(db,assertion("101","identity_owner_first",true),"https://connect.example")).rejects.toMatchObject({code:"identity_assertion_replayed"} satisfies Partial<IdentityExchangeError>);
    const concurrent=await Promise.allSettled([consumeIdentityAssertion(db,assertion("101","identity_concurrent",true),"https://connect.example"),consumeIdentityAssertion(db,assertion("101","identity_concurrent",true),"https://connect.example")]);
    expect(concurrent.filter(result=>result.status==="fulfilled")).toHaveLength(1); expect(concurrent.filter(result=>result.status==="rejected")).toHaveLength(1);
    await expect(consumeIdentityAssertion(db,assertion("202","identity_other_owner",true),"https://connect.example")).rejects.toMatchObject({code:"identity_not_authorized"} satisfies Partial<IdentityExchangeError>);
    expect(sqlite.prepare("SELECT COUNT(*) count FROM users WHERE id='user_github_202'").get()).toEqual({count:0}); expect(sqlite.prepare("SELECT COUNT(*) count FROM external_identities WHERE provider_subject='202'").get()).toEqual({count:0});
    expect(sqlite.prepare("SELECT COUNT(*) count FROM consumed_identity_assertions WHERE subject='202'").get()).toEqual({count:1});
    expect(sqlite.prepare("SELECT COUNT(*) count FROM memberships WHERE role='owner'").get()).toEqual({count:1});
    expect((await consumeIdentityAssertion(db,assertion("101","identity_owner_second",true),"https://connect.example")).userId).toBe(owner.userId);
  }finally{sqlite.close();}});

  it("accepts invitations by immutable numeric subject while login snapshots may change",async()=>{const {sqlite,db}=database();try{
    const owner=await consumeIdentityAssertion(db,assertion("101","identity_owner_invites",true,"owner"),"https://connect.example");
    sqlite.prepare("INSERT INTO invitations(id,provider,provider_subject,username,invited_by_user_id)VALUES('invite-1','github','202','old-login',?)").run(owner.userId);
    const member=await consumeIdentityAssertion(db,assertion("202","identity_member_renamed",false,"new-login"),"https://connect.example"); expect(member.role).toBe("member"); expect(member.identity.login).toBe("new-login");
    expect(sqlite.prepare("SELECT status,accepted_by_user_id FROM invitations WHERE id='invite-1'").get()).toEqual({status:"accepted",accepted_by_user_id:member.userId});
    expect(sqlite.prepare("SELECT COUNT(*) count FROM audit_records WHERE action='membership.invitation_accepted'").get()).toEqual({count:1});
    await expect(consumeIdentityAssertion(db,assertion("303","identity_recycled_login",false,"old-login"),"https://connect.example")).rejects.toMatchObject({code:"identity_not_authorized"});
    expect(sqlite.prepare("SELECT COUNT(*) count FROM users WHERE id='user_github_303'").get()).toEqual({count:0}); expect(sqlite.prepare("SELECT COUNT(*) count FROM external_identities WHERE provider_subject='303'").get()).toEqual({count:0});
    expect(sqlite.prepare("SELECT actor,actor_user_id FROM audit_records WHERE action='membership.invitation_accepted'").get()).toEqual({actor:"new-login",actor_user_id:member.userId});
  }finally{sqlite.close();}});

  it("stores only a session hash, expires/revokes it, and never persists the assertion",async()=>{const {sqlite,db}=database();try{
    const principal=await consumeIdentityAssertion(db,assertion("101","identity_session_assertion",true),"https://connect.example"); const issued=await issueDashboardSession(db,principal,true,1000);
    expect(issued.cookieName).toBe("__Host-gardener_session"); expect(sqlite.prepare("SELECT token_hash FROM dashboard_sessions").get()).not.toEqual({token_hash:issued.token});
    expect(JSON.stringify(sqlite.prepare("SELECT * FROM dashboard_sessions").all())).not.toContain("identity_session_assertion"); expect(await resolveDashboardSession(db,issued.token,1400)).not.toBeNull(); expect(await resolveDashboardSession(db,issued.token,3000)).not.toBeNull(); expect(await resolveDashboardSession(db,issued.token,5000)).toBeNull();
    const active=await issueDashboardSession(db,principal,false,4000); expect(active.cookieName).toBe("gardener_session"); await db.prepare("UPDATE dashboard_sessions SET revoked_at=CURRENT_TIMESTAMP WHERE user_id=?").bind(principal.userId).run(); expect(await resolveDashboardSession(db,active.token,4001)).toBeNull();
  }finally{sqlite.close();}});

  it("re-resolves MCP tokens to the current owner and rejects members and wrong instances",async()=>{const {sqlite,db}=database();try{
    const owner=await consumeIdentityAssertion(db,assertion("101","identity_mcp_owner",true,"current-owner"),"https://connect.example"); sqlite.prepare("INSERT INTO users(id,display_name)VALUES('member','Member')").run(); sqlite.prepare("INSERT INTO external_identities(id,user_id,provider,provider_subject,username)VALUES('member-id','member','github','202','member')").run(); sqlite.prepare("INSERT INTO memberships(id,user_id,role)VALUES('member-membership','member','member')").run();
    const token=(subject:string,instanceId="instance-1"):GardenerMcpPrincipal=>({clientId:"client",audience:"https://gardener.test/mcp",grantedScopes:[],owner:{githubUserId:subject,githubLogin:"stale",instanceId}});
    await expect(resolveMcpAuthorization(db,"instance-1",token("101"))).resolves.toMatchObject({userId:owner.userId,role:"owner",principalKind:"mcp-token",owner:{githubLogin:"current-owner"}}); await expect(resolveMcpAuthorization(db,"instance-1",token("101","wrong"))).resolves.toBeNull(); await expect(resolveMcpAuthorization(db,"instance-1",token("202"))).resolves.toBeNull(); sqlite.prepare("DELETE FROM external_identities WHERE provider_subject='101'").run(); await expect(resolveMcpAuthorization(db,"instance-1",token("101"))).resolves.toBeNull();
  }finally{sqlite.close();}});
});
