import type { OperationKind } from "@gardener/contracts";

export interface Env {
  DB: D1Database;
  ADMIN_BOOTSTRAP_SECRET: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  GITHUB_APP_ID: string;
  GITHUB_APP_SLUG: string;
  GITHUB_APP_PRIVATE_KEY: string;
  GITHUB_WEBHOOK_SECRET: string;
  GITHUB_OAUTH_CALLBACK_URL: string;
  CONNECT_JWT_PRIVATE_KEY: string;
  CONNECT_JWT_PUBLIC_KEY: string;
  CONNECT_JWT_KID: string;
  CONNECT_ISSUER: string;
  CONNECT_AUDIENCE: string;
  ACCESS_CREDENTIAL_ENCRYPTION_KEY?: string;
  DEPLOY_REPOSITORY_URL?: string;
}

export interface Variables {
  instanceId: string;
  identity: { instanceId: string; githubUserId: string; githubLogin: string };
  grant: GrantClaims;
}

export interface GrantClaims {
  jti: string;
  instanceId: string;
  runId: string;
  eventId: string;
  repositoryId: string;
  owner: string;
  name: string;
  installationId: string;
  resourceKind: "issue" | "pull_request";
  resourceNumber: number;
  operations: OperationKind[];
  operationHashes: string[];
}
