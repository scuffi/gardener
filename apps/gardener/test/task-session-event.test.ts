import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { normalizedEventV1Schema, taskCheckoutSha } from "@gardener/contracts";
import { runnerEventV1Schema } from "@gardener/protocol";

/**
 * The runner event → normalized event conversion in `session.ts` keeps the
 * runner's payload and adds the identity it takes from the OIDC hello. A
 * comment's pull request and the checked-out head must survive it, or a
 * comment-triggered run would plan on the default branch while the runner
 * checked out the pull request. `session.ts` cannot be imported under
 * vitest, so the conversion's shape is checked from its source and its
 * result against the contract.
 */
const source = readFileSync(new URL("../src/task-runtime/session.ts", import.meta.url), "utf8");

const sha = (character: string) => character.repeat(40);
const actor = { id: "45369682", login: "scuffi" };
const runnerComment = {
  schemaVersion: "gardener.runner.event/v1",
  kind: "github.issue_comment.created",
  repository: { defaultBranch: "main" },
  issue: { id: "555", number: 12, title: "Fix", body: null, labels: [], author: actor },
  comment: { id: "9", body: "@gardener merge main", author: actor, authorAssociation: "OWNER" },
  pullRequest: {
    id: "555", number: 12, title: "Fix", body: null, labels: [], author: actor, draft: false, state: "open", merged: false,
    base: { ref: "main", sha: sha("a"), repo: { id: "1374842705", fullName: "scuffi/gardener" } },
    head: { ref: "feature", sha: sha("d"), repo: { id: "1374842705", fullName: "scuffi/gardener" } },
  },
  checkoutSha: sha("d"),
};

describe("runner event conversion", () => {
  it("carries the whole runner payload, dropping only the wire envelope and the actor's permission", () => {
    expect(source).toMatch(/function eventPayload\(event: RunnerEventV1\)[^{]*\{\n(?:  \/\/.*\n)*  const \{ schemaVersion: _schemaVersion, actorPermission: _actorPermission, \.\.\.payload \} = event;\n  return payload;\n\}/);
    expect(source).toMatch(/event: \{\n        \.\.\.eventPayload\(runnerEvent\),/);
  });

  it("keeps a comment's pull request and checked-out head through to the normalized event", () => {
    const { schemaVersion: _schemaVersion, ...payload } = runnerEventV1Schema.parse(runnerComment);
    const event = normalizedEventV1Schema.parse({
      ...payload,
      schemaVersion: "gardener.normalized-event/v1",
      eventId: "github:1:1",
      occurredAt: "2026-10-12T12:00:00.000Z",
      repository: {
        id: "1374842705", ownerId: "45369682", owner: "scuffi", name: "gardener", fullName: "scuffi/gardener",
        visibility: "private", commitSha: sha("b"), ref: "refs/heads/main", defaultBranch: "main",
      },
      workflow: {
        runId: "1", runAttempt: 1, eventName: "issue_comment", workflowRef: "scuffi/gardener/.github/workflows/gardener.yml@refs/heads/main",
        jobWorkflowRef: `scuffi/gardener/.github/workflows/gardener-task.yml@${sha("c")}`, runnerEnvironment: "github-hosted",
      },
      actor,
    });
    expect(event).toMatchObject({ checkoutSha: sha("d"), pullRequest: { number: 12, head: { sha: sha("d") } }, issue: { number: 12 } });
    expect(taskCheckoutSha({ checkout: "pull-request-head" }, event)).toBe(sha("d"));
  });

  it("drops the actor's permission, which the strict normalized event has no place for", () => {
    const normalized = (payload: Record<string, unknown>) => normalizedEventV1Schema.safeParse({
      ...payload,
      schemaVersion: "gardener.normalized-event/v1",
      eventId: "github:1:1",
      occurredAt: "2026-10-12T12:00:00.000Z",
      repository: {
        id: "1374842705", ownerId: "45369682", owner: "scuffi", name: "gardener", fullName: "scuffi/gardener",
        visibility: "private", commitSha: sha("b"), ref: "refs/heads/main", defaultBranch: "main",
      },
      workflow: {
        runId: "1", runAttempt: 1, eventName: "issue_comment", workflowRef: "scuffi/gardener/.github/workflows/gardener.yml@refs/heads/main",
        jobWorkflowRef: `scuffi/gardener/.github/workflows/gardener-task.yml@${sha("c")}`, runnerEnvironment: "github-hosted",
      },
      actor,
    });
    const { schemaVersion: _schemaVersion, ...payload } = runnerEventV1Schema.parse({ ...runnerComment, actorPermission: { actorId: "45369682", permission: "write" } });
    expect(normalized(payload).success).toBe(false);
    const { actorPermission: _actorPermission, ...stripped } = payload;
    expect(normalized(stripped).success).toBe(true);
  });
});

describe("runner input from a newer release", () => {
  it("says the workflow is probably newer than the runtime, without quoting the input", () => {
    // A strict-schema refusal of the hello or the event usually means the
    // repository's workflows moved to a newer release before the runtime did.
    for (const part of ["hello", "event"]) {
      expect(source).toContain(`This runtime does not accept the runner's ${part} (\${field}), so the workflow is probably on a newer release than the runtime. \${releaseMismatchAdvice(this.env.GARDENER_RELEASE_WORKFLOW_REF)}`);
    }
    expect(source).not.toMatch(/runnerEventV1Schema\.parse\(/);
    expect(source).not.toMatch(/runnerHelloV1Schema\.parse\(/);
  });

  it("refuses an event field this release does not know", () => {
    // The refusal the runtime turns into that message: a strict schema rejects unknown fields.
    const result = runnerEventV1Schema.safeParse({ ...runnerComment, addedByANewerRelease: true });
    expect(result.success).toBe(false);
  });
});
