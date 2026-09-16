import { WorkerEntrypoint } from "cloudflare:workers";
import { operationKindValues } from "@gardener/contracts";
import {
  GITHUB_GATEWAY_CONTRACT_VERSION,
  availableGitHubOperationKinds,
  githubGatewayCapabilitiesSchema,
  githubGatewayHealthSchema,
  type ExecuteGitHubOperationRequest,
  type GitHubGatewayRpc,
  type GitHubInstallationRequest,
  type ResolveGitHubUsername,
} from "@gardener/provider-github";
import { resolveGitHubUsername } from "./identities";
import type { Env } from "./env";
import { gatewayReady } from "./env";
import { beginGitHubInstallation, finalizeGitHubInstallation } from "./installations";
import { beginGitHubLogin } from "./oauth";
import { executeBoundedOperation } from "./operations";
import { syncAllRepositories } from "./repositories";

export class GitHubGatewayEntrypoint
  extends WorkerEntrypoint<Env>
  implements GitHubGatewayRpc {
  async health() {
    let database = false;
    try { await this.env.DB.prepare("SELECT 1").first(); database = true; }
    catch { /* reported in the health result */ }
    return githubGatewayHealthSchema.parse({
      contractVersion: GITHUB_GATEWAY_CONTRACT_VERSION,
      ready: database && gatewayReady(this.env),
      database,
      githubApp: Boolean(this.env.GITHUB_APP_ID && this.env.GITHUB_APP_PRIVATE_KEY),
      gardenerBinding: Boolean(this.env.GARDENER),
    });
  }

  async capabilities() {
    return githubGatewayCapabilitiesSchema.parse({
      contractVersion: GITHUB_GATEWAY_CONTRACT_VERSION,
      operations: operationKindValues.map((kind) => ({
        kind,
        available: availableGitHubOperationKinds.includes(
          kind as (typeof availableGitHubOperationKinds)[number],
        ),
      })),
    });
  }

  beginLogin() {
    return beginGitHubLogin(this.env);
  }

  beginInstallation(input: GitHubInstallationRequest) {
    return beginGitHubInstallation(this.env, input);
  }

  finalizeInstallation(input: GitHubInstallationRequest) {
    return finalizeGitHubInstallation(this.env, input);
  }

  syncRepositories() {
    return syncAllRepositories(this.env);
  }

  resolveUsername(input: ResolveGitHubUsername) {
    return resolveGitHubUsername(this.env, input);
  }

  executeOperation(input: ExecuteGitHubOperationRequest) {
    return executeBoundedOperation(this.env, input);
  }
}
