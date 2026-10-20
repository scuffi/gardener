import { describe, expect, it, vi } from "vitest";
import {
  actorPermissionLogin,
  authorPermissionLogin,
  fetchAuthorPermission,
  withActorPermission,
  withAuthorPermission,
} from "../src/author-permission";
import { normalizeGitHubEvent } from "../src/event";

const repository = { id: 1374842705, full_name: "scuffi/gardener", default_branch: "main" };
const user = (login: string) => ({ id: 45369682, login });
const issue = (login: string, association: string) => ({
  id: 999, number: 1, title: "t", body: "b", state: "open", updated_at: "2026-09-22T12:00:00.000Z",
  labels: [], user: user(login), author_association: association,
});
const commentEvent = (login: string, association: string, issueAuthor = "issue-writer", issueAssociation = "NONE") =>
  normalizeGitHubEvent("issue_comment", {
    action: "created",
    repository,
    issue: issue(issueAuthor, issueAssociation),
    comment: {
      id: 3, body: "hi", updated_at: "2026-09-22T12:00:00.000Z", user: user(login), author_association: association,
    },
  });

describe("author permission lookup", () => {
  it("looks up only the trigger subject's author, and only when the association does not already count", () => {
    expect(authorPermissionLogin(commentEvent("private-member", "CONTRIBUTOR", "someone", "OWNER"))).toBe("private-member");
    expect(authorPermissionLogin(commentEvent("private-member", "NONE"))).toBe("private-member");
    for (const association of ["OWNER", "MEMBER", "COLLABORATOR"]) {
      expect(authorPermissionLogin(commentEvent("maintainer", association))).toBeNull();
    }
    expect(authorPermissionLogin(commentEvent("dependabot[bot]", "NONE"))).toBeNull();
    const issueOpened = normalizeGitHubEvent("issues", { action: "opened", repository, issue: issue("reporter", "NONE") });
    expect(authorPermissionLogin(issueOpened)).toBe("reporter");
    // Labels are not authored text, so no one's access is looked up.
    const labeled = normalizeGitHubEvent("issues", {
      action: "labeled", repository, issue: issue("reporter", "NONE"), label: { name: "bug" },
    });
    expect(authorPermissionLogin(labeled)).toBeNull();
  });

  it("attaches the permission to that subject alone", () => {
    const event = withAuthorPermission(commentEvent("private-member", "CONTRIBUTOR"), "write") as Record<string, any>;
    expect(event.comment).toMatchObject({ authorAssociation: "CONTRIBUTOR", authorPermission: "write" });
    expect(event.issue).not.toHaveProperty("authorPermission");
  });

  it("reads the run's own repository without following redirects", async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      Response.json({ permission: "write", role_name: "maintain" }));
    await expect(fetchAuthorPermission({ repository: "o/r", login: "private-member", token: "t", fetch }))
      .resolves.toBe("write");
    expect(fetch.mock.calls[0]![0]).toBe("https://api.github.com/repos/o/r/collaborators/private-member/permission");
    const init = fetch.mock.calls[0]![1]!;
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.headers).toMatchObject({ authorization: "Bearer t" });
  });

  it("fails closed to no permission on any error or unexpected answer", async () => {
    const respond = (response: Response | Error) => vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
      if (response instanceof Error) throw response;
      return response;
    });
    const lookup = (fetch: typeof globalThis.fetch, overrides: Partial<{ repository: string; login: string; token: string }> = {}) =>
      fetchAuthorPermission({ repository: "o/r", login: "someone", token: "t", fetch, ...overrides });
    await expect(lookup(respond(new Response("", { status: 404 })))).resolves.toBeNull();
    await expect(lookup(respond(new Response("", { status: 403 })))).resolves.toBeNull();
    await expect(lookup(respond(new Error("network down")))).resolves.toBeNull();
    await expect(lookup(respond(new Response("not json")))).resolves.toBeNull();
    await expect(lookup(respond(Response.json({ permission: "triage" })))).resolves.toBeNull();
    await expect(lookup(respond(new Response("x".repeat(64 * 1024 + 1))))).resolves.toBeNull();
    const untouched = respond(Response.json({ permission: "admin" }));
    await expect(lookup(untouched, { token: "" })).resolves.toBeNull();
    await expect(lookup(untouched, { login: "../../orgs/x" })).resolves.toBeNull();
    await expect(lookup(untouched, { repository: "o/.." })).resolves.toBeNull();
    expect(untouched).not.toHaveBeenCalled();
  });
});

describe("actor permission lookup", () => {
  const labeled = (author = "reporter") => normalizeGitHubEvent("issues", {
    action: "labeled", repository, issue: { ...issue(author, "NONE"), user: { id: 7, login: author } }, label: { name: "bug" },
  });
  const pullRequest = (action: string) => normalizeGitHubEvent("pull_request", {
    action,
    repository,
    label: { name: "bug" },
    pull_request: {
      id: 5, number: 2, title: "t", body: "b", state: "open", draft: false, merged: false, labels: [],
      updated_at: "2026-09-22T12:00:00.000Z", user: { id: 7, login: "reporter" }, author_association: "NONE",
      base: { ref: "main", sha: "a".repeat(40), repo: repository },
      head: { ref: "feature", sha: "b".repeat(40), repo: repository },
    },
  });
  const labeller = { login: "labeller", id: "1000" };

  it("looks up the actor only when it is someone other than the subject's author", () => {
    expect(actorPermissionLogin(labeled(), labeller)).toBe("labeller");
    expect(actorPermissionLogin(labeled(), { login: "reporter", id: "7" })).toBeNull();
    expect(actorPermissionLogin(commentEvent("commenter", "NONE"), labeller)).toBe("labeller");
    expect(actorPermissionLogin(pullRequest("labeled"), labeller)).toBe("labeller");
  });

  it("never looks up for events that decide their starter, bots, or an actor the environment does not name", () => {
    expect(actorPermissionLogin(pullRequest("synchronize"), labeller)).toBeNull();
    const pushed = normalizeGitHubEvent("push", {
      ref: "refs/heads/main", before: "a".repeat(40), after: "b".repeat(40), forced: false, commits: [], repository,
    });
    expect(actorPermissionLogin(pushed, labeller)).toBeNull();
    expect(actorPermissionLogin(labeled(), { login: "dependabot[bot]", id: "49699333" })).toBeNull();
    expect(actorPermissionLogin(labeled(), { login: undefined, id: "1000" })).toBeNull();
    expect(actorPermissionLogin(labeled(), { login: "labeller", id: undefined })).toBeNull();
    expect(actorPermissionLogin(labeled(), { login: "labeller", id: "not-a-number" })).toBeNull();
  });

  it("attaches the permission at the top level, and leaves the event alone if it would not parse", () => {
    expect(withActorPermission(labeled(), "write")).toMatchObject({ actorPermission: "write" });
    expect((withActorPermission(labeled(), "write") as Record<string, any>).issue).not.toHaveProperty("authorPermission");
    const invalid = withActorPermission(labeled(), "maintain" as never);
    expect(invalid).not.toHaveProperty("actorPermission");
  });
});
