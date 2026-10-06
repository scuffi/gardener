import { describe, expect, it } from "vitest";
import { triggeringPullRequestRefusal } from "../src/index";

describe("thread effects are confined to the triggering pull request", () => {
  const pr7 = { kind: "pull_request", id: "700", number: 7 } as const;
  const reply = "pull_request.review_comment.reply";
  const resolve = "pull_request.review_thread.resolve";

  it("admits the pull request that triggered the run, including from its conversation", () => {
    expect(triggeringPullRequestRefusal(reply, { pullNumber: 7 }, {}, pr7)).toBeUndefined();
    expect(triggeringPullRequestRefusal(resolve, { pullNumber: 7 }, {}, { kind: "issue", id: "700", number: 7 })).toBeUndefined();
  });

  it("refuses another pull request, a referenced number, or a run with no pull request", () => {
    expect(triggeringPullRequestRefusal(resolve, { pullNumber: 42 }, {}, pr7)).toMatch(/only on #7/);
    expect(triggeringPullRequestRefusal(reply, { pullNumber: 7 }, { "/pullNumber": { step: "open", output: "pullNumber" } }, pr7))
      .toMatch(/directly, not by reference/);
    expect(triggeringPullRequestRefusal(resolve, { pullNumber: 7 }, {}, null)).toMatch(/triggered from a pull request/);
    expect(triggeringPullRequestRefusal(resolve, { pullNumber: 7 }, {}, { kind: "discussion", id: "1", number: 7, nodeId: "D_1" }))
      .toMatch(/triggered from a pull request/);
  });

  it("leaves other kinds alone", () => {
    expect(triggeringPullRequestRefusal("pull_request.comment.create", { pullNumber: 42 }, {}, pr7)).toBeUndefined();
  });
});
