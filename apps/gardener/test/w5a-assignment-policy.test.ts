/// <reference types="node" />
import { describe,expect,it } from "vitest";
import { calculateAssignmentConfigHash } from "@gardener/core";
import { getRepositoryPolicy,putRepositoryPolicy } from "../src/repository-policy";
import { activateAgentRevisionGuarded } from "../src/persistence/agents";
import { findAssignment,getAssignmentEpoch,writeAssignment,writeAssignmentsAtomic } from "../src/persistence/assignments";
import { d1Database,migration } from "./persistence-test-db";
import { DatabaseSync } from "node:sqlite";

function database(){const sqlite=new DatabaseSync(":memory:");sqlite.exec(migration());sqlite.exec(migration("0005_agent_runtime_admission.sql"));sqlite.exec(migration("0006_flue_harness_requests.sql"));sqlite.exec(migration("0007_team_workspace_foundation.sql"));sqlite.exec("INSERT INTO users(id,display_name)VALUES('owner','Owner'); INSERT INTO external_identities(id,user_id,provider,provider_subject,username)VALUES('identity','owner','github','1','owner'); INSERT INTO memberships(id,user_id,role,permanent)VALUES('membership','owner','owner',1); INSERT INTO repositories(id,installation_id,owner,name,default_branch,active)VALUES('10','20','acme','widgets','main',1); INSERT INTO agents(id,slug,name,created_by)VALUES('agent-one','one','One','owner')");return{sqlite,db:d1Database(sqlite)}}
const actor={actor:"Owner",actorUserId:"owner",actorIdentityJson:'{"provider":"github","providerSubject":"1","login":"owner"}'};

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
    const view=await getRepositoryPolicy(db,"10");expect(view).toMatchObject({configured:false,message:"Policy not configured — nothing will run"});expect(Object.values(view!.policy.operationModes).every(mode=>mode==="disabled")).toBe(true);
    const updated=await putRepositoryPolicy(db,"10",{expectedPolicyVersion:1,expectedPolicyHash:null,operationModes:Object.fromEntries(Object.keys(view!.policy.operationModes).map(key=>[key,"disabled"])) as any,allowedObservations:[],workspaceModes:Object.fromEntries(Object.keys(view!.workspaceCeilings.workspaceModes).filter(key=>key.startsWith("workspace.")).map(key=>[key,"disabled"])) as any},actor);expect(updated).toBe("updated");expect(await getRepositoryPolicy(db,"10")).toMatchObject({configured:true,policyVersion:2});
  }finally{sqlite.close()}});
});
