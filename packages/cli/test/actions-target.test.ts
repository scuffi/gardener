import { describe, expect, it } from "vitest";
import { operationKindValues, taskBundleV1Schema, triggerKindOrder, type TaskBundleV1 } from "@gardener/contracts";
import { compileGitHubActionsTask, planTimeoutMinutes } from "../src/actions-target";

/** Adds the manual trigger every bundle carries, in its canonical position, if missing. */
function withManual(triggers: TaskBundleV1["triggers"]): TaskBundleV1["triggers"] {
  if (triggers.some((trigger) => trigger.kind === "github.workflow_dispatch")) return triggers;
  const manual = triggerKindOrder.get("github.workflow_dispatch")!;
  const at = triggers.findIndex((trigger) => triggerKindOrder.get(trigger.kind)! > manual);
  const copy = [...triggers];
  copy.splice(at < 0 ? copy.length : at, 0, { kind: "github.workflow_dispatch" });
  return copy;
}

function bundle(overrides: Partial<TaskBundleV1> = {}): TaskBundleV1 {
  return taskBundleV1Schema.parse({
    schemaVersion: "gardener.task-bundle/v1",
    model: "@cf/moonshotai/kimi-k2.6",
    taskId: "demo.task",
    name: "Demo task",
    description: "A portable task used to validate the Actions target.",
    instructions: "Inspect repository evidence and propose one issue comment.",
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
    triggers: withManual(overrides.triggers ?? [{ kind: "github.issue.opened", labelsAll: ["gardener-demo"], mentions: [], authors: "any" }]),
  });
}

