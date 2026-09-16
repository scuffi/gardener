/// <reference types="node" />
import { describe,expect,it } from "vitest";
import { operationKindSchema,workspaceCapabilityValues } from "@gardener/contracts";
import { calculateAssignmentConfigHash } from "@gardener/core";
import { getRepositoryPolicy,putRepositoryPolicy,RepositoryPolicyReadError } from "../src/repository-policy";
import { activateAgentRevisionGuarded } from "../src/persistence/agents";
import { findAssignment,getAssignmentEpoch,writeAssignment,writeAssignmentsAtomic } from "../src/persistence/assignments";
import { d1Database,migration } from "./persistence-test-db";
import { DatabaseSync } from "node:sqlite";

function database(){const sqlite=new DatabaseSync(":memory:");sqlite.exec(migration());sqlite.exec(migration("0005_agent_runtime_admission.sql"));sqlite.exec(migration("0006_flue_harness_requests.sql"));sqlite.exec(migration("0007_team_workspace_foundation.sql"));sqlite.exec("INSERT INTO users(id,display_name)VALUES('owner','Owner'); INSERT INTO external_identities(id,user_id,provider,provider_subject,username)VALUES('identity','owner','github','1','owner'); INSERT INTO memberships(id,user_id,role,permanent)VALUES('membership','owner','owner',1); INSERT INTO repositories(id,installation_id,owner,name,default_branch,active)VALUES('10','20','acme','widgets','main',1); INSERT INTO agents(id,slug,name,created_by)VALUES('agent-one','one','One','owner')");return{sqlite,db:d1Database(sqlite)}}
const actor={actor:"Owner",actorUserId:"owner",actorIdentityJson:'{"provider":"github","providerSubject":"1","login":"owner"}'};
function disabledPolicyInput(view:NonNullable<Awaited<ReturnType<typeof getRepositoryPolicy>>>) {return {
  expectedPolicyVersion:view.policyVersion,expectedPolicyHash:view.configured?view.policyHash:null,
  operationModes:Object.fromEntries(operationKindSchema.options.map(key=>[key,"disabled"])) as any,
  allowedObservations:[],workspaceModes:Object.fromEntries(workspaceCapabilityValues.map(key=>[key,"disabled"])) as any,
};}

