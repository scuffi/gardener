import { describe, expect, it } from "vitest";
import { checksOutPullRequestHead, taskAuthorsFilterV1Schema, taskOpenedByFilterV1Schema } from "../src/index";

describe("trigger author filters", () => {
  it("accepts the scalars and sorted, unique, lower-case lists", () => {
    for (const value of ["maintainers", "any", ["devin-ai-integration[bot]", "maintainers"], ["octocat"]]) {
      expect(taskAuthorsFilterV1Schema.safeParse(value).success, JSON.stringify(value)).toBe(true);
    }
  });

  it("refuses lists that would hash differently for the same meaning, or misread any", () => {
    for (const value of [
      ["maintainers"],
      ["maintainers", "devin-ai-integration[bot]"],
      ["octocat", "octocat"],
      ["Octocat"],
      ["any", "maintainers"],
      ["not a login"],
      ["-leading-hyphen"],
      [],
    ]) {
      expect(taskAuthorsFilterV1Schema.safeParse(value).success, JSON.stringify(value)).toBe(false);
    }
  });

  it("takes only logins for opened-by", () => {
    expect(taskOpenedByFilterV1Schema.safeParse(["dependabot[bot]", "github-actions[bot]"]).success).toBe(true);
    expect(taskOpenedByFilterV1Schema.safeParse(["github-actions[bot]", "dependabot[bot]"]).success).toBe(false);
    expect(taskOpenedByFilterV1Schema.safeParse(["maintainers", "octocat"]).success).toBe(true);
  });

  it("checks out the pull request head only when asked, or for commits beyond gardener/**", () => {
    expect(checksOutPullRequestHead({ checkout: "pull-request-head" })).toBe(true);
    expect(checksOutPullRequestHead({})).toBe(false);
    expect(checksOutPullRequestHead({ effectOptions: { "commit.create": { branches: ["gardener/**"] } } })).toBe(false);
    expect(checksOutPullRequestHead({ effectOptions: { "commit.create": { branches: ["**"] } } })).toBe(true);
  });
});