describe("github-actions/v1 target adapter", () => {
  it("derives least-privilege permissions for a comment-only task", () => {
    const plan = compileGitHubActionsTask(bundle());
    expect(plan).toMatchObject({
      schemaVersion: "gardener.github-actions-task-plan/v1",
      target: "github-actions/v1",
      taskId: "demo.task",
      planningPermissions: {
        checks: "read",
        contents: "read",
        discussions: "read",
        "id-token": "write",
        issues: "read",
        "pull-requests": "read",
        statuses: "read",
      },
      effectsPermissions: { "id-token": "write", issues: "write" },
      callerPermissions: {
        checks: "read",
        contents: "read",
        discussions: "read",
        "id-token": "write",
        issues: "write",
        "pull-requests": "read",
        statuses: "read",
      },
    });
    expect(plan.triggers).toEqual([{
      kind: "github.issue.opened",
      event: "issues",
      action: "opened",
      labelsExpression: "github.event.issue.labels.*.name",
      forkSensitive: false,
    }, {
      kind: "github.workflow_dispatch",
      event: "workflow_dispatch",
      forkSensitive: false,
    }]);
    expect(plan.effectLimits).toEqual({});
  });

  it("compiles every operation kind and unions the required write scopes", () => {
    const plan = compileGitHubActionsTask(bundle({ effects: [...operationKindValues] }));
    expect(plan.effectsPermissions).toEqual({
      checks: "write",
      contents: "write",
      discussions: "write",
      "id-token": "write",
      issues: "write",
      "pull-requests": "write",
      statuses: "read",
    });
    // No operation's executor calls the Actions API, so the union must never
    // contain an `actions` scope even when every kind is declared at once.
    expect(plan.effectsPermissions.actions).toBeUndefined();
  });

  it("maps each operation family to its exact apply scope", () => {
    // A manual-only task offers no target, so only the effect's own scope appears.
    const scopeFor = (effect: string) => compileGitHubActionsTask(bundle({
      effects: [effect] as TaskBundleV1["effects"],
      triggers: [{ kind: "github.workflow_dispatch" }],
    })).effectsPermissions;
    expect(scopeFor("issue.label.add")).toEqual({ "id-token": "write", issues: "write" });
    expect(scopeFor("pull_request.comment.create")).toEqual({ "id-token": "write", "pull-requests": "write" });
    expect(scopeFor("branch.create")).toEqual({ contents: "write", "id-token": "write" });
    expect(scopeFor("commit.create")).toEqual({ contents: "write", "id-token": "write" });
    expect(scopeFor("pull_request.open_draft")).toEqual({
      contents: "read",
      "id-token": "write",
      "pull-requests": "write",
    });
    expect(scopeFor("discussion.close")).toEqual({ discussions: "write", "id-token": "write" });
    // check.rerun uses the Checks API only; granting `actions` would be excess
    // authority on the privileged apply job.
    expect(scopeFor("check.rerun")).toEqual({ checks: "write", "id-token": "write" });
    expect(scopeFor("pull_request.merge")).toEqual({
      checks: "read",
      contents: "write",
      "id-token": "write",
      "pull-requests": "write",
      statuses: "read",
    });
    expect(scopeFor("release.create")).toEqual({ contents: "write", "id-token": "write" });
  });

  it("grants the fixed planning read union for every task", () => {
    const expected = {
      checks: "read",
      contents: "read",
      discussions: "read",
      "id-token": "write",
      issues: "read",
      "pull-requests": "read",
      statuses: "read",
    };
    for (const candidate of [
      bundle(),
      bundle({
        tools: ["repository.list_files", "provider.api.read"],
        effects: ["pull_request.merge", "discussion.close"],
        triggers: [{ kind: "github.issue_comment.created", labelsAll: [], mentions: [], authors: "any" }],
      }),
      bundle({ effects: [], triggers: [{ kind: "github.workflow_dispatch" }] }),
    ]) {
      expect(compileGitHubActionsTask(candidate).planningPermissions).toEqual(expected);
    }
  });

  it("requires repository.exec tasks to declare unrestricted egress honestly", () => {
    const plan = compileGitHubActionsTask(bundle({
      tools: ["repository.list_files", "repository.exec"],
      network: { default: "allow", allow: [], deny: [] },
    }));
    expect(plan.network).toEqual({ default: "allow", allow: [], deny: [] });

    // An exec task claiming deny is refused: Gardener cannot deliver it.
    expect(() => compileGitHubActionsTask(bundle({
      tools: ["repository.list_files", "repository.exec"],
      network: { default: "deny", allow: [], deny: [] },
    }))).toThrow(/must declare network default allow/);
  });

  it("keeps non-exec tasks at deny and refuses unenforceable host rules", () => {
    expect(compileGitHubActionsTask(bundle()).network).toEqual({ default: "deny", allow: [], deny: [] });
    expect(() => compileGitHubActionsTask(bundle({
      network: { default: "allow", allow: [], deny: [] },
    }))).toThrow(/must use network default deny/);

    // Host rules are rejected rather than compiled into a filter that this
    // target cannot actually enforce.
    for (const network of [
      { default: "allow" as const, allow: ["registry.npmjs.org"], deny: [] },
      { default: "allow" as const, allow: [], deny: ["telemetry.example.com"] },
    ]) {
      expect(() => compileGitHubActionsTask(bundle({
        tools: ["repository.list_files", "repository.exec"],
        network,
      }))).toThrow(/cannot enforce host rules/);
    }
  });

  it("binds every common trigger to an exact provider filter and excludes pull_request_target", () => {
    const plan = compileGitHubActionsTask(bundle({
      triggers: [
        { kind: "github.issue.opened", labelsAll: [], mentions: [], authors: "any" },
        { kind: "github.issue_comment.created", labelsAll: [], mentions: [], authors: "any" },
        { kind: "github.pull_request.synchronize", labelsAll: [] },
        { kind: "github.pull_request_review.submitted", labelsAll: [], mentions: [], authors: "any" },
        { kind: "github.pull_request_review_comment.created", labelsAll: [], mentions: [], authors: "any" },
        { kind: "github.push", branches: ["main"] },
        { kind: "github.workflow_dispatch" },
        { kind: "github.schedule", cron: "0 3 * * 1" },
        { kind: "github.discussion.answered", labelsAll: [] },
        { kind: "github.discussion_comment.created", labelsAll: [], mentions: [], authors: "any" },
      ],
    }));
    expect(plan.triggers.map((trigger) => trigger.event)).toEqual([
      "issues",
      "issue_comment",
      "pull_request",
      "pull_request_review",
      "pull_request_review_comment",
      "push",
      "workflow_dispatch",
      "schedule",
      "discussion",
      "discussion_comment",
    ]);
    expect(plan.triggers.filter((trigger) => trigger.forkSensitive).map((trigger) => trigger.kind)).toEqual([
      "github.pull_request.synchronize",
      "github.pull_request_review.submitted",
      "github.pull_request_review_comment.created",
    ]);
    expect(JSON.stringify(plan)).not.toContain("pull_request_target");
  });

  it("records optional effect-plan ceilings and rejects unusable combinations", () => {
    expect(compileGitHubActionsTask(bundle({
      limits: { ...bundle().limits, maxEffectOperations: 10, maxEffectBytes: 262_144 },
    })).effectLimits).toEqual({ maxOperations: 10, maxBytes: 262_144 });
    expect(() => compileGitHubActionsTask(bundle({
      effects: [],
      limits: { ...bundle().limits, maxEffectOperations: 10 },
    }))).toThrow(/without declaring any effect/);
  });

  it("keeps an effect-free inspection task free of apply write scopes", () => {
    const plan = compileGitHubActionsTask(bundle({ effects: [], reactions: false }));
    expect(plan.effectsPermissions).toEqual({ "id-token": "write" });
    expect(plan.reactionPermissions).toEqual({});
    expect(plan.callerPermissions).toEqual(plan.planningPermissions);
  });

  it("grants the reaction jobs only the writes their triggers need, unless the task turns reactions off", () => {
    const trigger = (kind: string) => ({ kind, labelsAll: [], authors: "any", mentions: [] });
    const on = (...triggers: unknown[]) => compileGitHubActionsTask(bundle({ effects: [], triggers } as never));
    expect(on(trigger("github.issue.opened")).reactionPermissions).toEqual({ issues: "write" });
    expect(on({ kind: "github.issue_comment.created", labelsAll: [], authors: "maintainers", mentions: [] }).callerPermissions.issues).toBe("write");
    expect(on({ kind: "github.pull_request_review_comment.created", labelsAll: [], authors: "maintainers", mentions: [] }).reactionPermissions)
      .toEqual({ "pull-requests": "write" });
    expect(on({ kind: "github.discussion_comment.created", labelsAll: [], authors: "maintainers", mentions: [] }).reactionPermissions)
      .toEqual({ discussions: "write" });
    // Reviews have no reactions API; schedules and manual runs have nothing to react to.
    expect(on({ kind: "github.pull_request_review.submitted", labelsAll: [], authors: "maintainers", mentions: [] }).reactionPermissions).toEqual({});
    expect(on({ kind: "github.workflow_dispatch" }, { kind: "github.schedule", cron: "0 6 * * 1" }).reactionPermissions).toEqual({});
  });

  it("lets apply read every kind of target a manual run can name", () => {
    const plan = compileGitHubActionsTask(bundle({
      triggers: [{ kind: "github.pull_request.opened", labelsAll: [], mentions: [], authors: "any" }],
      effects: ["issue.comment.create"],
    }));
    expect(plan.effectsPermissions).toMatchObject({ issues: "write", "pull-requests": "read", "id-token": "write" });
    expect(compileGitHubActionsTask(bundle({ effects: [] })).effectsPermissions).toEqual({ "id-token": "write" });
  });

  it("listens only for manual runs when the task is a draft", () => {
    const plan = compileGitHubActionsTask(bundle({
      triggers: [{ kind: "github.pull_request.opened", labelsAll: [], mentions: [], authors: "any" }],
      draft: true,
    }));
    expect(plan.triggers.map((trigger) => trigger.kind)).toEqual(["github.workflow_dispatch"]);
    expect(plan.requiresSameRepositoryGuard).toBe(true);
  });

  it("flags pull-request tasks for the same-repository guard with no opt-in", () => {
    expect(compileGitHubActionsTask(bundle()).requiresSameRepositoryGuard).toBe(false);
    expect(compileGitHubActionsTask(bundle({
      triggers: [{ kind: "github.pull_request.opened", labelsAll: [], mentions: [], authors: "any" }],
    })).requiresSameRepositoryGuard).toBe(true);
    expect("allowForkExecution" in compileGitHubActionsTask(bundle())).toBe(false);
  });

  it("leaves every limit's size to the task, up to the longest a hosted job runs", () => {
    const limits = { runtimeSeconds: 21_000, maxTurns: 500, maxToolCalls: 2_000, inputTokens: 1_000_000, outputTokens: 400_000 };
    expect(() => compileGitHubActionsTask(bundle({ limits }))).not.toThrow();
    expect(planTimeoutMinutes(21_000)).toBe(360);
    expect(planTimeoutMinutes(480)).toBe(18);
    expect(planTimeoutMinutes(61)).toBe(12);
  });

  it("rejects non-canonical trigger order and unsupported limits", () => {
    // The contract rejects it first, and the compiler re-checks independently
    // so a bundle reaching it from any other path cannot skip the ordering.
    expect(() => bundle({
      triggers: [
        { kind: "github.pull_request.opened", labelsAll: [], mentions: [], authors: "any" },
        { kind: "github.issue.opened", labelsAll: [], mentions: [], authors: "any" },
      ],
    })).toThrow(/canonical/);
    expect(() => compileGitHubActionsTask({
      ...bundle(),
      triggers: [
        { kind: "github.pull_request.opened", labelsAll: [], mentions: [], authors: "any" },
        { kind: "github.issue.opened", labelsAll: [], mentions: [], authors: "any" },
      ],
    })).toThrow(/canonical order/);
    expect(() => compileGitHubActionsTask(bundle({
      limits: { ...bundle().limits, runtimeSeconds: 21_001 },
    }))).toThrow(/runtime-seconds must be at most 21000 .*6 hours/);
    expect(() => compileGitHubActionsTask(bundle({
      limits: { ...bundle().limits, runtimeSeconds: 29 },
    }))).toThrow(/runtime-seconds must be at least 30/);
    expect(() => compileGitHubActionsTask(bundle({
      limits: { ...bundle().limits, maxTurns: 2 },
    }))).toThrow(/max-turns/);
    expect(() => compileGitHubActionsTask(bundle({
      limits: { ...bundle().limits, maxToolCalls: 2 },
    }))).toThrow(/max-tool-calls/);
  });
});