describe("W5A assignment and repository policy persistence",()=>{
  it("creates dark, canonical assignments and reuses the row on re-add",async()=>{const{sqlite,db}=database();try{
    expect(await getAssignmentEpoch(db)).toBe(1);
    const added=await writeAssignment(db,{id:"assignment-one",agentId:"agent-one",repositoryId:"10",enabled:false,authorityCeiling:"approval",removedAt:null,expectedEpoch:1,action:"added",details:{action:"added",agentId:"agent-one",repositoryId:"10"},actor,actorUserId:"owner"});
    expect(added).toMatchObject({id:"assignment-one",version:1,enabled:false,removedAt:null});expect(added!.configHash).toBe(await calculateAssignmentConfigHash(added!));
    const removed=await writeAssignment(db,{id:added!.id,agentId:added!.agentId,repositoryId:added!.repositoryId,enabled:false,authorityCeiling:added!.authorityCeiling,removedAt:new Date().toISOString(),expectedEpoch:2,expectedVersion:1,expectedConfigHash:added!.configHash,action:"removed",details:{action:"removed"},actor,actorUserId:"owner"});
    const readded=await writeAssignment(db,{id:removed!.id,agentId:removed!.agentId,repositoryId:removed!.repositoryId,enabled:false,authorityCeiling:removed!.authorityCeiling,removedAt:null,expectedEpoch:3,expectedVersion:2,expectedConfigHash:removed!.configHash,action:"added",details:{action:"added",agentId:"agent-one",repositoryId:"10"},actor,actorUserId:"owner"});
    expect(readded).toMatchObject({id:"assignment-one",version:3,enabled:false,removedAt:null});expect(await getAssignmentEpoch(db)).toBe(4);expect(sqlite.prepare("SELECT count(*) count FROM agent_repository_assignment_history").get()).toEqual({count:3});
  }finally{sqlite.close()}});
  it("keeps a stale second row from partially materializing an assignment batch",async()=>{const{sqlite,db}=database();try{
    sqlite.prepare("INSERT INTO repositories(id,installation_id,owner,name,default_branch,active)VALUES('11','20','acme','tools','main',1)").run();
    const added=await writeAssignment(db,{id:"assignment-existing",agentId:"agent-one",repositoryId:"11",enabled:false,authorityCeiling:"approval",removedAt:null,expectedEpoch:1,action:"added",details:{action:"added",agentId:"agent-one",repositoryId:"11"},actor,actorUserId:"owner"});
    const removed=await writeAssignment(db,{id:added!.id,agentId:"agent-one",repositoryId:"11",enabled:false,authorityCeiling:"approval",removedAt:new Date().toISOString(),expectedEpoch:2,expectedVersion:1,expectedConfigHash:added!.configHash,action:"removed",details:{action:"removed"},actor,actorUserId:"owner"});
    const result=await writeAssignmentsAtomic(db,[{id:"assignment-new",agentId:"agent-one",repositoryId:"10",enabled:false,authorityCeiling:"approval",removedAt:null,expectedEpoch:3,action:"added",details:{action:"added",agentId:"agent-one",repositoryId:"10"},actor,actorUserId:"owner"},{id:removed!.id,agentId:"agent-one",repositoryId:"11",enabled:false,authorityCeiling:"approval",removedAt:null,expectedEpoch:3,expectedVersion:1,expectedConfigHash:added!.configHash,action:"added",details:{action:"added",agentId:"agent-one",repositoryId:"11"},actor,actorUserId:"owner"}]);
    expect(result).toBeNull();expect(await findAssignment(db,"agent-one","10")).toBeNull();expect(await getAssignmentEpoch(db)).toBe(3);expect(sqlite.prepare("SELECT COUNT(*) count FROM agent_repository_assignment_history").get()).toEqual({count:2});expect(sqlite.prepare("SELECT COUNT(*) count FROM audit_records WHERE action='assignment.updated'").get()).toEqual({count:2});
  }finally{sqlite.close()}});
  it("classifies a disappeared activation candidate as a stable conflict without consuming the epoch",async()=>{const{sqlite,db}=database();try{
    const result=await activateAgentRevisionGuarded(db,{historyId:"activation-one",agentId:"agent-one",revisionId:"missing-revision",expectedRevisionId:null,expectedEpoch:1,actorId:"owner",reason:null,actor});expect(result).toBeNull();expect(await getAssignmentEpoch(db)).toBe(1);expect(sqlite.prepare("SELECT COUNT(*) count FROM agent_activation_history").get()).toEqual({count:0});expect(sqlite.prepare("SELECT COUNT(*) count FROM audit_records WHERE action='agent.revision.activated'").get()).toEqual({count:0});
  }finally{sqlite.close()}});
  it("fails a stale epoch closed and resolves a missing repository policy as disabled",async()=>{const{sqlite,db}=database();try{
    const stale=await writeAssignment(db,{id:"assignment-one",agentId:"agent-one",repositoryId:"10",enabled:false,authorityCeiling:"disabled",removedAt:null,expectedEpoch:9,action:"added",details:{action:"added",agentId:"agent-one",repositoryId:"10"},actor,actorUserId:"owner"});expect(stale).toBeNull();expect(await findAssignment(db,"agent-one","10")).toBeNull();expect(await getAssignmentEpoch(db)).toBe(1);
    const view=await getRepositoryPolicy(db,"10");expect(view).toMatchObject({configured:false,message:"Policy not configured — Agent runs have no effect authority"});expect(Object.values(view!.policy.operationModes).every(mode=>mode==="disabled")).toBe(true);
    const updated=await putRepositoryPolicy(db,"10",disabledPolicyInput(view!),actor);expect(updated).toBe("updated");expect(await getRepositoryPolicy(db,"10")).toMatchObject({configured:true,policyVersion:2,policy:{version:2}});
  }finally{sqlite.close()}});
  it("keeps repository-local generations and hashes stable when another repository changes",async()=>{const{sqlite,db}=database();try{
    sqlite.prepare("INSERT INTO repositories(id,installation_id,owner,name,default_branch,active)VALUES('11','20','acme','tools','main',1)").run();
    const missingA=(await getRepositoryPolicy(db,"10"))!;expect(await putRepositoryPolicy(db,"10",disabledPolicyInput(missingA),actor)).toBe("updated");
    const configuredA=(await getRepositoryPolicy(db,"10"))!;expect(configuredA).toMatchObject({configured:true,policyVersion:2,policy:{version:2}});
    const missingB=(await getRepositoryPolicy(db,"11"))!;expect(missingB.policyVersion).toBe(2);expect(await putRepositoryPolicy(db,"11",disabledPolicyInput(missingB),actor)).toBe("updated");
    const afterB=(await getRepositoryPolicy(db,"10"))!;expect(afterB.policyVersion).toBe(3);expect(afterB.policy.version).toBe(configuredA.policy.version);expect(afterB.policyHash).toBe(configuredA.policyHash);
    const changed={...disabledPolicyInput(afterB),operationModes:{...afterB.policy.operationModes,[operationKindSchema.options[0]!]:"automatic" as const} as any};
    expect(await putRepositoryPolicy(db,"10",changed,actor)).toBe("updated");
    const afterA=(await getRepositoryPolicy(db,"10"))!;expect(afterA.policyVersion).toBe(4);expect(afterA.policy.version).toBe(4);expect(afterA.policy.version).not.toBe(afterB.policy.version);expect(afterA.policyHash).not.toBe(afterB.policyHash);
  }finally{sqlite.close()}});
  it("fails closed with stable codes for mixed versions and unknown rows",async()=>{const{sqlite,db}=database();try{
    const missing=(await getRepositoryPolicy(db,"10"))!;expect(await putRepositoryPolicy(db,"10",disabledPolicyInput(missing),actor)).toBe("updated");
    sqlite.prepare("UPDATE repository_operation_policies SET policy_version=1 WHERE repository_id='10' AND operation_kind=?").run(operationKindSchema.options[0]!);
    await expect(getRepositoryPolicy(db,"10")).rejects.toMatchObject({
      name: "RepositoryPolicyReadError",
      code: "repository_policy_version_invalid",
    } satisfies Partial<RepositoryPolicyReadError>);
    sqlite.prepare("UPDATE repository_operation_policies SET policy_version=2 WHERE repository_id='10'").run();
    sqlite.prepare("INSERT INTO operation_policies(operation_kind,mode)VALUES('future.operation','disabled')").run();
    sqlite.prepare("INSERT INTO repository_operation_policies(repository_id,operation_kind,mode,policy_version)VALUES('10','future.operation','disabled',2)").run();
    await expect(getRepositoryPolicy(db,"10")).rejects.toMatchObject({
      name: "RepositoryPolicyReadError",
      code: "repository_operation_policy_invalid",
    } satisfies Partial<RepositoryPolicyReadError>);
    sqlite.prepare("DELETE FROM repository_operation_policies WHERE repository_id='10' AND operation_kind='future.operation'").run();
    sqlite.prepare("INSERT INTO instance_capability_policies(capability_kind,mode)VALUES('future.capability','disabled')").run();
    sqlite.prepare("INSERT INTO repository_capability_policies(repository_id,capability_kind,mode,policy_version)VALUES('10','future.capability','disabled',2)").run();
    await expect(getRepositoryPolicy(db,"10")).rejects.toMatchObject({
      name: "RepositoryPolicyReadError",
      code: "repository_capability_policy_invalid",
    } satisfies Partial<RepositoryPolicyReadError>);
  }finally{sqlite.close()}});
  it("keeps a partial known policy disabled and lets the owner repair it",async()=>{const{sqlite,db}=database();try{
    sqlite.prepare("INSERT INTO repository_operation_policies(repository_id,operation_kind,mode,policy_version)VALUES('10',?,'automatic',1)").run(operationKindSchema.options[0]!);
    const partial=(await getRepositoryPolicy(db,"10"))!;expect(partial).toMatchObject({configured:false,policyVersion:1,policy:{version:1}});expect(Object.values(partial.policy.operationModes).every(mode=>mode==="disabled")).toBe(true);
    expect(await putRepositoryPolicy(db,"10",disabledPolicyInput(partial),actor)).toBe("updated");
    const repaired=(await getRepositoryPolicy(db,"10"))!;expect(repaired).toMatchObject({configured:true,policyVersion:2,policy:{version:2}});expect(Object.values(repaired.policy.operationModes).every(mode=>mode==="disabled")).toBe(true);
  }finally{sqlite.close()}});
});
