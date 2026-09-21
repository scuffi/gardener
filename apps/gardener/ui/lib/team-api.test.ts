import { afterEach, describe, expect, it, vi } from "vitest";
import {
  gardenerApi,
  isOverlapConfirmationError,
  parseSessionState,
} from "./api";
import { operationMetadata, type OperationKind, type PolicyMode } from "./types";

const workspaceCapabilities = [
  "workspace.fs.read",
  "workspace.fs.write",
  "workspace.git.read",
  "workspace.git.write-local",
  "workspace.exec.shell",
  "workspace.exec.javascript",
  "workspace.exec.container",
  "workspace.network.connect",
  "workspace.dependencies.install",
  "workspace.artifacts.publish",
] as const;

function respond(body: unknown, status = 200) {
  const fetch = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

afterEach(() => vi.unstubAllGlobals());

describe("shared team and authority API contracts", () => {
  it("parses authenticated sessions and fails malformed or unauthenticated payloads closed", () => {
    expect(
      parseSessionState({
        authenticated: true,
        githubLogin: "octocat",
        user: {
          id: "user_github_1",
          displayName: "The Octocat",
          role: "owner",
          identity: { provider: "github", providerSubject: "1", login: "octocat" },
        },
      }),
    ).toMatchObject({
      authenticated: true,
      githubLogin: "octocat",
      user: { displayName: "The Octocat", role: "owner" },
    });
    expect(parseSessionState({
      authenticated: true,
      githubLogin: "owner@example.com",
      user: {
        id: "user_access_1",
        displayName: "owner@example.com",
        role: "owner",
        identity: {
          provider: "cloudflare-access",
          providerSubject: "access-subject",
          login: "owner@example.com",
        },
      },
    })).toMatchObject({
      authenticated: true,
      user: { identity: { provider: "cloudflare-access" } },
    });
    expect(parseSessionState({ authenticated: false, user: { role: "owner" } })).toEqual({
      authenticated: false,
    });
    expect(parseSessionState({ authenticated: true, githubLogin: "octocat" })).toEqual({
      authenticated: false,
    });
  });

  it("uses backend team paths and the GitHub username invitation body", async () => {
    const fetch = respond({ invitation: { id: "invitation_1", githubUsername: "octocat" } });
    await gardenerApi.team();
    await gardenerApi.inviteMember("octocat");
    await gardenerApi.revokeInvitation("invitation/1");
    await gardenerApi.removeMember("user/1");

    expect(fetch.mock.calls.map(([path]) => path)).toEqual([
      "/api/members",
      "/api/invitations",
      "/api/invitations/invitation%2F1",
      "/api/members/user%2F1",
    ]);
    expect(fetch.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ githubUsername: "octocat" }),
      }),
    );
    expect(fetch.mock.calls[2]?.[1]).toEqual(expect.objectContaining({ method: "DELETE" }));
  });

  it("sends exact assignment, activation, and repository policy requests", async () => {
    const fetch = respond({ assignments: [], assignmentEpoch: 4 });
    await gardenerApi.addAgentAssignments("agent/one", {
      allCurrent: true,
      authorityCeiling: "approval",
      expectedAssignmentEpoch: 4,
      materializedRepositoryIds: ["10", "11"],
      overlapFingerprint: "a".repeat(64),
      expectedActiveRevisionId: "revision_1",
    });
    await gardenerApi.agentAssignments("agent/one");
    await gardenerApi.repositoryAssignments("10");
    await gardenerApi.updateAssignmentState("assignment/one", "enable", {
      expectedVersion: 2,
      expectedConfigHash: "b".repeat(64),
      expectedAssignmentEpoch: 4,
      reason: null,
    });
    await gardenerApi.updateAssignmentAuthority("assignment/one", {
      authorityCeiling: "disabled",
      expectedVersion: 2,
      expectedConfigHash: "b".repeat(64),
      expectedAssignmentEpoch: 4,
      reason: null,
    });
    await gardenerApi.activateAgentRevisionWithPreconditions("agent/one", "revision/2", {
      expectedAssignmentEpoch: 4,
      expectedCurrentRevisionId: "revision_1",
      reason: null,
    });
    await gardenerApi.repositoryPolicy("10");
    const operationModes = Object.fromEntries(
      Object.keys(operationMetadata).map((operation) => [operation, "disabled"]),
    ) as Record<OperationKind, PolicyMode>;
    operationModes["issue.close"] = "approval";
    const workspaceModes = Object.fromEntries(
      workspaceCapabilities.map((capability) => [capability, "disabled"]),
    ) as Record<(typeof workspaceCapabilities)[number], PolicyMode>;
    await gardenerApi.setRepositoryPolicy("10", {
      expectedPolicyVersion: 2,
      expectedPolicyHash: "c".repeat(64),
      operationModes,
      allowedObservations: ["github.issue.read"],
      workspaceModes,
    });

    expect(fetch.mock.calls.map(([path]) => path)).toEqual([
      "/api/agents/agent%2Fone/assignments",
      "/api/agents/agent%2Fone/assignments",
      "/api/repositories/10/assignments",
      "/api/assignments/assignment%2Fone/enable",
      "/api/assignments/assignment%2Fone/authority",
      "/api/agents/agent%2Fone/revisions/revision%2F2/activate",
      "/api/repositories/10/policy",
      "/api/repositories/10/policy",
    ]);
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({
      allCurrent: true,
      expectedAssignmentEpoch: 4,
      materializedRepositoryIds: ["10", "11"],
    });
    expect(fetch.mock.calls[4]?.[1]).toEqual(expect.objectContaining({ method: "PUT" }));
    expect(fetch.mock.calls[7]?.[1]).toEqual(expect.objectContaining({ method: "PUT" }));
  });

  it("maps known errors before backend messages and safely falls back for unknown errors", async () => {
    respond({ error: "already_a_member", message: "Unsafe override" }, 409);
    await expect(gardenerApi.inviteMember("octocat")).rejects.toThrow(
      "That GitHub user is already a member.",
    );

    respond({ error: "permission_denied", message: "You cannot manage this team." }, 403);
    await expect(gardenerApi.inviteMember("octocat")).rejects.toThrow(
      "You cannot manage this team.",
    );

    respond({ error: "future_conflict" }, 409);
    await expect(gardenerApi.inviteMember("octocat")).rejects.toThrow("Request failed (409).");
  });

  it.each([
    ["github_user_resolution_409", "GitHub could not resolve that username."],
    ["github_user_resolution_429", "GitHub is receiving too many requests."],
    ["github_user_resolution_502", "GitHub could not be reached."],
    ["github_user_resolution_503", "GitHub is temporarily unavailable."],
  ])("maps %s to clear invitation feedback", async (code, message) => {
    respond({ error: code }, Number(code.slice(-3)));
    await expect(gardenerApi.inviteMember("octocat")).rejects.toThrow(message);
  });

  it("preserves the typed overlap warning while showing a safe unknown-code message", async () => {
    respond(
      {
        error: "overlap_confirmation_required",
        warning: {
          assignmentEpoch: 7,
          repositories: [],
          fingerprint: "d".repeat(64),
        },
      },
      409,
    );

    try {
      await gardenerApi.addAgentAssignments("agent", {
        repositoryId: "10",
        authorityCeiling: "automatic",
        expectedAssignmentEpoch: 7,
      });
      throw new Error("Expected the API call to fail");
    } catch (error) {
      expect(isOverlapConfirmationError(error)).toBe(true);
      if (isOverlapConfirmationError(error)) {
        expect(error.details?.warning.fingerprint).toBe("d".repeat(64));
        expect(error.message).toBe("Request failed (409).");
      }
    }
  });
});
