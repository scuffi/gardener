import { describe, expect, it } from "vitest";
import {
  WORKFLOW_CONDITION_MAX_DEPTH,
  WORKFLOW_CONDITION_MAX_NODES,
  WORKFLOW_CONDITION_MAX_PREDICATES,
  compiledWorkflowPlanV2Schema,
  workflowConditionSchema,
  workflowDefinitionSchema,
  workflowDefinitionV2Schema,
  workflowSpecV2Schema,
} from "../src";

const repositoryIdPredicate = {
  kind: "predicate" as const,
  capabilityId: "github.repository.id@v1" as const,
  operator: "equals" as const,
  expected: "1318443351",
};

const spec = {
  name: "Issue triage",
  description: "Classify new and reopened issues.",
  triggers: [{ kind: "github.issue" as const, actions: ["opened" as const, "reopened" as const] }],
  repositoryIds: ["1318443351"],
  condition: repositoryIdPredicate,
  runtime: { kind: "workers-ai.issue-gardener" as const, model: "deployment-default" as const, instructions: "Classify new issues." },
  capabilities: { read: ["issue" as const], propose: ["issue.label.add" as const] },
};
const hash = "a".repeat(64);
const v2 = { schemaVersion: "v2" as const, workflowId: "issue-triage", revision: 1, contentHash: hash, spec };

function nestedNot(depth: number): unknown {
  let condition: unknown = repositoryIdPredicate;
  for (let index = 1; index < depth; index += 1) condition = { kind: "not", condition };
  return condition;
}

