import { resolve } from "node:path";
import type { DeploymentNames } from "./config.js";
import { deploymentNames } from "./config.js";
import { initializeGateway, validateWorkspace } from "./init.js";
import { planGateway } from "./plan.js";
import { confirm, prompt, resolveGitHubOwner, select } from "./prompts.js";
import { assertCloudflareResourceNamesAvailable, selectedAccount } from "./provision.js";
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
  verbose: boolean;
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
  const quietCommands = !options.verbose;
  printWelcome();
  printInstallationQuestion();

  const workspace = validateWorkspace(options.workspace ?? await prompt("   Installation name: "));
  console.log(`\n   Installation: ${workspace}`);
  console.log(`   Gardener:     gardener-${workspace}`);
  console.log(`   Gateway:      gardener-${workspace}-github-gateway`);

  const checkpoint = await readCheckpoint(statePaths(workspace).checkpoint);
  if (checkpoint) {
    console.log(`\nFound an incomplete setup at “${checkpoint.step}”.`);
    if (!await confirm("Resume this installation?", true)) {
      console.log("\nSetup cancelled. No resources were changed.");
      return;
    }
    await initializeGateway({
      workspace,
      yes: false,
      ...(options.organization ? { organization: options.organization } : {}),
      repositoryRoot,
      quietCommands,
    });
    await smokeGateway(workspace);
    return;
  }

  console.log("\n2. Choose the first owner");
  console.log("   This person can manage members, policies, Agents, and installations.");
  console.log("   Gardener uses their GitHub account so ownership cannot be claimed by the first visitor.\n");
  const requestedOwner = options.owner ?? await prompt("   GitHub username: ");
  const owner = await resolveGitHubOwner(requestedOwner);
  console.log("\n   Owner found");
  console.log(`   GitHub account: @${owner.login}`);
  console.log(`   Profile:        https://github.com/${owner.login}`);
  console.log(`   Internal ID:    ${owner.id} (shown for reference only)`);
  if (!await confirm("\n   Is this the correct permanent owner?", true)) {
    console.log("\nSetup cancelled. No resources were changed.");
    return;
  }

  console.log("\n3. Choose where the GitHub App lives");
  console.log("   The private App connects GitHub repositories to this Gardener installation.");
  console.log("   It can be installed on personal or organization repositories after setup.\n");
  const appOwner = await selectAppOwner(options, owner.login);
  const names = deploymentNames(workspace);

  console.log("\nChecking your setup");
  console.log("  ✓ GitHub owner found");
  const account = selectedAccount(repositoryRoot);
  console.log(`  ✓ Cloudflare account: ${account.name}`);
  const cloudflareAccountId = assertCloudflareResourceNamesAvailable(repositoryRoot, names);
  if (cloudflareAccountId !== account.id) {
    throw new Error("Cloudflare account changed while setup was being checked");
  }
  console.log("  ✓ Resource names are available");
  await planGateway({ workspace, repositoryRoot, quiet: quietCommands });
  console.log("  ✓ Deployment configuration is valid");

  const preview = setupPreview({
    workspace,
    cloudflareAccountId,
    permanentOwner: owner,
    githubAppOwner: appOwner,
  });
  printSummary(preview, account.name);
  if (!await confirm("\nCreate these resources now?", false)) {
    console.log("\nSetup cancelled. No Cloudflare or GitHub resources were created.");
    return;
  }

  console.log("\nInstalling Gardener");
  await initializeGateway({
    workspace,
    owner: owner.login,
    ownerId: owner.id,
    yes: true,
    ...(appOwner.kind === "organization" ? { organization: appOwner.login } : {}),
    repositoryRoot,
    quietCommands,
  });
  await smokeGateway(workspace);
  console.log("\n✓ Setup and baseline checks passed");
  console.log("  Gardener remains paused until you deliberately enable an Agent assignment.");
}

function printInstallationQuestion(): void {
  console.log("1. Name this installation");
  console.log("   Choose a short, stable name for this Gardener deployment.");
  console.log("   It is used only to name your private Cloudflare resources.");
  console.log("   Examples: acme, platform-team, dev");
}

async function selectAppOwner(
  options: SetupOptions,
  permanentOwnerLogin: string,
): Promise<SetupAppOwner> {
  if (options.organization) {
    const login = validateGitHubLogin(options.organization, "organization");
    console.log(`   GitHub organization: @${login}`);
    return { kind: "organization", login };
  }
  if (options.personal) {
    console.log(`   Personal account: @${permanentOwnerLogin}`);
    return { kind: "personal", expectedLogin: permanentOwnerLogin };
  }
  const choice = await select("   Where should GitHub manage this App?", [
    {
      label: `Personal account @${permanentOwnerLogin}`,
      description: "Simplest for an individual or development installation.",
    },
    {
      label: "GitHub organization",
      description: "Best when organization owners should administer the App.",
    },
  ]);
  if (choice === 0) return { kind: "personal", expectedLogin: permanentOwnerLogin };
  const login = await prompt("\n   GitHub organization name: ");
  return { kind: "organization", login: validateGitHubLogin(login, "organization") };
}

function printWelcome(): void {
  console.log("\nGardener setup");
  console.log("==============");
  console.log("This guided installer creates one private Gardener workspace in your Cloudflare account");
  console.log("and one GitHub App owned by you or your organization.");
  console.log("\nNothing is created until you review the summary and answer yes.\n");
}

function printSummary(preview: SetupPreview, accountName: string): void {
  const appOwner = preview.githubAppOwner.kind === "personal"
    ? `Personal account @${preview.githubAppOwner.expectedLogin}`
    : `Organization @${preview.githubAppOwner.login}`;
  console.log("\nReady to install");
  console.log("----------------");
  console.log(`Installation:       ${preview.workspace}`);
  console.log(`Permanent owner:    @${preview.permanentOwner.login}`);
  console.log(`GitHub App owner:   ${appOwner}`);
  console.log(`Cloudflare account: ${accountName}`);
  console.log("\nCloudflare resources");
  console.log(`  Gardener Worker:  ${preview.resources.gardenerWorker}`);
  console.log(`  Gateway Worker:   ${preview.resources.gatewayWorker}`);
  console.log(`  Databases:        ${preview.resources.gardenerDatabase}, ${preview.resources.gatewayDatabase}`);
  console.log(`  Storage bucket:   ${preview.resources.inputBucket}`);
  console.log(`  Workflow:         ${preview.resources.workflow}`);
  console.log("\nGitHub will open once so you can approve creation of the private App.");
  console.log("Existing deployments are never deleted or replaced.");
}

function validateGitHubLogin(value: string, label: string): string {
  const normalized = value.trim().replace(/^@/, "");
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(normalized)) {
    throw new Error(`Invalid GitHub ${label} login`);
  }
  return normalized;
}
