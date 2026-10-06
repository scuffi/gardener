import { describe, expect, it } from "vitest";
import { applyFailureAdvice, planFailureAdvice, splitFailureTrail } from "../src/failure-advice";

describe("planning failure advice", () => {
  it.each([
    ["Task tool-call limit was exceeded", /`max-tool-calls`/],
    ["Task model-turn limit was exceeded", /`max-turns`/],
    ["Task model-input limit was exceeded", /`input-tokens`/],
    ["Task model-output limit was exceeded", /`output-tokens`/],
    ["Task model-runtime limit was exceeded", /`runtime-seconds`/],
    ["Task execution exceeded its runtime deadline", /`runtime-seconds`/],
    ["Task runtime deadline expired", /`runtime-seconds`/],
    ["The model stopped without calling finish_task. It may have run out of output tokens", /stopped without reporting a result/],
    ["The model provider failed (HTTP 503)", /temporary problem/],
    ["The model provider rate-limited the request (HTTP 429)", /temporary problem/],
    ["The model provider rejected the request (HTTP 401). Check the provider keys", /refused the request/],
    ["AI Gateway refused the request for insufficient balance (HTTP 402).", /refused the request/],
    ["The installation's AI Gateway could not be reached", /could not reach its AI Gateway/],
    ["Workflow x is not the repository's synced Gardener release or this runtime's. This runtime has no release pin. Usually the repository was upgraded first: run gardener upgrade --workspace <name> with", /different releases/],
    ["Repository is not enrolled for Actions task execution", /not connected/],
    ["GitHub Actions planning job was cancelled", /cancelled before it finished/],
    ["Gardener session closed before completion", /connection to the Gardener runtime dropped/],
    ["Flue task execution failed", /could not finish planning/],
  ])("%s", (message, what) => {
    expect(planFailureAdvice(message).what).toMatch(what);
  });

  it("treats a cancelled status as cancelled whatever the message", () => {
    expect(planFailureAdvice("Run was stopped", "cancelled").what).toMatch(/cancelled/);
  });

  it("does not call a failure that mentions cancelling a replaced run", () => {
    expect(planFailureAdvice("The provider request was cancelled upstream").what).not.toMatch(/cancelled before it finished/);
  });
});

describe("apply failure advice", () => {
  it.each([
    ["pull_changed", /pull request changed after Gardener planned/],
    ["issue_changed", /issue changed after/],
    ["pull_head_changed", /pull request changed after/],
    ["branch_head_changed", /branch changed after/],
    ["pull_request_revision_race", /changed after/],
    ["comment_missing", /comment no longer exists/],
    ["review_thread_missing", /deleted, or the model named a thread that doesn't exist/],
    ["canonical_marker_missing", /safety check failed/],
    ["capture_base_missing", /safety check failed/],
    ["capture_content_mismatch", /safety check failed/],
    ["branch_not_allowed", /not allowed to/],
    ["protected_commit_path", /not allowed to/],
    ["unsafe_path_segment", /not allowed to/],
    ["github_unavailable", /temporarily unavailable/],
    ["github_graphql_rate_limited", /temporarily unavailable/],
    ["github_response_invalid", /more data, or a different shape/],
    ["github_tree_truncated", /more data, or a different shape/],
    ["github_graphql_forbidden", /GitHub rejected/],
    ["branch_exists", /branch already exists/],
    ["issue_locked", /locked/],
    ["label_not_defined", /label the repository doesn't have/],
    ["required_checks_incomplete", /required checks/],
    ["comment_not_owned", /outside what it may change/],
    ["review_comment_wrong_pull", /outside what it may change/],
    ["merge_not_applied", /did not apply the change/],
    ["github_http_error", /GitHub rejected/],
    ["effect_deadline_expired", /ran out of time/],
    ["something_new", /no longer fits/],
  ])("%s", (code, what) => {
    const advice = applyFailureAdvice(code);
    expect(advice.what).toMatch(what);
    expect(advice.what).toContain("Nothing was written for this step or any later step.");
  });

  it("does not suggest re-running for deterministic or internal failures", () => {
    expect(applyFailureAdvice("branch_not_allowed").todo).toMatch(/repeats on every run/);
    expect(applyFailureAdvice("canonical_marker_missing").todo).toMatch(/report this/);
  });

  it("tells people to re-run all jobs for a stale plan", () => {
    expect(applyFailureAdvice("pull_changed").todo).toContain("**Re-run all jobs**");
  });
});

describe("splitFailureTrail", () => {
  it("separates the runtime's trail from the message", () => {
    expect(splitFailureTrail("Task model-turn limit was exceeded (3 tool calls: 2 repository.exec, 1 provider.api.read; no effects proposed)"))
      .toEqual({ message: "Task model-turn limit was exceeded", trail: "3 tool calls: 2 repository.exec, 1 provider.api.read; no effects proposed" });
    expect(splitFailureTrail("Flue task execution failed (no tool calls; 1 effect proposed)"))
      .toEqual({ message: "Flue task execution failed", trail: "no tool calls; 1 effect proposed" });
  });

  it("leaves other parentheses alone", () => {
    expect(splitFailureTrail("The model provider failed (HTTP 503)")).toEqual({ message: "The model provider failed (HTTP 503)" });
  });
});
