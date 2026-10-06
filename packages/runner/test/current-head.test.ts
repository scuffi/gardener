import type { RunnerEventV1 } from "@gardener/protocol";
import { describe, expect, it, vi } from "vitest";
import { fetchCurrentPullRequest, UnconfirmedHeadError, withCurrentPullRequestHead, type CurrentPullRequest } from "../src/current-head";
import { normalizeGitHubEvent } from "../src/event";

const actor = { id: 45369682, login: "scuffi" };
const eventHead = "d".repeat(40);
const movedHead = "e".repeat(40);

function reviewEvent(headRepoId = 1374842705): RunnerEventV1 {
  return normalizeGitHubEvent("pull_request_review", {
    repository: { id: 1374842705, full_name: "scuffi/gardener", default_branch: "main" },
    action: "submitted",
    pull_request: {
      id: 555,
      number: 12,
      title: "Fix",
      body: null,
      labels: [],
      user: actor,
      draft: false,
      state: "open",
      merged: false,
      updated_at: "2026-10-06T12:00:00.000Z",
      base: { ref: "main", sha: "a".repeat(40), repo: { id: 1374842705, full_name: "scuffi/gardener" } },
      head: { ref: "gardener/fix-12", sha: eventHead, repo: { id: headRepoId, full_name: "scuffi/gardener" } },
    },
    review: { id: 9, state: "COMMENTED", body: "please fix", user: actor },
  }) as RunnerEventV1;
}

const live: CurrentPullRequest = {
  state: "open",
  updatedAt: "2026-10-06T12:05:00Z",
  headSha: movedHead,
  headRef: "gardener/fix-12",
  headRepoId: "1374842705",
  baseRepoId: "1374842705",
};

function head(event: RunnerEventV1): { sha: string; updatedAt: string | undefined } {
  const pullRequest = (event as { pullRequest: { head: { sha: string }; updatedAt?: string } }).pullRequest;
  return { sha: pullRequest.head.sha, updatedAt: pullRequest.updatedAt };
}

describe("planning on the pull request's current head", () => {
  it("leaves the event alone when the checkout is the event's head or absent", () => {
    const event = reviewEvent();
    expect(withCurrentPullRequestHead(event, eventHead, null)).toBe(event);
    expect(withCurrentPullRequestHead(event, undefined, null)).toBe(event);
  });

  it("moves the event to a confirmed current head and its new updatedAt", () => {
    const moved = withCurrentPullRequestHead(reviewEvent(), movedHead, live);
    expect(head(moved)).toEqual({ sha: movedHead, updatedAt: "2026-10-06T12:05:00Z" });
  });

  it("refuses anything it cannot confirm", () => {
    const cases: Array<[CurrentPullRequest | null, RegExp]> = [
      [null, /could not be read/],
      [{ ...live, state: "closed" }, /no longer open/],
      [{ ...live, headSha: "f".repeat(40) }, /head has moved again, to f{40}/],
      [{ ...live, headRef: "other" }, /head branch changed/],
      [{ ...live, headRepoId: null }, /same-repository/],
      [{ ...live, headRepoId: "42" }, /same-repository/],
      [{ ...live, baseRepoId: "42", headRepoId: "42" }, /same-repository/],
    ];
    for (const [current, reason] of cases) {
      expect(() => withCurrentPullRequestHead(reviewEvent(), movedHead, current)).toThrow(reason);
      expect(() => withCurrentPullRequestHead(reviewEvent(), movedHead, current)).toThrow(UnconfirmedHeadError);
    }
    // Both commits are named, so the log says what was expected and what was found.
    expect(() => withCurrentPullRequestHead(reviewEvent(), movedHead, null))
      .toThrow(`Pull request #12: the event's head is ${eventHead} and the workflow checked out ${movedHead}, but its current head could not be read.`);
  });

  it("never moves a fork pull request's event", () => {
    expect(() => withCurrentPullRequestHead(reviewEvent(9999), movedHead, { ...live, headRepoId: "9999" })).toThrow(/same-repository/);
  });
});

describe("reading the current pull request", () => {
  const body = {
    state: "open",
    updated_at: "2026-10-06T12:05:00Z",
    head: { sha: movedHead, ref: "gardener/fix-12", repo: { id: 1374842705 } },
    base: { repo: { id: 1374842705 } },
  };

  it("reads the fields it needs with the repository token", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
    await expect(fetchCurrentPullRequest({ repository: "scuffi/gardener", number: 12, token: "t", fetch: fetcher as typeof fetch }))
      .resolves.toEqual(live);
    expect(fetcher).toHaveBeenCalledWith("https://api.github.com/repos/scuffi/gardener/pulls/12", expect.objectContaining({ redirect: "error" }));
  });

  it("reports a deleted head repository as null", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ ...body, head: { ...body.head, repo: null } }), { status: 200 }));
    await expect(fetchCurrentPullRequest({ repository: "scuffi/gardener", number: 12, token: "t", fetch: fetcher as typeof fetch }))
      .resolves.toMatchObject({ headRepoId: null });
  });

  it("returns null on errors, bad shapes and bad input", async () => {
    const failing = vi.fn(async () => new Response("nope", { status: 404 }));
    const malformed = vi.fn(async () => new Response(JSON.stringify({ state: "open" }), { status: 200 }));
    const throwing = vi.fn(async () => { throw new Error("network"); });
    for (const fetcher of [failing, malformed, throwing]) {
      await expect(fetchCurrentPullRequest({ repository: "scuffi/gardener", number: 12, token: "t", fetch: fetcher as typeof fetch })).resolves.toBeNull();
    }
    await expect(fetchCurrentPullRequest({ repository: "scuffi/gardener", number: 12, token: "", fetch: failing as typeof fetch })).resolves.toBeNull();
    await expect(fetchCurrentPullRequest({ repository: "../x", number: 12, token: "t", fetch: failing as typeof fetch })).resolves.toBeNull();
    await expect(fetchCurrentPullRequest({ repository: "scuffi/gardener", number: 0, token: "t", fetch: failing as typeof fetch })).resolves.toBeNull();
  });
});
