import { describe, expect, it } from "vitest";
import type { AgentRunSnapshotV1, RepositoryEventV2 } from "@gardener/contracts";
import { constructExactCommentEffect, frozenIssueCommentMode } from "../src/harness/flue/terminal-tool";

const event:RepositoryEventV2={schemaVersion:"v2",id:"event-one",deliveryId:"delivery-one",instanceId:"instance-one",occurredAt:"2026-09-15T00:00:00.000Z",
  repository:{provider:"github",id:"101",installationId:"201",owner:"acme",name:"widgets",defaultBranch:"main"},kind:"github.issue",action:"opened",
  actor:{id:"301",login:"actor",accountType:"User"},resourceAuthor:{id:"302",login:"author",accountType:"User"},
  issue:{id:"issue-one",number:1,title:"A useful title",body:"A useful body",state:"open",labels:[],locked:false,
    updatedAt:"2026-09-15T00:00:00.000Z",htmlUrl:"https://github.com/acme/widgets/issues/1"}};

describe("Flue terminal exact-effect compatibility",()=>{
  it.each(["disabled", "approval", "automatic"] as const)("reads %s execution authority from the frozen snapshot without gating the model run",(mode)=>{
    const snapshot={effectiveCapabilities:{effects:[{capability:"issue.comment.create",mode}]}} as AgentRunSnapshotV1;
    expect(frozenIssueCommentMode(snapshot)).toBe(mode);
  });

  it("defaults missing frozen comment authority to disabled",()=>{
    const snapshot={effectiveCapabilities:{effects:[]}} as unknown as AgentRunSnapshotV1;
    expect(frozenIssueCommentMode(snapshot)).toBe("disabled");
  });

  it("preserves operation id, canonical hash, effect id, and marker bytes",async()=>{
    const result=await constructExactCommentEffect("run_golden",event,{kind:"issue_comment_proposal",body:"Hello",rationale:"Useful"});
    const operationId="op_1a697c9bbcdd6e94d0d8b6aab8cf9942f8e70ca340411f78f6f89228e42ef399";
    expect(result).toEqual({
      effectId:"effect_b908e0b30f3f39176f6b20333c592a759d1d4104ebbfd4b7acef62da3e735d06",
      operationHash:"b908e0b30f3f39176f6b20333c592a759d1d4104ebbfd4b7acef62da3e735d06",
      operation:{schemaVersion:"v2",id:operationId,kind:"issue.comment.create",repository:event.repository,issueNumber:1,
        expectedIssueState:"open",expectedIssueUpdatedAt:event.issue.updatedAt,
        body:`Hello\n<!-- gardener-operation:${operationId} -->`},
    });
  });
});
