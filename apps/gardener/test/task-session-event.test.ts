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
  it("carries the whole runner payload, dropping only the wire envelope", () => {
    expect(source).toMatch(/function eventPayload\(event: RunnerEventV1\)[^{]*\{\n  const \{ schemaVersion: _schemaVersion, \.\.\.payload \} = event;\n  return payload;\n\}/);
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
});
