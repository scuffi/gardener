import { describe, expect, it } from "vitest";
import { buildWorkflowSpec, defaultWorkflowInstructions, initialWorkflowValues, workflowBuilderError, workflowBuilderValuesFromSpec } from "./workflow-builder";

describe("workflow builder v1", () => {
  it("builds a bounded issue workflow from the minimal form", () => {
    const spec = buildWorkflowSpec({ ...initialWorkflowValues, name: "Issue helper", repositoryIds: ["22", "11"] });
    expect(spec).toMatchObject({
      name: "Issue helper",
      triggers: [{ kind: "github.issue", actions: ["opened", "reopened"] }],
      repositoryIds: ["11", "22"],
      condition: null,
      capabilities: { read: ["issue"], propose: ["issue.label.add", "issue.comment.create"], maximumMode: "approval" },
      limits: { operations: 4, outputTokens: 800 },
    });
  });

  it("keeps behavior choices bounded while allowing trusted prompt variables", () => {
    const outcomes = { suggestLabels: false, suggestReply: true };
    const spec = buildWorkflowSpec({ ...initialWorkflowValues, ...outcomes, name: "Reply helper", repositoryIds: ["11"], instructions: defaultWorkflowInstructions(outcomes), maximumMode: "instance_policy" });
    expect(spec.condition).toBeNull();
    expect(spec.capabilities).toEqual({ read: ["issue"], propose: ["issue.comment.create"], maximumMode: "instance_policy" });
    expect(spec.runtime.instructions).toContain("Do not propose labels");
    expect(spec.limits.operations).toBe(1);
  });

  it("round-trips builder-created specs with custom instructions for immutable draft editing", () => {
    const values = { ...initialWorkflowValues, name: "Reply helper", repositoryIds: ["11"], opened: false, instructions: "Triage {{resource.id}} in {{repository.full_name}}.", maximumMode: "instance_policy" as const };
    expect(workflowBuilderValuesFromSpec(buildWorkflowSpec(values))).toEqual(values);
  });

  it("refuses to edit definitions outside the narrow builder surface", () => {
    const spec = buildWorkflowSpec({ ...initialWorkflowValues, name: "Issue helper", repositoryIds: ["11"] });
    expect(workflowBuilderValuesFromSpec({ ...spec, condition: { kind: "predicate", capabilityId: "github.resource.labels@v1", operator: "contains", expected: "triage" } })).toBeNull();
    expect(workflowBuilderValuesFromSpec({ ...spec, limits: { ...spec.limits, outputTokens: 900 } })).toBeNull();
  });

  it("returns actionable form and prompt-template errors", () => {
    expect(workflowBuilderError(initialWorkflowValues)).toBe("Give this workflow a name.");
    expect(workflowBuilderError({ ...initialWorkflowValues, name: "Helper", repositoryIds: [], opened: false, reopened: false })).toBe("Choose at least one issue event.");
    expect(workflowBuilderError({ ...initialWorkflowValues, name: "Helper", repositoryIds: ["11"], instructions: "Read {{resource.body}}" })).toBe("Unknown prompt variable: resource.body");
  });
});
