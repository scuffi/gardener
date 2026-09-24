import { describe, expect, it } from "vitest";
import {
  eventActionByTriggerKind,
  eventHeadIsSameRepository,
  eventNameByTriggerKind,
  normalizedEventV1Schema,
  dispatchTargetKinds,
  taskBundleV1Schema,
  taskEventBindingFromNormalizedEvent,
  taskTriggerKindValues,
  triggerKindOrder,
  type NormalizedEventV1,
} from "../src/task";

const base = {
  schemaVersion: "gardener.normalized-event/v1" as const,
  eventId: "github:35256179260:1",
  occurredAt: "2026-09-22T12:00:00.000Z",
  repository: {
    id: "1374842705",
    ownerId: "45369682",
    owner: "scuffi",
    name: "gardener",
    fullName: "scuffi/gardener",
    visibility: "private" as const,
    commitSha: "b".repeat(40),
    ref: "refs/heads/main",
    defaultBranch: "main",
  },
  workflow: {
    runId: "35256179260",
    runAttempt: 1,
    workflowRef: "scuffi/gardener/.github/workflows/gardener.yml@refs/heads/main",
    jobWorkflowRef: "scuffi/gardener/.github/workflows/gardener-task.yml@" + "c".repeat(40),
    runnerEnvironment: "github-hosted" as const,
  },
  actor: { id: "45369682", login: "scuffi" },
};

const actor = { id: "45369682", login: "scuffi" };
const issue = { id: "999", number: 1, title: "t", body: null, state: "open" as const, updatedAt: "2026-09-22T12:00:00.000Z", labels: ["bug"], author: actor };
const discussion = {
  id: "77",
  nodeId: "D_kwDOAbc123",
  number: 4,
  title: "t",
  body: null,
  labels: [],
  author: actor,
  category: "General",
  answered: false,
  state: "open" as const,
  updatedAt: "2026-09-22T12:00:00.000Z",
};

function pullRequest(headRepoId: string | null) {
  return {
    id: "555",
    number: 12,
    title: "t",
    body: null,
    labels: [],
    author: actor,
    draft: false,
    state: "open" as const,
    merged: false,
    updatedAt: "2026-09-22T12:00:00.000Z",
    base: { ref: "main", sha: "a".repeat(40), repo: { id: "1374842705", fullName: "scuffi/gardener" } },
    head: {
      ref: "feature",
      sha: "d".repeat(40),
      repo: headRepoId === null ? null : { id: headRepoId, fullName: "forker/gardener" },
    },
  };
}

function event(kind: string, payload: Record<string, unknown>): unknown {
  return { ...base, workflow: { ...base.workflow, eventName: eventNameByTriggerKind[kind as never] }, kind, ...payload };
}

describe("normalized event v1", () => {
  it("covers exactly the 26 common trigger kinds and excludes pull_request_target", () => {
    expect(taskTriggerKindValues).toHaveLength(26);
    expect(new Set(taskTriggerKindValues).size).toBe(26);
    expect(Object.keys(eventNameByTriggerKind).sort()).toEqual([...taskTriggerKindValues].sort());
    expect(Object.keys(eventActionByTriggerKind).sort()).toEqual([...taskTriggerKindValues].sort());
    expect(Object.values(eventNameByTriggerKind)).not.toContain("pull_request_target");
    expect(triggerKindOrder.size).toBe(26);
  });

  it("parses one representative event per family", () => {
    const samples: Array<[string, Record<string, unknown>]> = [
      ["github.issue.opened", { issue }],
      ["github.issue.labeled", { issue, label: "bug" }],
      ["github.issue_comment.created", { issue, comment: { id: "3", body: "hi", updatedAt: "2026-09-22T12:00:00.000Z", author: actor } }],
      ["github.pull_request.opened", { pullRequest: pullRequest("1374842705") }],
      ["github.pull_request_review.submitted", {
        pullRequest: pullRequest("1374842705"),
        review: { id: "9", state: "approved", body: null, author: actor },
      }],
      ["github.pull_request_review_comment.created", {
        pullRequest: pullRequest("1374842705"),
        comment: { id: "4", body: "nit", updatedAt: "2026-09-22T12:00:00.000Z", author: actor },
      }],
      ["github.push", {
        push: {
          ref: "refs/heads/main",
          before: "e".repeat(40),
          after: "f".repeat(40),
          forced: false,
          commits: [{ sha: "f".repeat(40), message: "fix", author: { name: "a", email: "a@b.c" } }],
          includedCommits: 1,
          commitsTruncated: false,
        },
      }],
      ["github.workflow_dispatch", { prompt: "Inspect the repository." }],
      ["github.schedule", { cron: "0 3 * * 1" }],
      ["github.discussion.created", { discussion }],
      ["github.discussion_comment.created", {
        discussion,
        comment: { id: "8", nodeId: "DC_kwDOAbc", body: "hi", updatedAt: "2026-09-22T12:00:00.000Z", author: actor },
      }],
    ];
    for (const [kind, payload] of samples) {
      expect(() => normalizedEventV1Schema.parse(event(kind, payload))).not.toThrow();
    }
  });

  it("accepts events from explicitly pinned bridges that predate precondition facts", () => {
    const { state: _state, updatedAt: _updatedAt, ...legacyIssue } = issue;
    expect(() => normalizedEventV1Schema.parse(event("github.issue.opened", { issue: legacyIssue }))).not.toThrow();
  });

  it("rejects an event whose workflow eventName contradicts its kind", () => {
    expect(() => normalizedEventV1Schema.parse({
      ...(event("github.issue.opened", { issue }) as Record<string, unknown>),
      workflow: { ...base.workflow, eventName: "discussion" },
    })).toThrow(/eventName does not match/);
  });

  it("requires the push ref to match the bound repository ref", () => {
    expect(() => normalizedEventV1Schema.parse(event("github.push", {
      push: {
        ref: "refs/heads/other",
        before: "e".repeat(40),
        after: "f".repeat(40),
        forced: false,
        commits: [],
        includedCommits: 0,
        commitsTruncated: false,
      },
    }))).toThrow(/push ref must match/);
  });

  it("treats only same-repository heads as safe and fails closed on deleted forks", () => {
    const same = normalizedEventV1Schema.parse(
      event("github.pull_request.opened", { pullRequest: pullRequest("1374842705") }),
    ) as NormalizedEventV1;
    const fork = normalizedEventV1Schema.parse(
      event("github.pull_request.opened", { pullRequest: pullRequest("9999") }),
    ) as NormalizedEventV1;
    const deleted = normalizedEventV1Schema.parse(
      event("github.pull_request.opened", { pullRequest: pullRequest(null) }),
    ) as NormalizedEventV1;
    const issueEvent = normalizedEventV1Schema.parse(event("github.issue.opened", { issue })) as NormalizedEventV1;

    expect(eventHeadIsSameRepository(same)).toBe(true);
    expect(eventHeadIsSameRepository(fork)).toBe(false);
    expect(eventHeadIsSameRepository(deleted)).toBe(false);
    expect(eventHeadIsSameRepository(issueEvent)).toBe(true);
  });

  it("does not accept a raw provider payload passthrough", () => {
    expect(() => normalizedEventV1Schema.parse({
      ...(event("github.issue.opened", { issue }) as Record<string, unknown>),
      payload: { anything: true },
    })).toThrow();
  });
});

