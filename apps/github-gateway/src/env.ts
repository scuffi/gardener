import type { GardenerGitHubIngressRpc } from "@gardener/provider-github";

export interface Env {
  DB: D1Database;
  GARDENER?: GardenerGitHubIngressRpc;

  GATEWAY_ORIGIN: string;
  GARDENER_ORIGIN: string;
  GARDENER_WORKSPACE_ID: string;

  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  GITHUB_APP_ID: string;
  GITHUB_APP_SLUG: string;
  GITHUB_APP_PRIVATE_KEY: string;
  GITHUB_WEBHOOK_SECRET: string;

  GATEWAY_OPERATOR_TOKEN: string;
  OPERATION_MARKER_KEY: string;
}

export function gatewayReady(env: Env): boolean {
  return Boolean(
    env.DB &&
    env.GARDENER &&
    env.GATEWAY_ORIGIN &&
    env.GARDENER_ORIGIN &&
    env.GARDENER_WORKSPACE_ID &&
    env.GITHUB_CLIENT_ID &&
    env.GITHUB_CLIENT_SECRET &&
    env.GITHUB_APP_ID &&
    env.GITHUB_APP_SLUG &&
    env.GITHUB_APP_PRIVATE_KEY &&
    env.GITHUB_WEBHOOK_SECRET &&
    env.GATEWAY_OPERATOR_TOKEN &&
    env.OPERATION_MARKER_KEY,
  );
}
