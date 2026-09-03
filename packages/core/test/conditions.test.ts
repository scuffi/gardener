import { describe, expect, it } from "vitest";
import { normalizedIssueEventSchema, normalizedPullRequestEventSchema } from "@gardener/contracts";
import {
  availableWorkflowCapabilities,
  evaluateWorkflowCondition,
  plannedWorkflowCapabilities,
  validateWorkflowCondition,
  workflowCapabilityRegistry,
} from "../src";

const repository = { provider: "github" as const, id: "1318443351", installationId: "158557952", owner: "scuffi", name: "flue" };
const actor = { id: "45369682", login: "scuffi", accountType: "User" as const };
const authorIdentity = { id: "49699333", login: "dependabot[bot]", accountType: "Bot" as const };
const issueEvent = normalizedIssueEventSchema.parse({
  schemaVersion: "v1", id: "event-1", deliveryId: "delivery-1", instanceId: "instance-1",
  kind: "github.issue", action: "labeled", occurredAt: "2026-09-03T12:00:00.000Z", repository, actor,
  issue: { id: "5338124856", number: 2, title: "Update dependency", state: "open", labels: ["dependencies"], author: "dependabot[bot]", authorIdentity, htmlUrl: "https://github.com/scuffi/flue/issues/2" },
});
const pullEvent = normalizedPullRequestEventSchema.parse({
  schemaVersion: "v1", id: "event-2", deliveryId: "delivery-2", instanceId: "instance-1",
  kind: "github.pull_request", action: "synchronize", occurredAt: "2026-09-03T12:00:00.000Z", repository, actor,
  pullRequest: {
    id: "5338124857", number: 3, title: "Bump dependency", state: "open", draft: false, merged: false,
    labels: ["dependencies"], author: "dependabot[bot]", authorIdentity, htmlUrl: "https://github.com/scuffi/flue/pull/3",
    head: { ref: "dependabot/npm/package-1.2.3", sha: "abcdef1234567890abcdef1234567890abcdef12" },
    base: { ref: "main", sha: "1234567890abcdef1234567890abcdef12345678" },
  },
});

const repositoryMatches = { kind: "predicate" as const, capabilityId: "github.repository.id@v1" as const, operator: "equals" as const, expected: repository.id };
const repositoryDiffers = { ...repositoryMatches, expected: "999999999" };
const checksUnavailable = { kind: "predicate" as const, capabilityId: "github.pull_request.checks.all_required_passed@v1" as const, operator: "equals" as const, expected: true };

describe("workflow capability registry", () => {
  it("publishes server-owned metadata without claiming planned authorization or checks are available", () => {
    expect(workflowCapabilityRegistry.length).toBeGreaterThan(availableWorkflowCapabilities.length);
    expect(availableWorkflowCapabilities.some((capability) => /team|role|permission|checks/.test(capability.id))).toBe(false);
    expect(plannedWorkflowCapabilities.map((capability) => capability.id)).toEqual(expect.arrayContaining([
      "github.pull_request.checks.all_required_passed@v1",
      "github.event.actor.identity@v1",
      "github.resource.author.identity@v1",
      "github.event.actor.repository_permission@v1",
      "github.event.actor.organization_role@v1",
      "github.event.actor.team_ids@v1",
      "gardener.time.weekly_window@v1",
    ]));
    expect(workflowCapabilityRegistry.every((capability) => capability.label && capability.description && capability.provenance && capability.trust && capability.eventKinds.length && capability.operators.length)).toBe(true);
    expect(Object.isFrozen(workflowCapabilityRegistry)).toBe(true);
    expect(workflowCapabilityRegistry.every((capability) => Object.isFrozen(capability) && Object.isFrozen(capability.operators) && Object.isFrozen(capability.eventKinds))).toBe(true);
  });

  it("validates event compatibility and availability separately for draft and activation", () => {
    expect(validateWorkflowCondition(checksUnavailable, ["github.pull_request"], { mode: "draft" })).toEqual({ valid: true, issues: [] });
    expect(validateWorkflowCondition(checksUnavailable, ["github.pull_request"])).toMatchObject({ valid: false, issues: [{ code: "capability_unavailable" }] });
    expect(validateWorkflowCondition({ kind: "predicate", capabilityId: "github.pull_request.draft@v1", operator: "equals", expected: false }, ["github.issue"])).toMatchObject({ valid: false, issues: [{ code: "event_incompatible" }] });
  });
});

