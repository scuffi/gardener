import { describe, expect, it } from "vitest";
import { operationCatalog, operationKindValues, type OperationKind } from "../src/operations";
import {
  directTriggerScopeKinds,
  triggeringPullRequestKinds,
  triggeringPullRequestRefusal,
  triggerScopeClassification,
  triggerScopeRefusal,
  type TaskEventResourceV1,
} from "../src/task";

const issue5: TaskEventResourceV1 = { kind: "issue", id: "500", number: 5 };
const pull5: TaskEventResourceV1 = { kind: "pull_request", id: "501", number: 5 };
const discussion5: TaskEventResourceV1 = { kind: "discussion", id: "502", number: 5, nodeId: "D_5" };
const none = new Map<string, OperationKind>();

/** The design's table (§2), restated so a change to either is a deliberate one. */
const expected = {
  issueNumber: [
    "issue.label.add", "issue.label.remove", "issue.comment.create", "issue.comment.update",
    "issue.close", "issue.reopen", "issue.assignee.add", "issue.assignee.remove",
  ],
  pullNumber: [
    "pull_request.comment.create", "pull_request.comment.update", "pull_request.review.submit",
    "pull_request.reviewer.request", "pull_request.reviewer.remove", "pull_request.update",
    "pull_request.label.add", "pull_request.label.remove", "pull_request.update_branch",
    "pull_request.review_comment.reply", "pull_request.review_thread.resolve", "pull_request.merge",
    "commit.merge_base",
  ],
  discussionNumber: [
    "discussion.comment.create", "discussion.comment.update", "discussion.answer.mark",
    "discussion.answer.unmark", "discussion.close", "discussion.reopen",
  ],
  creates: ["issue.create", "pull_request.open", "pull_request.open_draft", "branch.create", "release.create"],
  checkout: ["commit.create"],
  never: ["release.update", "release.publish", "release.delete", "check.rerun"],
} as const satisfies Record<string, readonly OperationKind[]>;

function targetField(kind: OperationKind): "issueNumber" | "pullNumber" | "discussionNumber" | undefined {
  const scope = triggerScopeClassification[kind];
  return scope?.allow === "trigger" ? scope.field : undefined;
}

/** The resource of the matching kind numbered 5, for a kind that targets one. */
function triggerFor(kind: OperationKind): TaskEventResourceV1 {
  const field = targetField(kind);
  return field === "discussionNumber" ? discussion5 : field === "pullNumber" ? pull5 : issue5;
}

describe("trigger scope classification", () => {
  it("classifies every operation kind, so a new kind fails until someone classifies it", () => {
    expect(operationKindValues).toHaveLength(37);
    const unclassified = operationKindValues.filter((kind) => !Object.hasOwn(triggerScopeClassification, kind));
    expect(unclassified).toEqual([]);
    expect(Object.keys(triggerScopeClassification).sort()).toEqual([...operationKindValues].sort());
  });

  it("matches the design's table exactly", () => {
    const listed = Object.values(expected).flat();
    expect([...listed].sort()).toEqual([...operationKindValues].sort());
    for (const field of ["issueNumber", "pullNumber", "discussionNumber"] as const) {
      for (const kind of expected[field]) expect(triggerScopeClassification[kind]).toEqual({ allow: "trigger", field });
    }
    for (const allow of ["creates", "checkout", "never"] as const) {
      for (const kind of expected[allow]) expect(triggerScopeClassification[kind]).toEqual({ allow });
    }
  });

  it("refuses a kind it has no classification for", () => {
    expect(triggerScopeRefusal("issue.transfer", { issueNumber: 5 }, {}, issue5, none)).toMatch(/issue\.transfer is not allowed/);
    expect(triggerScopeRefusal("__proto__", {}, {}, issue5, none)).toMatch(/is not allowed/);
  });
});

