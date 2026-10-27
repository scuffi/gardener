import { describe, expect, it } from "vitest";
import {
  eventNameByTriggerKind,
  starterSubject,
  taskRunStarterV1Schema,
  type AuthorPermissionV1,
  type NormalizedEventV1,
} from "@gardener/contracts";
import { isBotDispatch, trustedStarter } from "../src/task-runtime/session-checks";

const REPOSITORY_ID = "1374842705";
const maintainer = { id: "1", login: "maintainer" };
const outsider = { id: "2", login: "outsider" };
const labeller = { id: "3", login: "labeller" };
const dependabot = { id: "49699333", login: "dependabot[bot]" };

function event(kind: NormalizedEventV1["kind"], extra: Record<string, unknown> = {}): NormalizedEventV1 {
  return {
    schemaVersion: "gardener.normalized-event/v1",
    eventId: "github:1:1",
    occurredAt: "2026-10-20T12:00:00.000Z",
    repository: {
      id: REPOSITORY_ID, ownerId: "9", owner: "scuffi", name: "demo", fullName: "scuffi/demo", visibility: "public",
      commitSha: "b".repeat(40), ref: "refs/heads/main", defaultBranch: "main",
    },
    workflow: {
      runId: "1", runAttempt: 1, eventName: eventNameByTriggerKind[kind],
      workflowRef: "scuffi/demo/.github/workflows/g.yml@refs/heads/main",
      jobWorkflowRef: "scuffi/gardener/.github/workflows/gardener-task.yml@" + "c".repeat(40),
      runnerEnvironment: "github-hosted",
    },
    actor: maintainer,
    kind,
    ...extra,
  } as NormalizedEventV1;
}

const issue = (author: { id: string; login: string }, authorAssociation?: string, authorPermission?: string) => ({
  id: "999", number: 4, title: "t", body: "b", labels: [], author,
  ...(authorAssociation === undefined ? {} : { authorAssociation }),
  ...(authorPermission === undefined ? {} : { authorPermission }),
});
const pullRequest = (author: { id: string; login: string }, headRepositoryId: string | null, authorAssociation = "NONE") => ({
  id: "555", number: 12, title: "t", body: null, labels: [], author, authorAssociation, draft: false, state: "open", merged: false,
  base: { ref: "main", sha: "a".repeat(40), repo: { id: REPOSITORY_ID, fullName: "scuffi/demo" } },
  head: {
    ref: "feature", sha: "d".repeat(40),
    repo: headRepositoryId === null ? null : { id: headRepositoryId, fullName: headRepositoryId === REPOSITORY_ID ? "scuffi/demo" : "fork/demo" },
  },
});
const push = { ref: "refs/heads/main", before: "a".repeat(40), after: "b".repeat(40), forced: false, commits: [], includedCommits: 0, commitsTruncated: false };

function decide(
  normalized: NormalizedEventV1,
  actor: { id: string; login: string },
  permission?: AuthorPermissionV1,
  actorId: string = actor.id,
) {
  const actorPermission = permission === undefined ? undefined : { actorId, permission };
  const starter = trustedStarter({ eventName: normalized.workflow.eventName, actor, event: normalized, actorPermission });
  // Every decision must be one the strict request schema accepts.
  expect(taskRunStarterV1Schema.parse(starter)).toEqual(starter);
  return starter;
}

