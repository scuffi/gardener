import { describe, expect, it } from "vitest";
import type { TaskBundleV1 } from "@gardener/contracts";
import { compileGitHubActionsTask } from "../src/actions-target";

function bundle(overrides: Partial<TaskBundleV1> = {}): TaskBundleV1 {
  return {
    schemaVersion: "gardener.task-bundle/v1",
    taskId: "demo.task",
    name: "Demo task",
    description: "A portable task used to validate the Actions target.",
    instructions: "Inspect repository evidence and propose one issue comment.",
    triggers: [{ kind: "github.issue.opened", labelsAll: ["gardener-demo"] }],
    tools: ["repository.list_files", "repository.read_file"],
    effects: ["issue.comment.create"],
    network: { default: "deny", allow: [], deny: [] },
    limits: {
      runtimeSeconds: 300,
      maxTurns: 8,
      maxToolCalls: 12,
      inputTokens: 24_000,
      outputTokens: 4_000,
    },
    ...overrides,
  };
}

describe("github-actions/v1 target adapter", () => {
  it("derives the fixed least-privilege planning and effects permissions", () => {
    expect(compileGitHubActionsTask(bundle())).toEqual({
      schemaVersion: "gardener.github-actions-task-plan/v1",
      target: "github-actions/v1",
      taskId: "demo.task",
      planningPermissions: { contents: "read", idToken: "write" },
      effectsPermissions: { issues: "write", idToken: "write" },
    });
  });

  it("rejects unsupported tools, effects, triggers, and unenforceable network rules", () => {
    expect(() => compileGitHubActionsTask(bundle({ tools: ["repository.exec"] })))
      .toThrow(/repository\.exec/);
    expect(() => compileGitHubActionsTask(bundle({ effects: ["issue.labels.update"] })))
      .toThrow(/issue\.comment\.create/);
    expect(() => compileGitHubActionsTask(bundle({ triggers: [{ kind: "github.workflow_dispatch" }] })))
      .toThrow(/trigger/);
    expect(() => compileGitHubActionsTask(bundle({
      network: { default: "deny", allow: ["api.github.com"], deny: [] },
    }))).toThrow(/network rules/);
  });
});
