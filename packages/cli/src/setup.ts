import { resolve } from "node:path";
import type { DeploymentNames } from "./config.js";
import { deploymentNames } from "./config.js";
import { initializeGateway, validateWorkspace } from "./init.js";
import { planGateway } from "./plan.js";
import { confirmExact, prompt, resolveGitHubOwner } from "./prompts.js";
import { assertCloudflareResourceNamesAvailable } from "./provision.js";
import { smokeGateway } from "./smoke.js";
import { readCheckpoint, statePaths } from "./state.js";

export type SetupAppOwner =
  | { kind: "personal"; expectedLogin: string }
  | { kind: "organization"; login: string };

export interface SetupPreview {
  schemaVersion: "gardener-setup/v1";
  workspace: string;
  cloudflareAccountId: string;
  permanentOwner: { id: string; login: string };
  githubAppOwner: SetupAppOwner;
  resources: DeploymentNames;
  deploymentOrder: string[];
  mutations: string[];
  leavesGardenerPaused: true;
}

interface SetupOptions {
  workspace?: string;
  owner?: string;
  personal: boolean;
  organization?: string;
  repositoryRoot?: string;
}

export function setupPreview(input: {
  workspace: string;
  cloudflareAccountId: string;
  permanentOwner: { id: string; login: string };
  githubAppOwner: SetupAppOwner;
}): SetupPreview {
  const resources = deploymentNames(input.workspace);
  return {
    schemaVersion: "gardener-setup/v1",
    workspace: input.workspace,
    cloudflareAccountId: input.cloudflareAccountId,
    permanentOwner: input.permanentOwner,
    githubAppOwner: input.githubAppOwner,
    resources,
    deploymentOrder: [
      "provision Gardener D1, Gateway D1, and the Gardener R2 bucket",
      "deploy the credential-free Gateway shell and apply its migration",
      "deploy Gardener with outbound Gateway RPC and apply its migrations",
      "seed the confirmed immutable permanent owner",
      "redeploy Gateway with reverse Gardener RPC",
      "create the customer-owned GitHub App in the human browser",
      "upload GitHub credentials to Gateway secrets through stdin",
      "verify credentials, both RPC directions, capabilities, and delivery state",
    ],
    mutations: [
      `create Cloudflare resources in account ${input.cloudflareAccountId}`,
      `create a ${input.githubAppOwner.kind} GitHub App`,
      "write owner-only resumable setup state outside the repository",
    ],
    leavesGardenerPaused: true,
  };
}

export async function setupGardener(options: SetupOptions): Promise<void> {
  if (options.personal && options.organization) {
    throw new Error("Use either --personal or --organization, not both");
  }
  const repositoryRoot = resolve(options.repositoryRoot ?? process.cwd());
  const workspace = validateWorkspace(options.workspace ?? await prompt("Workspace name: "));
  const checkpoint = await readCheckpoint(statePaths(workspace).checkpoint);
  if (checkpoint) {
    console.log(`Resuming the checkpointed ${workspace} setup at ${checkpoint.step}.`);
    await initializeGateway({
      workspace,
      yes: false,
      ...(options.organization ? { organization: options.organization } : {}),
      repositoryRoot,
    });
    await smokeGateway(workspace);
    return;
  }

  const requestedOwner = options.owner ?? await prompt("Permanent owner GitHub login: ");
  const owner = await resolveGitHubOwner(requestedOwner);
  console.log(`Resolved permanent owner: @${owner.login} (GitHub user ID ${owner.id})`);
  await confirmExact("Confirm this immutable GitHub identity as the permanent owner.", owner.id);
  const appOwner = await selectAppOwner(options, owner.login);
  const names = deploymentNames(workspace);

  console.log("\nChecking the selected Cloudflare account and deterministic resource names.");
  const cloudflareAccountId = assertCloudflareResourceNamesAvailable(repositoryRoot, names);
  const preview = setupPreview({
    workspace,
    cloudflareAccountId,
    permanentOwner: owner,
    githubAppOwner: appOwner,
  });
  console.log("\nExact setup plan:");
  console.log(JSON.stringify(preview, null, 2));
  console.log("\nValidating all three generated deployment configurations locally.");
  await planGateway({ workspace, repositoryRoot });

  console.log("\nThis will now create the listed Cloudflare resources and a GitHub App.");
  console.log("No old deployment is deleted by setup.");
  await confirmExact("Confirm the exact setup plan.", `deploy ${workspace}`);

  await initializeGateway({
    workspace,
    owner: owner.login,
    ownerId: owner.id,
    yes: true,
    ...(appOwner.kind === "organization" ? { organization: appOwner.login } : {}),
    repositoryRoot,
  });
  await smokeGateway(workspace);
  console.log("\nSetup and baseline smoke validation passed. Gardener remains globally paused.");
}

async function selectAppOwner(
  options: SetupOptions,
  permanentOwnerLogin: string,
): Promise<SetupAppOwner> {
  if (options.organization) {
    return { kind: "organization", login: validateGitHubLogin(options.organization, "organization") };
  }
  if (options.personal) {
    return { kind: "personal", expectedLogin: permanentOwnerLogin };
  }
  const selection = (await prompt("GitHub App owner (personal/organization): ")).toLowerCase();
  if (selection === "personal") {
    return { kind: "personal", expectedLogin: permanentOwnerLogin };
  }
  if (selection === "organization") {
    const login = await prompt("GitHub organization login: ");
    return { kind: "organization", login: validateGitHubLogin(login, "organization") };
  }
  throw new Error("GitHub App owner must be personal or organization");
}

function validateGitHubLogin(value: string, label: string): string {
  const normalized = value.trim().replace(/^@/, "");
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(normalized)) {
    throw new Error(`Invalid GitHub ${label} login`);
  }
  return normalized;
}
