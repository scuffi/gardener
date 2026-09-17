import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from "jose";
import type { RunnerHelloV1 } from "@gardener/protocol";

const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
const GITHUB_OIDC_JWKS = createRemoteJWKSet(new URL(`${GITHUB_OIDC_ISSUER}/.well-known/jwks`));

export interface GitHubOidcPolicy {
  audience: string;
  repositoryId: string;
  ownerId: string;
  jobWorkflowRef: string;
  effectsEnvironment?: string;
  key?: JWTVerifyGetKey;
  now?: Date;
}

export interface VerifiedGitHubIdentity {
  jti: string;
  expiresAt: number;
  repositoryId: string;
  ownerId: string;
  runId: string;
  runAttempt: number;
}

export async function verifyGitHubActionsOidc(
  token: string,
  hello: RunnerHelloV1,
  policy: GitHubOidcPolicy,
): Promise<VerifiedGitHubIdentity> {
  if (token.length < 1 || token.length > 16 * 1024) throw new Error("OIDC token is invalid");
  const { payload } = await jwtVerify(token, policy.key ?? GITHUB_OIDC_JWKS, {
    issuer: GITHUB_OIDC_ISSUER,
    audience: policy.audience,
    algorithms: ["RS256"],
    ...(policy.now === undefined ? {} : { currentDate: policy.now }),
  });

  const jti = requiredClaim(payload, "jti");
  const expiresAt = payload.exp;
  if (!Number.isSafeInteger(expiresAt)) throw new Error("OIDC token has no valid expiry");
  const expected: Record<string, string> = {
    repository_id: policy.repositoryId,
    repository_owner_id: policy.ownerId,
    run_id: hello.runId,
    run_attempt: String(hello.runAttempt),
    workflow_ref: hello.workflowRef,
    job_workflow_ref: policy.jobWorkflowRef,
    event_name: hello.eventName,
    ref: hello.ref,
    sha: hello.commitSha,
    runner_environment: hello.runnerEnvironment,
  };
  if (hello.repositoryId !== policy.repositoryId || hello.ownerId !== policy.ownerId) {
    throw new Error("Runner hello does not match enrolled repository identity");
  }
  if (hello.jobWorkflowRef !== policy.jobWorkflowRef) {
    throw new Error("Runner hello does not match the trusted reusable workflow");
  }
  const environment = payload.environment;
  if (hello.phase === "plan" && environment !== undefined) {
    throw new Error("Planning OIDC token must not be bound to an effects environment");
  }
  if (hello.phase === "effects" && environment !== (policy.effectsEnvironment ?? "gardener-effects")) {
    throw new Error("Effects OIDC token is not bound to the trusted effects environment");
  }
  for (const [name, value] of Object.entries(expected)) {
    if (String(payload[name] ?? "") !== value) throw new Error(`OIDC claim ${name} does not match the runner hello`);
  }
  return {
    jti,
    expiresAt: expiresAt!,
    repositoryId: policy.repositoryId,
    ownerId: policy.ownerId,
    runId: hello.runId,
    runAttempt: hello.runAttempt,
  };
}

function requiredClaim(payload: JWTPayload, name: string): string {
  const value = payload[name];
  if (typeof value !== "string" || value.length < 1 || value.length > 2_048) {
    throw new Error(`OIDC token has no valid ${name} claim`);
  }
  return value;
}