describe("manual run events", () => {
  it("offer the targets a task's other triggers act on", () => {
    expect(dispatchTargetKinds([{ kind: "github.workflow_dispatch" }])).toEqual([]);
    expect(dispatchTargetKinds([{ kind: "github.issue_comment.created" }])).toEqual(["issue"]);
    expect(dispatchTargetKinds([{ kind: "github.pull_request_review.submitted" }, { kind: "github.issue.opened" }]))
      .toEqual(["issue", "pull_request"]);
    expect(dispatchTargetKinds([{ kind: "github.push" }, { kind: "github.discussion.created" }])).toEqual([]);
  });

  it("allow an optional prompt and at most one target, which binds the run", () => {
    const parse = (payload: Record<string, unknown>) => normalizedEventV1Schema.parse(event("github.workflow_dispatch", payload));
    expect(taskEventBindingFromNormalizedEvent(parse({}))).toMatchObject({ resource: null });
    expect(taskEventBindingFromNormalizedEvent(parse({ prompt: "x", issue })))
      .toMatchObject({ resource: { kind: "issue", id: "999", number: 1 } });
    expect(taskEventBindingFromNormalizedEvent(parse({ pullRequest: pullRequest("1374842705") })))
      .toMatchObject({ resource: { kind: "pull_request", number: 12 } });
    expect(() => parse({ issue, pullRequest: pullRequest("1374842705") })).toThrow(/not both/);
    expect(() => parse({ prompt: "" })).toThrow();
  });
});

/** Adds the manual trigger every bundle carries, in its canonical position. */
function withManual(triggers: Array<{ kind: string; [key: string]: unknown }>): Array<{ kind: string; [key: string]: unknown }> {
  const manual = triggerKindOrder.get("github.workflow_dispatch")!;
  const at = triggers.findIndex((trigger) => triggerKindOrder.get(trigger.kind as never)! > manual);
  const copy = [...triggers];
  copy.splice(at < 0 ? copy.length : at, 0, { kind: "github.workflow_dispatch" });
  return copy;
}

describe("trigger validation hardening", () => {
  const bundle = (triggers: Array<{ kind: string; [key: string]: unknown }>) => ({
    schemaVersion: "gardener.task-bundle/v1",
    taskId: "fixture",
    name: "Fixture",
    description: "d",
    instructions: "i",
    triggers: withManual(triggers),
    tools: ["repository.list_files"],
    effects: [],
    network: { default: "deny", allow: [], deny: [] },
    limits: { runtimeSeconds: 300, maxTurns: 8, maxToolCalls: 24, inputTokens: 60_000, outputTokens: 1_200 },
  });

  it("accepts realistic cron expressions and rejects dialects GitHub ignores", () => {
    for (const cron of ["0 3 * * 1", "*/15 * * * *", "0 0,12 1-15 1,6 *", "5 4 * * 0"]) {
      expect(() => taskBundleV1Schema.parse(bundle([{ kind: "github.schedule", cron }]))).not.toThrow();
    }
    for (const cron of ["0 3 * * MON", "0 3 ? * *", "0 3 * *", "60 3 * * *", "0 24 * * *", "0 3 * * 7", "0 3 L * *"]) {
      expect(() => taskBundleV1Schema.parse(bundle([{ kind: "github.schedule", cron }]))).toThrow();
    }
  });

  it("rejects an all-negative push branch list", () => {
    expect(() => taskBundleV1Schema.parse(bundle([{ kind: "github.push", branches: ["!wip/*"] }]))).toThrow(
      /at least one positive pattern/,
    );
    expect(() => taskBundleV1Schema.parse(bundle([{ kind: "github.push", branches: ["main", "!wip/*"] }]))).not.toThrow();
  });

  it("requires canonical trigger ordering", () => {
    expect(() => taskBundleV1Schema.parse(bundle([
      { kind: "github.pull_request.opened" },
      { kind: "github.issue.opened" },
    ]))).toThrow(/canonical/);
    expect(() => taskBundleV1Schema.parse(bundle([
      { kind: "github.issue.opened" },
      { kind: "github.pull_request.opened" },
    ]))).not.toThrow();
  });
});
