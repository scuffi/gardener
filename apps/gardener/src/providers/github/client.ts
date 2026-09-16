import {
  beginGitHubInstallationResultSchema,
  beginGitHubLoginResultSchema,
  executeGitHubOperationResultSchema,
  finalizeGitHubInstallationResultSchema,
  githubInstallationRequestSchema,
  githubRepositorySyncResultSchema,
  resolveGitHubUsernameResultSchema,
  resolveGitHubUsernameSchema,
  type ExecuteGitHubOperationResult,
  type GitHubInstallationRequest,
  type Operation,
} from "@gardener/provider-github";
import { operationSchema } from "../../domain";
import type { Env } from "../../env";

export async function beginGitHubLogin(env: Env): Promise<string> {
  const result = beginGitHubLoginResultSchema.parse(await env.GITHUB_GATEWAY.beginLogin());
  return result.authorizationUrl;
}

export async function beginGitHubInstallation(
  env: Env,
  inputValue: GitHubInstallationRequest,
): Promise<string> {
  const input = githubInstallationRequestSchema.parse(inputValue);
  const result = beginGitHubInstallationResultSchema.parse(
    await env.GITHUB_GATEWAY.beginInstallation(input),
  );
  return result.installationUrl;
}

export async function finalizeGitHubInstallation(
  env: Env,
  inputValue: GitHubInstallationRequest,
) {
  const input = githubInstallationRequestSchema.parse(inputValue);
  return finalizeGitHubInstallationResultSchema.parse(
    await env.GITHUB_GATEWAY.finalizeInstallation(input),
  );
}

export class GitHubUsernameResolutionError extends Error {
  constructor(readonly status: 404 | 409 | 429 | 502 | 503) {
    super(`github_user_resolution_${status}`);
  }
}

export async function resolveGitHubUser(
  env: Env,
  login: string,
): Promise<{ githubUserId: string; githubLogin: string }> {
  try {
    const input = resolveGitHubUsernameSchema.parse({ login });
    const result = resolveGitHubUsernameResultSchema.parse(
      await env.GITHUB_GATEWAY.resolveUsername(input),
    );
    if (!result.identity) throw new GitHubUsernameResolutionError(404);
    return {
      githubUserId: result.identity.subject,
      githubLogin: result.identity.login,
    };
  } catch (error) {
    if (error instanceof GitHubUsernameResolutionError) throw error;
    const message = error instanceof Error ? error.message : "";
    if (message.includes("installation_required")) throw new GitHubUsernameResolutionError(409);
    if (message.includes("rate_limited")) throw new GitHubUsernameResolutionError(429);
    throw new GitHubUsernameResolutionError(502);
  }
}

export async function listConnectedRepositories(env: Env) {
  const result = githubRepositorySyncResultSchema.parse(
    await env.GITHUB_GATEWAY.syncRepositories(),
  );
  return result.repositories;
}

export async function executeGitHubOperation(
  env: Env,
  runId: string,
  eventId: string,
  operationInput: Operation,
): Promise<ExecuteGitHubOperationResult["receipt"]> {
  const operation = operationSchema.parse(operationInput);
  const result = executeGitHubOperationResultSchema.parse(
    await env.GITHUB_GATEWAY.executeOperation({ runId, eventId, operation }),
  );
  return result.receipt;
}