describe("trusted starter", () => {
  it("trusts schedules whoever the actor is, and manual runs a person started", () => {
    expect(decide(event("github.schedule", { cron: "0 0 * * *" }), outsider)).toEqual({ trusted: true, reason: "schedule" });
    expect(decide(event("github.workflow_dispatch"), maintainer)).toEqual({ trusted: true, reason: "manual" });
    expect(decide(event("github.schedule", { cron: "0 0 * * *" }), dependabot)).toEqual({ trusted: true, reason: "schedule" });
  });

  it("never trusts a bot's manual run, with or without a target: task.run makes dispatching prove nothing", () => {
    const actionsBot = { id: "41898282", login: "github-actions[bot]" };
    expect(decide(event("github.workflow_dispatch"), actionsBot)).toEqual({ trusted: false, reason: "bot" });
    expect(decide(event("github.workflow_dispatch", { issue: issue(outsider, "NONE") }), actionsBot)).toEqual({ trusted: false, reason: "bot" });
    expect(decide(event("github.workflow_dispatch", { issue: issue(maintainer, "OWNER") }), { id: "7", login: "some-app[bot]" }))
      .toEqual({ trusted: false, reason: "bot" });
    // A person's click still takes the manual branch, target or not.
    expect(decide(event("github.workflow_dispatch", { issue: issue(outsider, "NONE") }), maintainer)).toEqual({ trusted: true, reason: "manual" });
  });

  it("trusts a push by a person and not by a bot", () => {
    expect(decide(event("github.push", { push }), outsider)).toEqual({ trusted: true, reason: "push" });
    expect(decide(event("github.push", { push }), dependabot)).toEqual({ trusted: false, reason: "bot" });
  });

  it("trusts synchronize only for a same-repository head moved by a person", () => {
    const synchronize = (head: string | null) => event("github.pull_request.synchronize", { pullRequest: pullRequest(outsider, head) });
    expect(decide(synchronize(REPOSITORY_ID), outsider)).toEqual({ trusted: true, reason: "synchronize" });
    expect(decide(synchronize("77"), outsider)).toEqual({ trusted: false, reason: "fork_head" });
    expect(decide(synchronize(null), outsider)).toEqual({ trusted: false, reason: "fork_head" });
    expect(decide(synchronize(REPOSITORY_ID), dependabot)).toEqual({ trusted: false, reason: "bot" });
  });

  it("does not trust opening a pull request from an existing branch, or the other pull request actions, by event alone", () => {
    for (const kind of ["github.pull_request.opened", "github.pull_request.reopened", "github.pull_request.edited",
      "github.pull_request.ready_for_review", "github.pull_request.converted_to_draft"] as const) {
      expect(decide(event(kind, { pullRequest: pullRequest(outsider, REPOSITORY_ID) }), outsider))
        .toEqual({ trusted: false, reason: "author_not_maintainer" });
    }
  });

  it("trusts the subject's author when they count as a maintainer, by association or looked-up permission", () => {
    for (const association of ["OWNER", "MEMBER", "COLLABORATOR"]) {
      expect(decide(event("github.issue.opened", { issue: issue(maintainer, association) }), maintainer))
        .toEqual({ trusted: true, reason: "maintainer_author" });
    }
    expect(decide(event("github.issue.opened", { issue: issue(maintainer, "CONTRIBUTOR", "write") }), maintainer))
      .toEqual({ trusted: true, reason: "maintainer_author" });
    expect(decide(event("github.issue.opened", { issue: issue(maintainer, "CONTRIBUTOR", "admin") }), maintainer))
      .toEqual({ trusted: true, reason: "maintainer_author" });
  });

  it("does not trust an outsider author, or an author with no association", () => {
    for (const association of ["CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", "NONE", undefined]) {
      expect(decide(event("github.issue.opened", { issue: issue(outsider, association) }), outsider))
        .toEqual({ trusted: false, reason: "author_not_maintainer" });
    }
    expect(decide(event("github.issue.opened", { issue: issue(outsider, "NONE", "read") }), outsider))
      .toEqual({ trusted: false, reason: "author_not_maintainer" });
    // The author's own actor permission is not how an author is judged.
    expect(decide(event("github.issue.opened", { issue: issue(outsider, "NONE") }), outsider, "write"))
      .toEqual({ trusted: false, reason: "author_not_maintainer" });
  });

  it("never trusts a bot author, even one GitHub reports as a member", () => {
    const bot = { id: "4", login: "renovate[bot]" };
    expect(decide(event("github.issue.opened", { issue: issue(bot, "MEMBER") }), bot)).toEqual({ trusted: false, reason: "bot" });
    expect(decide(event("github.issue.opened", { issue: issue(bot, "MEMBER") }), { id: "4", login: "renovate" }))
      .toEqual({ trusted: false, reason: "bot" });
  });

  it("judges the commenter, not the issue's author, on a comment", () => {
    const comment = (author: { id: string; login: string }, authorAssociation: string) =>
      event("github.issue_comment.created", { issue: issue(maintainer, "OWNER"), comment: { id: "7", body: "hi", author, authorAssociation } });
    expect(decide(comment(outsider, "NONE"), outsider)).toEqual({ trusted: false, reason: "author_not_maintainer" });
    expect(decide(comment(maintainer, "OWNER"), maintainer)).toEqual({ trusted: true, reason: "maintainer_author" });
  });

  it("judges someone acting on another's subject by the permission the bridge looked up", () => {
    const labeled = event("github.issue.labeled", { issue: issue(outsider, "NONE"), label: "bug" });
    expect(decide(labeled, labeller, "admin")).toEqual({ trusted: true, reason: "maintainer_actor" });
    expect(decide(labeled, labeller, "write")).toEqual({ trusted: true, reason: "maintainer_actor" });
    // GitHub's triage role reads as read: it can label but not write code.
    expect(decide(labeled, labeller, "read")).toEqual({ trusted: false, reason: "actor_not_maintainer" });
    expect(decide(labeled, labeller, "none")).toEqual({ trusted: false, reason: "actor_not_maintainer" });
    // A failed lookup, or an old bridge that never looks, fails closed.
    expect(decide(labeled, labeller)).toEqual({ trusted: false, reason: "actor_unknown" });
    // A permission looked up for anyone but the signed actor is someone else's, so it counts as no lookup.
    expect(decide(labeled, labeller, "admin", outsider.id)).toEqual({ trusted: false, reason: "actor_unknown" });
    expect(decide(labeled, labeller, "write", maintainer.id)).toEqual({ trusted: false, reason: "actor_unknown" });
    // A bot is never trusted, whatever a lookup says.
    expect(decide(labeled, dependabot, "write")).toEqual({ trusted: false, reason: "bot" });
  });

  it("judges an actor who labels their own issue as its author", () => {
    expect(decide(event("github.issue.labeled", { issue: issue(maintainer, "OWNER"), label: "bug" }), maintainer))
      .toEqual({ trusted: true, reason: "maintainer_author" });
    expect(decide(event("github.issue.labeled", { issue: issue(outsider, "NONE"), label: "bug" }), outsider, "write"))
      .toEqual({ trusted: false, reason: "author_not_maintainer" });
  });

  it("covers discussions and pull request reviews", () => {
    const discussion = {
      id: "1", nodeId: "D_1", number: 5, title: "t", body: "b", labels: [], author: outsider, authorAssociation: "NONE",
      category: "General", answered: false,
    };
    expect(decide(event("github.discussion.answered", { discussion }), labeller, "write")).toEqual({ trusted: true, reason: "maintainer_actor" });
    expect(decide(event("github.discussion.created", { discussion }), outsider)).toEqual({ trusted: false, reason: "author_not_maintainer" });
    const review = { id: "8", state: "approved", body: null, author: outsider, authorAssociation: "NONE" };
    expect(decide(event("github.pull_request_review.submitted", { pullRequest: pullRequest(maintainer, REPOSITORY_ID, "OWNER"), review }), outsider))
      .toEqual({ trusted: false, reason: "author_not_maintainer" });
  });

  it("knows a subject for every kind that is not decided by the event alone", () => {
    const decidedByEvent = ["github.schedule", "github.workflow_dispatch", "github.push", "github.pull_request.synchronize"];
    for (const kind of Object.keys(eventNameByTriggerKind)) {
      expect(Object.hasOwn(starterSubject, kind)).toBe(!decidedByEvent.includes(kind));
    }
  });
});

describe("isBotDispatch", () => {
  it("is a bot's manual run only, which admission matches against lineage", () => {
    expect(isBotDispatch("workflow_dispatch", "github-actions[bot]")).toBe(true);
    expect(isBotDispatch("workflow_dispatch", "my-app[bot]")).toBe(true);
    expect(isBotDispatch("workflow_dispatch", "maintainer")).toBe(false);
    expect(isBotDispatch("issues", "github-actions[bot]")).toBe(false);
  });
});
