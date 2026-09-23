import { describe, expect, it } from "vitest";
import { helloFromOidcToken, sessionSocketUrl } from "../src/context";

const claims = {
  repository_id: "1318443351",
  repository_owner_id: "45369682",
  run_id: "99887766",
  run_attempt: "2",
  workflow_ref: "scuffi/flue/.github/workflows/gardener.yml@refs/heads/main",
  job_workflow_ref: "scuffi/gardener/.github/workflows/run.yml@" + "c".repeat(40),
  event_name: "workflow_dispatch",
  ref: "refs/heads/main",
  runner_environment: "github-hosted",
  sha: "a".repeat(40),
};

const jwt = (payload: unknown) => `e30.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;

describe("runner OIDC context", () => {
  it("derives only server-verifiable hello fields from the unverified token payload", () => {
    expect(helloFromOidcToken(jwt(claims), "b".repeat(64), "plan")).toMatchObject({
      repositoryId: "1318443351",
      ownerId: "45369682",
      runId: "99887766",
      runAttempt: 2,
      eventName: "workflow_dispatch",
      runnerEnvironment: "github-hosted",
    });
  });

  it("builds a stable phase-specific socket URL", () => {
    const hello = helloFromOidcToken(jwt(claims), "b".repeat(64), "plan");
    expect(sessionSocketUrl("https://gardener.example.workers.dev/admin?ignored=yes", hello, "plan"))
      .toBe("wss://gardener.example.workers.dev/session/repo-1318443351-run-99887766-attempt-2-plan");
  });

  it("rejects absent claims and unsupported runner/event values", () => {
    expect(() => helloFromOidcToken(jwt({ ...claims, repository_id: undefined }), "b".repeat(64), "plan")).toThrow(/repository_id/);
    // pull_request_target is excluded by design; it would run fork-authored
    // code against the base repository's write-capable token.
    expect(() => helloFromOidcToken(jwt({ ...claims, event_name: "pull_request_target" }), "b".repeat(64), "plan")).toThrow();
    expect(() => helloFromOidcToken(jwt({ ...claims, event_name: "release" }), "b".repeat(64), "plan")).toThrow();
    expect(helloFromOidcToken(jwt({ ...claims, event_name: "push" }), "b".repeat(64), "plan").eventName).toBe("push");
    expect(() => helloFromOidcToken(jwt({ ...claims, runner_environment: "self-hosted" }), "b".repeat(64), "plan")).toThrow();
  });
});
