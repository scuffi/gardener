import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from "jose";
import type { RunnerHelloV1 } from "@gardener/protocol";

const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
const GITHUB_OIDC_JWKS = createRemoteJWKSet(new URL(`${GITHUB_OIDC_ISSUER}/.well-known/jwks`));

export interface ActionsEnrollmentPolicy {
  audience: string;
  repositoryId: string;
  ownerId: string;
  ownerLogin: string;
  repositoryName: string;
  visibility: "public" | "private" | "internal";
  jobWorkflowRef: string;
  effectsEnvironment?: string;
  key?: JWTVerifyGetKey;
  now?: Date;
}

export interface VerifiedActionsIdentity {
  jti: string;
  expiresAt: number;
  actorId: string;
  actorLogin: string;
}

export async function verifyActionsOidc(
  token: string,
  hello: RunnerHelloV1,
  policy: ActionsEnrollmentPolicy,
): Promise<VerifiedActionsIdentity> {
  if (token.length < 1 || token.length > 16 * 1_024) throw new Error("OIDC token is invalid");
  const { payload } = await jwtVerify(token, policy.key ?? GITHUB_OIDC_JWKS, {
    issuer: GITHUB_OIDC_ISSUER,
    audience: policy.audience,
    algorithms: ["RS256"],
    ...(policy.now === undefined ? {} : { currentDate: policy.now }),
  });
  const jti = requiredClaim(payload, "jti");
  const actorId = requiredClaim(payload, "actor_id");
  const actorLogin = requiredClaim(payload, "actor");
  if (!Number.isSafeInteger(payload.exp)) throw new Error("OIDC token has no valid expiry");
  if (!/@[a-f0-9]{40}$/.test(policy.jobWorkflowRef)) {
    throw new Error("Enrolled reusable workflow must be pinned to a full commit SHA");
  }
  if (hello.repositoryId !== policy.repositoryId || hello.ownerId !== policy.ownerId) {
    throw new Error("Runner hello does not match enrolled repository identity");
  }
  if (hello.jobWorkflowRef !== policy.jobWorkflowRef) {
    throw new Error("Runner hello does not match the trusted reusable workflow");
  }
  const expected: Record<string, string> = {
    repository_id: policy.repositoryId,
    repository_owner_id: policy.ownerId,
    repository: `${policy.ownerLogin}/${policy.repositoryName}`,
    repository_visibility: policy.visibility,
    run_id: hello.runId,
    run_attempt: String(hello.runAttempt),
    workflow_ref: hello.workflowRef,
    job_workflow_ref: hello.jobWorkflowRef,
    event_name: hello.eventName,
    ref: hello.ref,
    sha: hello.commitSha,
    runner_environment: "github-hosted",
  };
  for (const [name, expectedValue] of Object.entries(expected)) {
    if (String(payload[name] ?? "") !== expectedValue) throw new Error(`OIDC claim ${name} does not match the authenticated runner`);
  }
  if (hello.phase === "plan" && payload.environment !== undefined) {
    throw new Error("Planning OIDC token must not be bound to an effects environment");
  }
  if (hello.phase === "effects" && payload.environment !== (policy.effectsEnvironment ?? "gardener-effects")) {
    throw new Error("Effects OIDC token is not bound to the trusted effects environment");
  }
  return { jti, expiresAt: payload.exp!, actorId, actorLogin };
}

function requiredClaim(payload: JWTPayload, name: string): string {
  const value = payload[name];
  if (typeof value !== "string" || value.length < 1 || value.length > 2_048) {
    throw new Error(`OIDC token has no valid ${name} claim`);
  }
  return value;
}