describe("three-valued condition evaluation", () => {
  it("treats an explicitly absent optional condition as an unrestricted match", () => {
    expect(validateWorkflowCondition(null, ["github.issue"])).toEqual({ valid: true, issues: [] });
    expect(evaluateWorkflowCondition(null, issueEvent)).toEqual({ result: "true", matched: true, evidence: [] });
  });

  it("keeps negotiated actor and author identity capabilities fail-closed until the wire format is available", () => {
    const condition = {
      kind: "all" as const,
      conditions: [
        { kind: "predicate" as const, capabilityId: "github.event.actor.identity@v1" as const, operator: "equals" as const, expected: { id: actor.id, accountType: "User" as const } },
        { kind: "predicate" as const, capabilityId: "github.resource.author.identity@v1" as const, operator: "equals" as const, expected: { id: authorIdentity.id, accountType: "Bot" as const } },
      ],
    };
    expect(validateWorkflowCondition(condition, ["github.issue"])).toMatchObject({ valid: false });
    expect(evaluateWorkflowCondition(condition, issueEvent)).toMatchObject({ result: "unknown", matched: false });
    expect(evaluateWorkflowCondition({ ...condition, conditions: [condition.conditions[0], { ...condition.conditions[1], expected: { id: actor.id, accountType: "User" } }] }, issueEvent)).toMatchObject({ result: "unknown", matched: false });
  });

  it("fails closed when older signed events lack identity, including under negation", () => {
    const legacy = normalizedIssueEventSchema.parse({
      schemaVersion: "v1", id: "legacy", deliveryId: "legacy", instanceId: "instance-1", kind: "github.issue", action: "opened",
      occurredAt: "2026-09-03T12:00:00.000Z", repository,
      issue: { id: "1", number: 1, title: "Legacy", state: "open", author: "octocat", htmlUrl: "https://github.com/scuffi/flue/issues/1" },
    });
    const missingIdentity = { kind: "predicate" as const, capabilityId: "github.event.actor.identity@v1" as const, operator: "equals" as const, expected: { id: actor.id, accountType: "User" as const } };
    const result = evaluateWorkflowCondition({ kind: "not", condition: missingIdentity }, legacy);
    expect(result).toMatchObject({ result: "unknown", matched: false });
    expect(result.evidence.map((item) => item.reason)).toEqual(["capability_unavailable", "not_unknown"]);
  });

  it("implements strong Kleene all, any, and not semantics", () => {
    const values = { true: repositoryMatches, false: repositoryDiffers, unknown: checksUnavailable };
    const cases = [
      ["true", "true", "true", "true"],
      ["true", "false", "false", "true"],
      ["true", "unknown", "unknown", "true"],
      ["false", "false", "false", "false"],
      ["false", "unknown", "false", "unknown"],
      ["unknown", "unknown", "unknown", "unknown"],
    ] as const;
    for (const [left, right, all, any] of cases) {
      expect(evaluateWorkflowCondition({ kind: "all", conditions: [values[left], values[right]] }, pullEvent).result).toBe(all);
      expect(evaluateWorkflowCondition({ kind: "any", conditions: [values[left], values[right]] }, pullEvent).result).toBe(any);
    }
    expect(evaluateWorkflowCondition({ kind: "not", condition: values.true }, pullEvent).result).toBe("false");
    expect(evaluateWorkflowCondition({ kind: "not", condition: values.false }, pullEvent).result).toBe("true");
    expect(evaluateWorkflowCondition({ kind: "not", condition: values.unknown }, pullEvent).result).toBe("unknown");
  });

  it("returns unknown for event-incompatible facts and never top-level matches unknown", () => {
    const result = evaluateWorkflowCondition({ kind: "predicate", capabilityId: "github.pull_request.draft@v1", operator: "equals", expected: false }, issueEvent);
    expect(result).toMatchObject({ result: "unknown", matched: false, evidence: [{ reason: "event_incompatible" }] });
  });

  it("evaluates typed scalar, numeric, and list operators with bounded evidence", () => {
    const condition = {
      kind: "all" as const,
      conditions: [
        { kind: "predicate" as const, capabilityId: "github.pull_request.number@v1" as const, operator: "at_least" as const, expected: 3 },
        { kind: "predicate" as const, capabilityId: "github.resource.labels@v1" as const, operator: "contains_all" as const, expected: ["dependencies"] },
        { kind: "predicate" as const, capabilityId: "github.pull_request.base.ref@v1" as const, operator: "in" as const, expected: ["main", "release"] },
      ],
    };
    const result = evaluateWorkflowCondition(condition, pullEvent);
    expect(result).toMatchObject({ result: "true", matched: true });
    expect(result.evidence).toHaveLength(4);
    expect(result.evidence.every((item) => item.path.startsWith("$condition"))).toBe(true);
  });
});