describe("workflow definition v2", () => {
  it("preserves the existing v1 definition contract", () => {
    const parsed = workflowDefinitionSchema.parse({
      schemaVersion: "v1", id: "v1", name: "Existing", revision: 1, paused: true,
      triggers: [{ kind: "event", events: ["github.issue"] }], repositories: ["R1"],
      instructions: "Existing behavior", runtime: "workers-ai.issue-gardener", model: "model",
    });
    expect(parsed.schemaVersion).toBe("v1");
    expect(parsed.repositories).toEqual(["R1"]);
  });

  it("accepts strict client content and a server-owned v2 revision with explicit immutable repository ids", () => {
    expect(workflowSpecV2Schema.parse(spec)).toMatchObject({ repositoryIds: ["1318443351"], condition: repositoryIdPredicate });
    expect(workflowDefinitionV2Schema.parse(v2)).toMatchObject({ schemaVersion: "v2", workflowId: "issue-triage", revision: 1, spec: { repositoryIds: ["1318443351"] } });
    expect(() => workflowSpecV2Schema.parse({ ...spec, repositoryIds: ["*"] })).toThrow(/numeric GitHub id/);
    expect(() => workflowSpecV2Schema.parse({ ...spec, repositoryIds: ["1318443351", "1318443351"] })).toThrow(/unique/);
    expect(() => workflowSpecV2Schema.parse({ ...spec, paused: true })).toThrow();
    expect(() => workflowSpecV2Schema.parse({ ...spec, revision: 4 })).toThrow();
    expect(() => workflowSpecV2Schema.parse({ ...spec, policy: { "issue.label.add": "automatic" } })).toThrow();
    expect(() => workflowSpecV2Schema.parse({ ...spec, script: "fetch('https://example.com')" })).toThrow();
  });

  it("requires action-specific triggers and unique capabilities", () => {
    expect(() => workflowSpecV2Schema.parse({ ...spec, triggers: [{ kind: "github.issue", actions: [] }] })).toThrow();
    expect(() => workflowSpecV2Schema.parse({ ...spec, triggers: [{ kind: "github.issue", actions: ["opened", "opened"] }] })).toThrow(/unique/);
    expect(() => workflowSpecV2Schema.parse({ ...spec, triggers: [{ kind: "github.issue", actions: ["synchronize"] }] })).toThrow();
    expect(() => workflowSpecV2Schema.parse({ ...spec, capabilities: { read: ["issue", "issue"], propose: [] } })).toThrow(/unique/);
    expect(() => workflowSpecV2Schema.parse({ ...spec, capabilities: { read: [], propose: ["issue.label.add", "issue.label.add"] } })).toThrow(/unique/);
  });

  it("defines a policy-free immutable compiled-plan envelope", () => {
    const compiled = compiledWorkflowPlanV2Schema.parse({
      schemaVersion: "v2", planId: `plan_${hash}`, workflowId: "issue-triage", revision: 1, contentHash: hash,
      compiledAt: "2026-09-03T12:00:00.000Z", triggers: ["github.issue.opened", "github.issue.reopened"], repositoryIds: ["1318443351"],
      condition: repositoryIdPredicate,
      conditionResolver: { id: "signed-event-facts", version: 1, catalogVersion: "2026-09-03.1" },
      requiredGitHubPermissions: ["issues:write"],
      runtime: { kind: "workers-ai.issue-gardener", resolvedModel: "@cf/model", instructions: "Classify new issues." },
      capabilities: { read: ["issue"], propose: ["issue.label.add"] },
      workspace: { enabled: false, experimental: false, network: "denied", allowedHosts: [] },
      limits: { runtimeSeconds: 300, inputTokens: 32_000, outputTokens: 8_000, costUsd: 1, retries: 2, operations: 10 },
    });
    expect(compiled.triggers).toEqual(["github.issue.opened", "github.issue.reopened"]);
    expect(compiled).not.toHaveProperty("policy");
  });

  it("rejects unknown capabilities, arbitrary paths, regex, and incompatible expected values", () => {
    expect(() => workflowConditionSchema.parse({ ...repositoryIdPredicate, capabilityId: "github.event.actor.__proto__@v1" })).toThrow();
    expect(() => workflowConditionSchema.parse({ ...repositoryIdPredicate, path: "sender.id" })).toThrow();
    expect(() => workflowConditionSchema.parse({ ...repositoryIdPredicate, operator: "regex", expected: ".*" })).toThrow();
    expect(() => workflowConditionSchema.parse({ kind: "predicate", capabilityId: "github.pull_request.draft@v1", operator: "equals", expected: "false" })).toThrow(/incompatible/);
    expect(() => workflowConditionSchema.parse({ kind: "predicate", capabilityId: "github.event.actor.identity@v1", operator: "equals", expected: { id: "49699333", login: "dependabot[bot]", accountType: "Bot" } })).toThrow();
    expect(() => workflowConditionSchema.parse({ ...repositoryIdPredicate, operator: "contains" })).toThrow(/supported/);
    expect(() => workflowConditionSchema.parse({ kind: "predicate", capabilityId: "github.event.action@v1", operator: "equals", expected: "execute_script" })).toThrow(/incompatible/);
    expect(() => workflowConditionSchema.parse({ kind: "predicate", capabilityId: "github.event.action@v1", operator: "equals", expected: "x".repeat(256) })).toThrow();
    expect(() => workflowConditionSchema.parse({ kind: "predicate", capabilityId: "github.resource.labels@v1", operator: "contains_any", expected: Array.from({ length: 51 }, (_, index) => `label-${index}`) })).toThrow();
  });

  it("allows typed planned capabilities in drafts without treating unknown ids as known", () => {
    expect(workflowConditionSchema.parse({ kind: "predicate", capabilityId: "github.pull_request.checks.all_required_passed@v1", operator: "equals", expected: true })).toMatchObject({ expected: true });
    expect(workflowConditionSchema.parse({
      kind: "predicate",
      capabilityId: "gardener.time.weekly_window@v1",
      operator: "within_weekly_window",
      expected: { timezone: "America/Los_Angeles", weekdays: ["mon", "tue"], startMinute: 540, endMinute: 1_020 },
    })).toMatchObject({ expected: { timezone: "America/Los_Angeles", startMinute: 540 } });
    expect(() => workflowConditionSchema.parse({
      kind: "predicate",
      capabilityId: "gardener.time.weekly_window@v1",
      operator: "within_weekly_window",
      expected: { timezone: "UTC", weekdays: ["mon", "mon"], startMinute: 540, endMinute: 1_020 },
    })).toThrow(/unique/);
  });

  it("enforces depth, node, and predicate bounds before recursive parsing", () => {
    expect(workflowConditionSchema.parse(nestedNot(WORKFLOW_CONDITION_MAX_DEPTH))).toBeDefined();
    expect(() => workflowConditionSchema.parse(nestedNot(WORKFLOW_CONDITION_MAX_DEPTH + 1))).toThrow(/depth 8/);
    expect(() => workflowConditionSchema.parse(nestedNot(10_000))).toThrow(/depth 8/);

    const tooManyNodes = {
      kind: "all",
      conditions: Array.from({ length: WORKFLOW_CONDITION_MAX_NODES / 2 }, () => ({ kind: "not", condition: repositoryIdPredicate })),
    };
    expect(() => workflowConditionSchema.parse(tooManyNodes)).toThrow(/100 nodes/);

    const tooManyPredicates = {
      kind: "all",
      conditions: Array.from({ length: WORKFLOW_CONDITION_MAX_PREDICATES + 1 }, () => repositoryIdPredicate),
    };
    expect(() => workflowConditionSchema.parse(tooManyPredicates)).toThrow(/64 predicates/);
  });
});
