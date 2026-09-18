import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import type { RunnerHelloV1 } from "@gardener/protocol";
import { verifyActionsOidc, type ActionsEnrollmentPolicy } from "../src/task-runtime/github-oidc";

const now = new Date("2026-09-17T12:00:00.000Z");
const audience = "https://gardener.example.workers.dev";
const workflow = `scuffi/smoke/.github/workflows/gardener-reusable.yml@${"1".repeat(40)}`;
const hello: RunnerHelloV1 = {
  schemaVersion: "gardener.runner.hello/v1",
  protocolVersion: "gardener.runner.rpc/v1",
  phase: "plan",
  repositoryId: "1374842705",
  ownerId: "45369682",
  runId: "35256179260",
  runAttempt: 1,
  workflowRef: "scuffi/smoke/.github/workflows/gardener.yml@refs/heads/main",
  jobWorkflowRef: workflow,
  eventName: "workflow_dispatch",
  ref: "refs/heads/main",
  runnerEnvironment: "github-hosted",
  commitSha: "a".repeat(40),
  agentHash: "b".repeat(64),
};
let privateKey: CryptoKey;
let policy: ActionsEnrollmentPolicy;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  privateKey = pair.privateKey;
  const jwk = await exportJWK(pair.publicKey);
  policy = {
    audience,
    repositoryId: hello.repositoryId,
    ownerId: hello.ownerId,
    ownerLogin: "scuffi",
    repositoryName: "smoke",
    visibility: "public",
    jobWorkflowRef: workflow,
    key: createLocalJWKSet({ keys: [{ ...jwk, kid: "test", alg: "RS256", use: "sig" }] }),
    now,
  };
});

describe("product Actions OIDC enrollment", () => {
  it("binds repository, workflow, run, hosted runner, actor, and visibility claims", async () => {
    await expect(verifyActionsOidc(await token(), hello, policy)).resolves.toEqual({
      jti: "token-one",
      expiresAt: epoch(now) + 300,
      actorId: "45369682",
      actorLogin: "scuffi",
    });
  });

  it.each([
    ["repository", "attacker/smoke"],
    ["repository_visibility", "private"],
    ["job_workflow_ref", `attacker/workflow@${"2".repeat(40)}`],
    ["run_id", "1"],
    ["runner_environment", "self-hosted"],
  ])("rejects a mismatched %s claim", async (name, value) => {
    await expect(verifyActionsOidc(await token({ [name]: value }), hello, policy)).rejects.toThrow(/does not match/);
  });

  it("rejects an enrollment that does not pin the reusable workflow to a full SHA", async () => {
    await expect(verifyActionsOidc(await token(), { ...hello, jobWorkflowRef: "scuffi/smoke/.github/workflows/reusable.yml@main" }, {
      ...policy,
      jobWorkflowRef: "scuffi/smoke/.github/workflows/reusable.yml@main",
    })).rejects.toThrow(/full commit SHA/);
  });

  it("cryptographically separates planning from the effects environment", async () => {
    await expect(verifyActionsOidc(await token({ environment: "gardener-effects" }), hello, policy)).rejects.toThrow(/Planning/);
    const effects = { ...hello, phase: "effects" as const };
    await expect(verifyActionsOidc(await token(), effects, policy)).rejects.toThrow(/Effects/);
    await expect(verifyActionsOidc(await token({ environment: "gardener-effects" }), effects, policy)).resolves.toBeDefined();
  });
});

async function token(overrides: Record<string, unknown> = {}): Promise<string> {
  const claims = { ...baseClaims(), ...overrides };
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "test" })
    .setIssuer("https://token.actions.githubusercontent.com")
    .setAudience(audience)
    .setIssuedAt(epoch(now))
    .setNotBefore(epoch(now) - 10)
    .setExpirationTime(epoch(now) + 300)
    .sign(privateKey);
}

function baseClaims(): Record<string, unknown> {
  return {
    jti: "token-one",
    actor_id: "45369682",
    actor: "scuffi",
    repository_id: hello.repositoryId,
    repository_owner_id: hello.ownerId,
    repository: "scuffi/smoke",
    repository_visibility: "public",
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

function epoch(value: Date): number { return Math.floor(value.getTime() / 1_000); }
