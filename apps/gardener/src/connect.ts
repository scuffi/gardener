import { operationSchema, type Operation } from "./domain";
import { cloudflareAccessCredentials, instanceId, type Env } from "./env";

async function connectRequest(env: Env, path: string, init: RequestInit): Promise<Response> {
  const response = await fetch(new URL(path, env.CONNECT_URL), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 1_000);
    throw new Error(`Connect ${path} failed (${response.status}): ${detail}`);
  }
  return response;
}

export async function claimGardenerInstance(env: Env, origin: string): Promise<void> {
  await connectRequest(env, "/v1/instances/claim", {
    method: "POST",
    headers: { authorization: `Bearer ${env.GARDENER_INSTANCE_TOKEN}` },
    body: JSON.stringify({
      instanceId: instanceId(env),
      callbackUrl: `${origin.replace(/\/$/, "")}/hooks/connect`,
      cloudflareAccess: cloudflareAccessCredentials(env),
    }),
  });
}

export async function beginGitHubLogin(env: Env, origin: string): Promise<string> {
  await claimGardenerInstance(env, origin);
  const response = await connectRequest(env, "/v1/auth/github/start", {
    method: "POST",
    headers: { authorization: `Bearer ${env.GARDENER_INSTANCE_TOKEN}` },
    body: JSON.stringify({ redirectUri: `${origin.replace(/\/$/, "")}/` }),
  });
  const body = await response.json() as { authorizationUrl?: string };
  if (!body.authorizationUrl) throw new Error("Connect returned no GitHub authorization URL");
  return body.authorizationUrl;
}

export async function beginGitHubInstallation(env: Env, identityToken: string, origin: string): Promise<string> {
  const response = await connectRequest(env, "/v1/installations/setup", {
    method: "POST",
    headers: { authorization: `Bearer ${identityToken}` },
    body: JSON.stringify({ redirectUri: `${origin.replace(/\/$/, "")}/` }),
  });
  const body = await response.json() as { installationUrl?: string };
  if (!body.installationUrl) throw new Error("Connect returned no GitHub App installation URL");
  return body.installationUrl;
}

export interface ConnectedRepository {
  provider?: "github";
  id: string;
  installationId: string;
  owner: string;
  name: string;
  defaultBranch?: string;
}

export async function listConnectedRepositories(env: Env): Promise<ConnectedRepository[]> {
  const response = await connectRequest(env, "/v1/repositories", {
    method: "GET",
    headers: { authorization: `Bearer ${env.GARDENER_INSTANCE_TOKEN}` },
  });
  const body = await response.json() as { repositories?: ConnectedRepository[] };
  if (!Array.isArray(body.repositories)) throw new Error("Connect returned no repository list");
  return body.repositories;
}

export async function executeThroughConnect(
  env: Env,
  runId: string,
  eventId: string,
  operationInput: Operation,
): Promise<unknown> {
  const operation = operationSchema.parse(operationInput);
  const grantResponse = await connectRequest(env, "/v1/grants", {
    method: "POST",
    headers: { authorization: `Bearer ${env.GARDENER_INSTANCE_TOKEN}` },
    body: JSON.stringify({
      instanceId: instanceId(env),
      runId,
      eventId,
      repository: operation.repository,
      operations: [operation],
    }),
  });
  const grantBody = (await grantResponse.json()) as { grant?: string };
  if (!grantBody.grant) throw new Error("Connect returned no run grant");

  const operationResponse = await connectRequest(env, "/v1/operations", {
    method: "POST",
    headers: { authorization: `Bearer ${grantBody.grant}` },
    body: JSON.stringify({ operation }),
  });
  return operationResponse.json();
}