describe("triggerScopeRefusal", () => {
  it("decides every kind on its own trigger, another number, and no resource", () => {
    for (const kind of operationKindValues) {
      const field = targetField(kind);
      const resource = triggerFor(kind);
      const onTrigger = field === undefined ? {} : { [field]: 5 };
      const elsewhere = field === undefined ? {} : { [field]: 6 };
      const allow = triggerScopeClassification[kind]!.allow;
      if (allow === "never") {
        expect(triggerScopeRefusal(kind, onTrigger, {}, resource, none), kind).toMatch(/is not allowed: this run is confined/);
        expect(triggerScopeRefusal(kind, onTrigger, {}, null, none), kind).toMatch(/is not allowed/);
      } else if (allow === "trigger") {
        expect(triggerScopeRefusal(kind, onTrigger, {}, resource, none), kind).toBeUndefined();
        expect(triggerScopeRefusal(kind, elsewhere, {}, resource, none), kind).toMatch(/may act only on .*#5, which triggered this run/);
        expect(triggerScopeRefusal(kind, onTrigger, {}, null, none), kind).toMatch(/needs a run triggered from an issue, pull request or discussion/);
        expect(triggerScopeRefusal(kind, {}, {}, resource, none), kind).toMatch(/may act only on/);
      } else {
        // Creating something new, or committing on the run's own checkout, needs no trigger.
        expect(triggerScopeRefusal(kind, {}, {}, resource, none), kind).toBeUndefined();
        expect(triggerScopeRefusal(kind, {}, {}, null, none), kind).toBeUndefined();
      }
    }
  });

  it("matches kind as well as number: discussion #5 is not issue #5", () => {
    expect(triggerScopeRefusal("discussion.comment.create", { discussionNumber: 5 }, {}, discussion5, none)).toBeUndefined();
    expect(triggerScopeRefusal("discussion.comment.create", { discussionNumber: 5 }, {}, issue5, none)).toMatch(/only on issue #5/);
    expect(triggerScopeRefusal("discussion.comment.create", { discussionNumber: 5 }, {}, pull5, none)).toMatch(/only on pull request #5/);
    expect(triggerScopeRefusal("issue.comment.create", { issueNumber: 5 }, {}, discussion5, none)).toMatch(/only on discussion #5/);
    expect(triggerScopeRefusal("pull_request.comment.create", { pullNumber: 5 }, {}, discussion5, none)).toMatch(/only on discussion #5/);
  });

  it("treats a pull request as an issue, and a conversation comment's issue as its pull request", () => {
    expect(triggerScopeRefusal("issue.label.add", { issueNumber: 5 }, {}, pull5, none)).toBeUndefined();
    expect(triggerScopeRefusal("pull_request.merge", { pullNumber: 5 }, {}, issue5, none)).toBeUndefined();
    expect(triggerScopeRefusal("pull_request.review_thread.resolve", { pullNumber: 5 }, {}, issue5, none)).toBeUndefined();
    expect(triggerScopeRefusal("pull_request.merge", { pullNumber: 6 }, {}, issue5, none)).toMatch(/only on issue #5/);
  });

  it("refuses a number that only looks right", () => {
    expect(triggerScopeRefusal("issue.close", { issueNumber: "5" }, {}, issue5, none)).toMatch(/only on issue #5/);
    expect(triggerScopeRefusal("issue.close", null, {}, issue5, none)).toMatch(/only on issue #5/);
  });

  describe("created resources", () => {
    const earlier = new Map<string, OperationKind>([
      ["file", "issue.create"],
      ["open", "pull_request.open"],
      ["draft", "pull_request.open_draft"],
      ["note", "issue.comment.create"],
      ["foreign", "issue.label.add"],
    ]);

    it("allows a reference to the issue or pull request an earlier step created, even with no trigger", () => {
      for (const resource of [issue5, discussion5, null]) {
        expect(triggerScopeRefusal("issue.label.add", { issueNumber: 1 }, { "/issueNumber": { step: "file", output: "issueNumber" } }, resource, earlier))
          .toBeUndefined();
        expect(triggerScopeRefusal("pull_request.label.add", { pullNumber: 1 }, { "/pullNumber": { step: "open", output: "pullNumber" } }, resource, earlier))
          .toBeUndefined();
      }
    });

    it("never lets a confined run merge or review a pull request it opened", () => {
      for (const kind of directTriggerScopeKinds) {
        for (const resource of [pull5, issue5, null]) {
          for (const step of ["open", "draft"]) {
            expect(triggerScopeRefusal(kind, { pullNumber: 1 }, { "/pullNumber": { step, output: "pullNumber" } }, resource, earlier), kind)
              .toMatch(/directly, not by reference: this run is confined to what triggered it, so it may not (merge|review) a pull request the run opened/);
          }
        }
        // The triggering pull request, named directly, is still fine.
        expect(triggerScopeRefusal(kind, { pullNumber: 5 }, {}, pull5, earlier), kind).toBeUndefined();
        // These are not triggeringPullRequestKinds: outside trigger scope a reference stands.
        expect(triggeringPullRequestRefusal(kind, { pullNumber: 1 }, { "/pullNumber": { step: "open", output: "pullNumber" } }, pull5)).toBeUndefined();
      }
      expect([...directTriggerScopeKinds].sort()).toEqual(["pull_request.merge", "pull_request.review.submit"]);
    });

    it("refuses a reference to anything else", () => {
      const refusals = [
        // A step that acted on an existing issue publishes its number too, which may be anyone's.
        triggerScopeRefusal("issue.close", { issueNumber: 1 }, { "/issueNumber": { step: "note", output: "issueNumber" } }, issue5, earlier),
        triggerScopeRefusal("issue.close", { issueNumber: 1 }, { "/issueNumber": { step: "foreign", output: "issueNumber" } }, issue5, earlier),
        // A created pull request is not a created issue for this field, and vice versa.
        triggerScopeRefusal("issue.close", { issueNumber: 1 }, { "/issueNumber": { step: "open", output: "pullNumber" } }, issue5, earlier),
        triggerScopeRefusal("pull_request.label.add", { pullNumber: 1 }, { "/pullNumber": { step: "file", output: "issueNumber" } }, pull5, earlier),
        // The right step, the wrong output.
        triggerScopeRefusal("issue.close", { issueNumber: 1 }, { "/issueNumber": { step: "file", output: "issueUrl" } }, issue5, earlier),
        // A step that does not run earlier.
        triggerScopeRefusal("issue.close", { issueNumber: 1 }, { "/issueNumber": { step: "later", output: "issueNumber" } }, issue5, earlier),
        // Discussions are never created by a plan.
        triggerScopeRefusal("discussion.close", { discussionNumber: 1 }, { "/discussionNumber": { step: "file", output: "issueNumber" } }, discussion5, earlier),
        // A template is not a whole-field output.
        triggerScopeRefusal("issue.close", { issueNumber: 1 }, { "/issueNumber": { placeholders: { n: { step: "file", output: "issueNumber" } } } }, issue5, earlier),
        // The function takes references unparsed, so a template that also looks like an output is still a template.
        triggerScopeRefusal("issue.close", { issueNumber: 1 }, {
          "/issueNumber": { step: "file", output: "issueNumber", placeholders: { n: { step: "file", output: "issueNumber" } } },
        }, issue5, earlier),
        triggerScopeRefusal("issue.close", { issueNumber: 1 }, { "/issueNumber": null }, issue5, earlier),
      ];
      for (const refusal of refusals) expect(refusal).toMatch(/may reference \w+ only from an earlier step of this plan that created it/);
    });

    it("never exempts the kinds confined to the triggering pull request, so both checks refuse", () => {
      const reference = { "/pullNumber": { step: "open", output: "pullNumber" } };
      for (const kind of triggeringPullRequestKinds) {
        expect(triggerScopeRefusal(kind, { pullNumber: 5 }, reference, pull5, earlier), kind).toMatch(/directly, not by reference/);
        expect(triggeringPullRequestRefusal(kind, { pullNumber: 5 }, reference, pull5), kind).toMatch(/directly, not by reference/);
      }
    });

    it("leaves references to fields that name no target alone", () => {
      expect(triggerScopeRefusal("issue.comment.create", { issueNumber: 5, body: "x" }, { "/body": { step: "foreign", output: "label" } }, issue5, earlier))
        .toBeUndefined();
    });
  });
});

describe("high-impact kinds", () => {
  it("are exactly the kinds that reach past the thread they act on", () => {
    expect(operationCatalog.filter((entry) => entry.highImpact).map((entry) => entry.kind).sort()).toEqual([
      "pull_request.merge",
      "pull_request.review.submit",
      "release.create",
      "release.delete",
      "release.publish",
      "release.update",
    ]);
  });
});
