import { describe, expect, it } from "vitest";
import {
  TASK_WORKFLOW_PATH_PATTERN,
  taskRunPayloadV1Schema,
  taskWorkflowPath,
  workflowSlug,
} from "../src/task-runs";
import { dispatchTargetKinds, taskBundleV1Schema, taskEffectProposalV1Schema, taskRunSubjectRefusal, type TaskBundleV1 } from "../src/task";

function bundle(overrides: Partial<TaskBundleV1> = {}): unknown {
  return {
    schemaVersion: "gardener.task-bundle/v1",
    model: "@cf/moonshotai/kimi-k2.6",
    taskId: "triage",
    name: "Triage",
    description: "Triage issues.",
    instructions: "Triage.",
    triggers: [{ kind: "github.issue.opened", labelsAll: [], mentions: [], authors: "any" }, { kind: "github.workflow_dispatch" }],
    tools: ["repository.read_file"],
    effects: ["task.run"],
    effectOptions: { "task.run": { tasks: ["fix"] } },
    network: { default: "deny", allow: [], deny: [] },
    limits: { runtimeSeconds: 300, maxTurns: 8, maxToolCalls: 24, inputTokens: 64_000, outputTokens: 8_000 },
    ...overrides,
  };
}

describe("task.run contracts", () => {
  it("names a task's workflow one way, matching the dispatchable pattern", () => {
    expect(workflowSlug("fix")).toBe("fix");
    expect(workflowSlug("fix.ready_now")).toBe("fix-ready-now");
    expect(taskWorkflowPath("fix-ready")).toBe(".github/workflows/gardener-fix-ready.yml");
    for (const id of ["fix", "a.b", "x_y", "9lives"]) expect(TASK_WORKFLOW_PATH_PATTERN.test(taskWorkflowPath(id))).toBe(true);
    for (const path of [".github/workflows/release.yml", ".github/workflows/gardener-.yml", ".github/workflows/sub/gardener-x.yml", "gardener-x.yml"]) {
      expect(TASK_WORKFLOW_PATH_PATTERN.test(path)).toBe(false);
    }
  });

  it("takes a task and one number, nothing else", () => {
    expect(taskRunPayloadV1Schema.safeParse({ task: "fix", issueNumber: 7 }).success).toBe(true);
    for (const extra of [{ prompt: "x" }, { inputs: {} }, { ref: "main" }, { workflowPath: ".github/workflows/gardener-fix.yml" }]) {
      expect(taskRunPayloadV1Schema.safeParse({ task: "fix", issueNumber: 7, ...extra }).success).toBe(false);
    }
  });

  it("takes only a whole /pullNumber reference, so no earlier step's text reaches the dispatch", () => {
    const proposal = (payload: Record<string, unknown>, references: Record<string, unknown>) =>
      taskEffectProposalV1Schema.safeParse({ stepName: "start", kind: "task.run", payload, references, rationale: "Start it." });
    expect(proposal({ task: "fix-ready" }, { "/pullNumber": { step: "open-pr", output: "pullNumber" } }).success).toBe(true);
    for (const pointer of ["/task", "/issueNumber"]) {
      const parsed = proposal({ task: "fix-ready", pullNumber: 1 }, { [pointer]: { step: "open-pr", output: "pullNumber" } });
      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues.map((issue) => issue.message)).toContain("task.run takes only a /pullNumber reference");
    }
  });

  it("is declared with the tasks it may start, never itself", () => {
    expect(taskBundleV1Schema.safeParse(bundle()).success).toBe(true);
    expect(taskBundleV1Schema.safeParse(bundle({ effectOptions: undefined })).success).toBe(false);
    expect(taskBundleV1Schema.safeParse(bundle({ effectOptions: { "task.run": { tasks: ["triage"] } } })).success).toBe(false);
    expect(taskBundleV1Schema.safeParse(bundle({ effectOptions: { "task.run": { tasks: ["fix", "a"] } } })).success).toBe(false);
    expect(taskBundleV1Schema.safeParse(bundle({ effects: [], effectOptions: { "task.run": { tasks: ["fix"] } } })).success).toBe(false);
  });

  it("offers a manual-only task's dispatch subject as its target input", () => {
    expect(dispatchTargetKinds([{ kind: "github.workflow_dispatch" }])).toEqual([]);
    expect(dispatchTargetKinds([{ kind: "github.workflow_dispatch", subject: "issue" }])).toEqual(["issue"]);
    expect(dispatchTargetKinds([{ kind: "github.workflow_dispatch", subject: "pull_request" }])).toEqual(["pull_request"]);
  });

  it("starts a task only on the run's own subject, by kind and number, or a pull request the plan opens", () => {
    const issue7 = { kind: "issue", id: "1", number: 7 } as const;
    expect(taskRunSubjectRefusal({ kind: "issue", issueNumber: 7 }, issue7, new Map())).toBeUndefined();
    expect(taskRunSubjectRefusal({ kind: "issue", issueNumber: 8 }, issue7, new Map())).toMatch(/only on issue #7/);
    expect(taskRunSubjectRefusal({ kind: "pull_request", pullNumber: 7 }, issue7, new Map())).toMatch(/only on issue #7/);
    expect(taskRunSubjectRefusal({ kind: "issue", issueNumber: 7 }, null, new Map())).toMatch(/nothing triggered this run/);
    expect(taskRunSubjectRefusal({ kind: "pull_request", openedBy: "open" }, null, new Map([["open", "pull_request.open_draft"]]))).toBeUndefined();
    expect(taskRunSubjectRefusal({ kind: "pull_request", openedBy: "open" }, issue7, new Map([["open", "issue.create"]]))).toMatch(/not one/);
  });
});
