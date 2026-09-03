import { describe, expect, it } from "vitest";
import { normalizeIssueEvent, normalizePullRequestEvent } from "../src/index";

const repository = { id: 9, name: "widgets", full_name: "acme/widgets", default_branch: "main", owner: { login: "acme" } };
const installation = { id: 7 };
const headSha = "abcdef1234567890abcdef1234567890abcdef12";
const baseSha = "1234567890abcdef1234567890abcdef12345678";

describe("GitHub event identity normalization", () => {
  it("keeps issue event actor and resource author identities distinct", () => {
    const normalized = normalizeIssueEvent({
      action: "labeled", installation, repository,
      sender: { id: 45369682, login: "scuffi", type: "User", email: "private@example.com" },
      issue: {
        id: 11, number: 2, title: "Dependency update", body: null, state: "open",
        html_url: "https://github.com/acme/widgets/issues/2", updated_at: "2026-09-03T12:00:00Z",
        user: { id: 49699333, login: "dependabot[bot]", type: "Bot", email: "dependabot@example.com" }, labels: [],
      },
    }, "delivery-identity-issue");

    expect(normalized?.event).toMatchObject({
      actor: { id: "45369682", login: "scuffi", accountType: "User" },
      issue: { author: "dependabot[bot]", authorIdentity: { id: "49699333", login: "dependabot[bot]", accountType: "Bot" } },
    });
    expect(JSON.stringify(normalized)).not.toContain("private@example.com");
    expect(JSON.stringify(normalized)).not.toContain("dependabot@example.com");
  });

  it("keeps pull-request event actor and resource author identities distinct", () => {
    const normalized = normalizePullRequestEvent({
      action: "synchronize", installation, repository,
      sender: { id: 45369682, login: "scuffi", type: "User" },
      pull_request: {
        id: 21, number: 3, title: "Bump dependency", body: "Update", state: "open", draft: false, merged: false,
        html_url: "https://github.com/acme/widgets/pull/3", updated_at: "2026-09-03T12:00:00Z",
        user: { id: 49699333, login: "dependabot[bot]", type: "Bot" }, labels: [],
        head: { ref: "dependabot/npm/pkg-1.2.3", sha: headSha }, base: { ref: "main", sha: baseSha },
      },
    }, "delivery-identity-pr");

    expect(normalized?.event).toMatchObject({
      actor: { id: "45369682", login: "scuffi", accountType: "User" },
      pullRequest: { author: "dependabot[bot]", authorIdentity: { id: "49699333", accountType: "Bot" } },
    });
  });

  it("omits incomplete or unknown identities instead of inferring security identity from login", () => {
    const normalized = normalizeIssueEvent({
      action: "opened", installation, repository,
      sender: { login: "scuffi", type: "User" },
      issue: {
        id: 11, number: 2, title: "Legacy", body: null, state: "open",
        html_url: "https://github.com/acme/widgets/issues/2",
        user: { id: 49699333, login: "dependabot[bot]", type: "FutureAccountType" }, labels: [],
      },
    }, "delivery-incomplete-identity");

    expect(normalized?.event.actor).toBeUndefined();
    expect(normalized?.event.kind === "github.issue" ? normalized.event.issue.authorIdentity : undefined).toBeUndefined();
    expect(normalized?.event.kind === "github.issue" ? normalized.event.issue.author : undefined).toBe("dependabot[bot]");
  });
});
