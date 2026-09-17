import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import type { RunnerHelloV1 } from "@gardener/protocol";
import { verifyGitHubActionsOidc, type GitHubOidcPolicy } from "../src/github-oidc";

const now = new Date("2026-09-17T12:00:00.000Z");
const audience = "https://gardener.example.workers.dev";
const jobWorkflowRef = "scuffi/gardener/.github/workflows/gardener-reusable.yml@0123456789012345678901234567890123456789";
const hello: RunnerHelloV1 = {
  schemaVersion: "gardener.runner.hello/v1",
  protocolVersion: "gardener.runner.rpc/v1",
  phase: "plan",
  repositoryId: "1318443351",
  ownerId: "45369682",
  runId: "99887766",
  runAttempt: 2,
  workflowRef: "scuffi/flue/.github/workflows/gardener-agent.yml@refs/heads/main",
  jobWorkflowRef,
  eventName: "workflow_dispatch",
  ref: "refs/heads/main",
  runnerEnvironment: "github-hosted",
  commitSha: "a".repeat(40),
  agentHash: "b".repeat(64),
};

let privateKey: CryptoKey;
let policy: GitHubOidcPolicy;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  privateKey = pair.privateKey;
  const jwk = await exportJWK(pair.publicKey);
  policy = {
    audience,
    repositoryId: hello.repositoryId,
    ownerId: hello.ownerId,
    jobWorkflowRef,
    key: createLocalJWKSet({ keys: [{ ...jwk, kid: "test-key", alg: "RS256", use: "sig" }] }),
    now,
  };
});

describe("GitHub Actions OIDC verification", () => {
  it("binds numeric repository identity and exact workflow/run/ref/SHA claims", async () => {
    const identity = await verifyGitHubActionsOidc(await token(), hello, policy);
    expect(identity).toEqual({
      jti: "token-one",
      expiresAt: epoch(now) + 300,
      repositoryId: hello.repositoryId,
      ownerId: hello.ownerId,
      runId: hello.runId,
      runAttempt: hello.runAttempt,
    });
  });

  it.each([
    ["repository_id", "999"],
    ["repository_owner_id", "999"],
    ["run_id", "999"],
    ["run_attempt", "3"],
    ["workflow_ref", "evil/workflow@main"],
    ["job_workflow_ref", "evil/reusable@main"],
    ["event_name", "push"],
    ["ref", "refs/heads/other"],
    ["sha", "c".repeat(40)],
    ["runner_environment", "self-hosted"],
  ])("rejects a mismatched %s claim", async (name, value) => {
    await expect(verifyGitHubActionsOidc(await token({ [name]: value }), hello, policy)).rejects.toThrow(/does not match/);
  });

  it("cryptographically separates planning and effects jobs with the effects environment claim", async () => {
    await expect(verifyGitHubActionsOidc(await token({ environment: "gardener-effects" }), hello, policy))
      .rejects.toThrow(/Planning OIDC token/);
    const effectsHello = { ...hello, phase: "effects" as const };
    await expect(verifyGitHubActionsOidc(await token(), effectsHello, policy))
      .rejects.toThrow(/Effects OIDC token/);
    await expect(verifyGitHubActionsOidc(await token({ environment: "gardener-effects" }), effectsHello, policy))
      .resolves.toMatchObject({ repositoryId: hello.repositoryId, runId: hello.runId });
  });

  it("rejects the wrong audience, expiration, hello identity, and signing key", async () => {
    await expect(verifyGitHubActionsOidc(await token({}, "https://wrong.example"), hello, policy)).rejects.toThrow();
    await expect(verifyGitHubActionsOidc(await token({ exp: epoch(now) - 1 }), hello, policy)).rejects.toThrow();
    await expect(verifyGitHubActionsOidc(await token(), { ...hello, repositoryId: "999" }, policy)).rejects.toThrow(/enrolled repository/);
    const otherPair = await generateKeyPair("RS256");
    const wronglySigned = await signedToken(baseClaims(), otherPair.privateKey, audience);
    await expect(verifyGitHubActionsOidc(wronglySigned, hello, policy)).rejects.toThrow();
  });
});

async function token(overrides: Record<string, unknown> = {}, tokenAudience = audience): Promise<string> {
  return signedToken({ ...baseClaims(), ...overrides }, privateKey, tokenAudience);
}

async function signedToken(claims: Record<string, unknown>, key: CryptoKey, tokenAudience: string): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer("https://token.actions.githubusercontent.com")
    .setAudience(tokenAudience)
    .setIssuedAt(epoch(now))
    .setNotBefore(epoch(now) - 10)
    .setExpirationTime(typeof claims.exp === "number" ? claims.exp : epoch(now) + 300)
    .sign(key);
}

function baseClaims(): Record<string, unknown> {
  return {
    jti: "token-one",
    repository_id: hello.repositoryId,
    repository_owner_id: hello.ownerId,
    run_id: hello.runId,
    run_attempt: String(hello.runAttempt),
    workflow_ref: hello.workflowRef,
    job_workflow_ref: hello.jobWorkflowRef,
    event_name: hello.eventName,
    ref: hello.ref,
    sha: hello.commitSha,
    runner_environment: hello.runnerEnvironment,
  };
}

function epoch(value: Date): number {
  return Math.floor(value.getTime() / 1_000);
}
