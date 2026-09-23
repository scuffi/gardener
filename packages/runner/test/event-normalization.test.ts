import { describe, expect, it } from "vitest";
import { runnerEventV1Schema } from "@gardener/protocol";
import { normalizeGitHubEvent } from "../src/event";

const actor = { id: 45369682, login: "scuffi" };

const issue = {
  id: 999,
  number: 1,
  title: "Broken build",
  body: "details",
  state: "open",
  updated_at: "2026-09-22T12:00:00.000Z",
  labels: [{ name: "bug" }, { name: "triage" }],
  user: actor,
};

const pullRequest = {
  id: 555,
  number: 12,
  title: "Improve docs",
  body: null,
  labels: [{ name: "ready" }],
  user: actor,
  draft: false,
  state: "open",
  merged: false,
  updated_at: "2026-09-22T12:00:00.000Z",
  base: { ref: "main", sha: "a".repeat(40), repo: { id: 1374842705, full_name: "scuffi/gardener" } },
  head: { ref: "feature", sha: "d".repeat(40), repo: { id: 9999, full_name: "forker/gardener" } },
};

const discussion = {
  id: 77,
  node_id: "D_kwDOAbc123",
  number: 4,
  title: "How do I?",
  body: "question",
  labels: [],
  user: actor,
  category: { name: "Q&A" },
  answer_chosen_at: null,
  state: "open",
  updated_at: "2026-09-22T12:00:00.000Z",
};

/**
 * The normalizer is a pure function, so tests call it directly. `main.ts` owns
 * reading the event file and is never imported here.
 */
async function normalize(eventName: string, payload: unknown): Promise<unknown> {
  const withRepository = payload !== null && typeof payload === "object" && !Array.isArray(payload)
    ? { repository: { id: 1374842705, full_name: "scuffi/gardener", default_branch: "main" }, ...payload }
    : payload;
  return normalizeGitHubEvent(eventName, withRepository);
}

describe("runner event normalization", () => {
  it("normalizes every supported event family into the bounded wire contract", async () => {
    const cases: Array<[string, unknown, string]> = [
      ["issues", { action: "opened", issue }, "github.issue.opened"],
      ["issues", { action: "labeled", issue, label: { name: "bug" } }, "github.issue.labeled"],
      ["issue_comment", { action: "created", issue, comment: { id: 3, body: "hi", updated_at: "2026-09-22T12:00:00.000Z", user: actor } }, "github.issue_comment.created"],
      ["pull_request", { action: "opened", pull_request: pullRequest }, "github.pull_request.opened"],
      ["pull_request", { action: "synchronize", pull_request: pullRequest }, "github.pull_request.synchronize"],
      ["pull_request_review", {
        action: "submitted",
        pull_request: pullRequest,
        review: { id: 9, state: "APPROVED", body: null, user: actor },
      }, "github.pull_request_review.submitted"],
      ["pull_request_review_comment", {
        action: "created",
        pull_request: pullRequest,
        comment: { id: 4, body: "nit", updated_at: "2026-09-22T12:00:00.000Z", user: actor },
      }, "github.pull_request_review_comment.created"],
      ["push", {
        ref: "refs/heads/main",
        before: "e".repeat(40),
        after: "f".repeat(40),
        commits: [{ id: "f".repeat(40), message: "fix", author: { name: "a", email: "a@b.c" } }],
      }, "github.push"],
      ["workflow_dispatch", { inputs: { prompt: "Inspect the repository." } }, "github.workflow_dispatch"],
      ["schedule", { schedule: "0 3 * * 1" }, "github.schedule"],
      ["discussion", { action: "created", discussion }, "github.discussion.created"],
      ["discussion_comment", {
        action: "created",
        discussion,
        comment: { id: 8, node_id: "DC_kwDOAbc", body: "hi", updated_at: "2026-09-22T12:00:00.000Z", user: actor },
      }, "github.discussion_comment.created"],
    ];

    for (const [eventName, payload, expectedKind] of cases) {
      const normalized = await normalize(eventName, payload);
      expect(runnerEventV1Schema.parse(normalized)).toMatchObject({ kind: expectedKind });
    }
  });

  it("lowercases review state and preserves fork head identity for the runtime to refuse", async () => {
    const normalized = await normalize("pull_request", { action: "opened", pull_request: pullRequest }) as {
      pullRequest: { head: { repo: { id: string; fullName: string } } };
    };
    expect(normalized.pullRequest.head.repo).toEqual({ id: "9999", fullName: "forker/gardener" });

    const review = await normalize("pull_request_review", {
      action: "submitted",
      pull_request: pullRequest,
      review: { id: 9, state: "CHANGES_REQUESTED", body: null, user: actor },
    }) as { review: { state: string } };
    expect(review.review.state).toBe("changes_requested");
  });

  it("carries no raw payload fields beyond the bounded contract", async () => {
    const normalized = await normalize("issues", {
      action: "opened",
      issue,
      installation: { id: 1, secretish: "do-not-forward" },
      sender: { id: 1, login: "someone-else" },
    });
    const serialized = JSON.stringify(normalized);
    expect(serialized).not.toContain("do-not-forward");
    expect(serialized).not.toContain("installation");
    expect(serialized).not.toContain("someone-else");
    expect(Object.keys(normalized as object).sort()).toEqual(["issue", "kind", "repository", "schemaVersion"]);
  });

  it("refuses excluded and unsupported events", async () => {
    await expect(normalize("pull_request_target", { action: "opened", pull_request: pullRequest }))
      .rejects.toThrow(/does not support pull_request_target/);
    await expect(normalize("release", { action: "published" })).rejects.toThrow(/does not support release/);
    await expect(normalize("issues", { action: "deleted", issue })).rejects.toThrow(/does not support issues: deleted/);
    await expect(normalize("issue_comment", { action: "edited", issue, comment: { id: 3, body: "x", updated_at: "2026-09-22T12:00:00.000Z", user: actor } }))
      .rejects.toThrow(/does not support issue_comment: edited/);
  });

  it("fails closed on incomplete payloads and empty dispatch prompts", async () => {
    await expect(normalize("issues", { action: "opened" })).rejects.toThrow(/missing an issue/);
    await expect(normalize("pull_request", { action: "opened" })).rejects.toThrow(/missing a pull request/);
    await expect(normalize("workflow_dispatch", { inputs: { prompt: "   " } })).rejects.toThrow(/non-empty prompt/);
    await expect(normalize("schedule", {})).rejects.toThrow(/missing its cron expression/);
  });
});
