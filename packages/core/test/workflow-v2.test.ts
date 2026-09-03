import { describe, expect, it } from "vitest";
import { compileWorkflowV2 } from "../src";

const spec = {
  name: "Issue triage",
  description: "Classify new and reopened issues.",
  triggers: [{ kind: "github.issue" as const, actions: ["opened" as const, "reopened" as const] }],
  repositoryIds: ["1318443351"],
  condition: null,
  runtime: { kind: "workers-ai.issue-gardener" as const, model: "deployment-default" as const, instructions: "Classify issues." },
  capabilities: { read: ["issue" as const], propose: ["issue.label.add" as const, "issue.comment.create" as const] },
};

describe("v2 workflow compilation", () => {
  it("creates deterministic content and plan hashes while resolving immutable runtime values", async () => {
    const first = await compileWorkflowV2(spec, {
      workflowId: "issue-triage",
      revision: 1,
      resolvedModel: "@cf/meta/model",
      now: () => new Date("2026-09-03T12:00:00.000Z"),
    });
    const second = await compileWorkflowV2(spec, {
      workflowId: "issue-triage",
      revision: 1,
      resolvedModel: "@cf/meta/model",
      now: () => new Date("2026-09-04T12:00:00.000Z"),
    });

    expect(first.definition.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.definition.contentHash).toBe(second.definition.contentHash);
    expect(first.plan.planId).toBe(second.plan.planId);
    expect(first.plan.compiledAt).not.toBe(second.plan.compiledAt);
    expect(first.plan.triggers).toEqual(["github.issue.opened", "github.issue.reopened"]);
    expect(first.plan.runtime.resolvedModel).toBe("@cf/meta/model");
    expect(first.plan).not.toHaveProperty("policy");
    expect(Object.isFrozen(first.plan.runtime)).toBe(true);
  });

  it("changes the plan identity when the resolved model changes without changing source content identity", async () => {
    const one = await compileWorkflowV2(spec, { workflowId: "issue-triage", revision: 1, resolvedModel: "model-one" });
    const two = await compileWorkflowV2(spec, { workflowId: "issue-triage", revision: 1, resolvedModel: "model-two" });
    expect(one.definition.contentHash).toBe(two.definition.contentHash);
    expect(one.plan.planId).not.toBe(two.plan.planId);
  });

  it("blocks unsupported runtime, trigger, operation, workspace, and condition capabilities at activation", async () => {
    await expect(compileWorkflowV2({ ...spec, triggers: [{ kind: "manual" }] }, { workflowId: "manual", revision: 1, resolvedModel: "model" })).rejects.toThrow(/not available/);
    await expect(compileWorkflowV2({ ...spec, triggers: [{ kind: "github.pull_request", actions: ["opened"] }] }, { workflowId: "pr", revision: 1, resolvedModel: "model" })).rejects.toThrow(/only supports GitHub issue/);
    await expect(compileWorkflowV2({ ...spec, capabilities: { read: ["issue"], propose: ["pull_request.merge"] } }, { workflowId: "merge", revision: 1, resolvedModel: "model" })).rejects.toThrow(/only supports issue operations/);
    await expect(compileWorkflowV2({ ...spec, workspace: { enabled: true, experimental: true, network: "denied", allowedHosts: [] } }, { workflowId: "workspace", revision: 1, resolvedModel: "model" })).rejects.toThrow(/not available/);
    await expect(compileWorkflowV2({ ...spec, condition: { kind: "predicate", capabilityId: "github.pull_request.checks.all_required_passed@v1", operator: "equals", expected: true } }, { workflowId: "checks", revision: 1, resolvedModel: "model" })).rejects.toThrow(/capability_unavailable/);
  });
});
