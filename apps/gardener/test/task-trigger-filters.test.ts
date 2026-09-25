import { describe, expect, it } from "vitest";
import { eventNameByTriggerKind, type NormalizedEventV1, type TaskBundleV1 } from "@gardener/contracts";
import { triggerAssociationMissing, triggerFiltersExclude } from "../src/task-runtime/harness-adapter";

const actor = { id: "45369682", login: "scuffi" };
const issue = { id: "999", number: 4, title: "t", body: "Issue body", state: "open" as const, labels: [], author: actor };

function event(kind: NormalizedEventV1["kind"], extra: Record<string, unknown>): NormalizedEventV1 {
  return {
    schemaVersion: "gardener.normalized-event/v1",
    eventId: "github:1:1",
    occurredAt: "2026-09-25T12:00:00.000Z",
    repository: {
      id: "1", ownerId: "2", owner: "scuffi", name: "demo", fullName: "scuffi/demo", visibility: "public",
      commitSha: "b".repeat(40), ref: "refs/heads/main", defaultBranch: "main",
    },
    workflow: {
      runId: "1", runAttempt: 1, eventName: eventNameByTriggerKind[kind],
      workflowRef: "scuffi/demo/.github/workflows/g.yml@refs/heads/main",
      jobWorkflowRef: "scuffi/gardener/.github/workflows/gardener-task.yml@" + "c".repeat(40),
      runnerEnvironment: "github-hosted",
    },
    actor,
    kind,
    ...extra,
  } as NormalizedEventV1;
}

const comment = (body: string, authorAssociation?: string) => ({
  id: "7", body, author: actor, ...(authorAssociation === undefined ? {} : { authorAssociation }),
});
const created = (body: string, association?: string) =>
  event("github.issue_comment.created", { issue, comment: comment(body, association) });
const edited = (body: string, previousBody: string | undefined, association = "OWNER") =>
  event("github.issue_comment.edited", {
    issue, comment: comment(body, association), ...(previousBody === undefined ? {} : { previousBody }),
  });

type Trigger = TaskBundleV1["triggers"][number];
const onCreated = (mentions: string[], authors: "maintainers" | "any"): Trigger[] =>
  [{ kind: "github.issue_comment.created", labelsAll: [], mentions, authors }];
const onEdited = (mentions: string[]): Trigger[] =>
  [{ kind: "github.issue_comment.edited", labelsAll: [], mentions, authors: "maintainers" }];

describe("trigger filters", () => {
  it("admits maintainers only when authors is maintainers, failing closed without an association", () => {
    for (const association of ["OWNER", "MEMBER", "COLLABORATOR"]) {
      expect(triggerFiltersExclude(created("hi", association), onCreated([], "maintainers"))).toBe(false);
    }
    for (const association of ["CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", "NONE", undefined]) {
      expect(triggerFiltersExclude(created("hi", association), onCreated([], "maintainers"))).toBe(true);
    }
    expect(triggerFiltersExclude(created("hi", "NONE"), onCreated([], "any"))).toBe(false);
  });

  it("tells a missing association (an old bridge) apart from a non-maintainer", () => {
    const triggers = onCreated([], "maintainers");
    expect(triggerAssociationMissing(created("hi"), triggers)).toBe(true);
    expect(triggerAssociationMissing(created("hi", "NONE"), triggers)).toBe(false);
    expect(triggerAssociationMissing(created("hi"), onCreated([], "any"))).toBe(false);
  });

  it("matches mentions case-insensitively on word boundaries", () => {
    const triggers = onCreated(["gardener"], "any");
    for (const body of ["@gardener fix this", "Hey @Gardener, please", "(@GARDENER)", "cc:@gardener.", "line\n@gardener"]) {
      expect(triggerFiltersExclude(created(body), triggers)).toBe(false);
    }
    for (const body of ["@gardener-bot fix", "@gardeners", "mail me@gardener.dev", "@gardener/team", "gardener", "x@gardener"]) {
      expect(triggerFiltersExclude(created(body), triggers)).toBe(true);
    }
  });

  it("runs an edit only when it added a mention", () => {
    const triggers = onEdited(["gardener"]);
    expect(triggerFiltersExclude(edited("@gardener please", "please"), triggers)).toBe(false);
    // Already mentioned before the edit, or the edit left the body alone.
    expect(triggerFiltersExclude(edited("@gardener please!", "@gardener please"), triggers)).toBe(true);
    expect(triggerFiltersExclude(edited("@gardener please", undefined), triggers)).toBe(true);
    // Removed rather than added.
    expect(triggerFiltersExclude(edited("please", "@gardener please"), triggers)).toBe(true);
    // A second handle added counts even when the first was already there.
    expect(triggerFiltersExclude(edited("@gardener @helper", "@gardener"), onEdited(["gardener", "helper"]))).toBe(false);
  });

  it("runs every edit when the edited trigger has no mentions", () => {
    const triggers: Trigger[] = [{ kind: "github.issue_comment.edited", labelsAll: [], mentions: [], authors: "maintainers" }];
    expect(triggerFiltersExclude(edited("same", undefined), triggers)).toBe(false);
  });

  it("checks the text the trigger names: the issue body on issue.opened", () => {
    const triggers: Trigger[] = [{ kind: "github.issue.opened", labelsAll: [], mentions: ["gardener"], authors: "maintainers" }];
    const opened = (body: string, authorAssociation?: string) =>
      event("github.issue.opened", { issue: { ...issue, body, ...(authorAssociation ? { authorAssociation } : {}) } });
    expect(triggerFiltersExclude(opened("@gardener triage", "MEMBER"), triggers)).toBe(false);
    expect(triggerFiltersExclude(opened("@gardener triage", "NONE"), triggers)).toBe(true);
    expect(triggerFiltersExclude(opened("triage", "MEMBER"), triggers)).toBe(true);
  });

  it("never turns a trigger the event does not select into a skip", () => {
    // A different kind, or labels the workflow already filters exactly: not a skip, so the run still fails.
    expect(triggerFiltersExclude(created("@gardener"), [{ kind: "github.issue.opened", labelsAll: [], mentions: [], authors: "any" }])).toBe(false);
    expect(triggerFiltersExclude(created("hi", "NONE"), [
      { kind: "github.issue_comment.created", labelsAll: ["bug"], mentions: [], authors: "maintainers" },
    ])).toBe(false);
    // Manual runs carry no filters.
    expect(triggerFiltersExclude(event("github.workflow_dispatch", {}), [{ kind: "github.workflow_dispatch" }])).toBe(false);
  });

  it("admits the event when any selecting trigger's filters pass", () => {
    const triggers: Trigger[] = [
      { kind: "github.issue_comment.created", labelsAll: [], mentions: ["gardener"], authors: "maintainers" },
    ];
    expect(triggerFiltersExclude(created("@gardener", "OWNER"), triggers)).toBe(false);
  });
});
