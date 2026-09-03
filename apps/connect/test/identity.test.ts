import { z } from "zod";
import { describe, expect, it } from "vitest";
import { normalizeIssueEvent, normalizePullRequestEvent } from "../src/index";

const repository = { id: 9, name: "widgets", full_name: "acme/widgets", default_branch: "main", owner: { login: "acme" } };
const installation = { id: 7 };
const headSha = "abcdef1234567890abcdef1234567890abcdef12";
const baseSha = "1234567890abcdef1234567890abcdef12345678";

const legacyRepositorySchema = z.object({
  provider: z.literal("github"), id: z.string(), installationId: z.string(), owner: z.string(), name: z.string(), defaultBranch: z.string().optional(),
}).strict();
const legacyResourceSchema = z.object({
  id: z.string(), number: z.number(), title: z.string(), body: z.string().nullable(), state: z.enum(["open", "closed"]), labels: z.array(z.string()), author: z.string(), htmlUrl: z.string(),
}).strict();
const legacyIssueEventSchema = z.object({
  schemaVersion: z.literal("v1"), id: z.string(), deliveryId: z.string(), instanceId: z.string(), kind: z.literal("github.issue"), action: z.string(), occurredAt: z.string(),
  repository: legacyRepositorySchema,
  issue: legacyResourceSchema,
}).strict();
const legacyPullRequestEventSchema = z.object({
  schemaVersion: z.literal("v1"), id: z.string(), deliveryId: z.string(), instanceId: z.string(), kind: z.literal("github.pull_request"), action: z.string(), occurredAt: z.string(),
  repository: legacyRepositorySchema,
  pullRequest: legacyResourceSchema.extend({
    draft: z.boolean(), merged: z.boolean(), head: z.object({ ref: z.string(), sha: z.string() }).strict(), base: z.object({ ref: z.string(), sha: z.string() }).strict(), updatedAt: z.string(),
  }).strict(),
}).strict();

describe("GitHub event wire compatibility", () => {
  it("keeps issue events parseable by independently deployed legacy Gardener Workers", () => {
    const normalized = normalizeIssueEvent({
      action: "labeled", installation, repository,
      sender: { id: 45369682, login: "scuffi", type: "User", email: "private@example.com" },
      issue: {
        id: 11, number: 2, title: "Dependency update", body: null, state: "open",
        html_url: "https://github.com/acme/widgets/issues/2", updated_at: "2026-09-03T12:00:00Z",
        user: { id: 49699333, login: "dependabot[bot]", type: "Bot", email: "dependabot@example.com" }, labels: [],
      },
    }, "delivery-identity-issue");

    expect(legacyIssueEventSchema.parse(normalized?.event)).toMatchObject({
      kind: "github.issue",
      issue: { author: "dependabot[bot]" },
    });
    expect(JSON.stringify(normalized)).not.toContain("private@example.com");
    expect(JSON.stringify(normalized)).not.toContain("dependabot@example.com");
    expect(normalized?.event.actor).toBeUndefined();
    expect(normalized?.event.kind === "github.issue" ? normalized.event.issue.authorIdentity : undefined).toBeUndefined();
  });

  it("keeps pull-request events parseable by independently deployed legacy Gardener Workers", () => {
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

    expect(legacyPullRequestEventSchema.parse(normalized?.event)).toMatchObject({
      kind: "github.pull_request",
      pullRequest: { author: "dependabot[bot]" },
    });
    expect(normalized?.event.actor).toBeUndefined();
    expect(normalized?.event.kind === "github.pull_request" ? normalized.event.pullRequest.authorIdentity : undefined).toBeUndefined();
  });
});
