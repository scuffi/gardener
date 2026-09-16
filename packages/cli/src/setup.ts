import { resolve } from "node:path";
import type { DeploymentNames } from "./config.js";
import { deploymentNames } from "./config.js";
import { initializeGateway, validateWorkspace } from "./init.js";
import { planGateway } from "./plan.js";
import { confirm, prompt, resolveGitHubOwner, select } from "./prompts.js";
import { assertCloudflareResourceNamesAvailable, selectedAccount } from "./provision.js";
import { smokeGateway } from "./smoke.js";
import { readCheckpoint, statePaths } from "./state.js";
import { terminal } from "./terminal.js";

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

  const workspace = validateWorkspace(
    options.workspace ?? await prompt(`   ${terminal.strong("Installation name:")} `),
  );
  console.log(`\n   Installation: ${terminal.value(workspace)}`);
  console.log(`   Gardener:     ${terminal.value(`gardener-${workspace}`)}`);
  console.log(`   Gateway:      ${terminal.value(`gardener-${workspace}-github-gateway`)}`);

  const checkpoint = await readCheckpoint(statePaths(workspace).checkpoint);
  if (checkpoint) {
    console.log(`\n${terminal.heading("Incomplete setup found")} at ${terminal.value(checkpoint.step)}.`);
    if (!await confirm("Resume this installation?", true)) {
      console.log(`\n${terminal.caution("Setup cancelled.")} No resources were changed.`);
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

  console.log(`\n${terminal.heading("2. Choose the first owner")}`);
  console.log(terminal.muted("   This person can manage members, policies, Agents, and installations."));
  console.log(terminal.muted("   Gardener uses their GitHub account so ownership cannot be claimed by the first visitor.\n"));
  const requestedOwner = options.owner ?? await prompt(`   ${terminal.strong("GitHub username:")} `);
  const owner = await resolveGitHubOwner(requestedOwner);
  console.log(`\n   ${terminal.success("✓")} ${terminal.strong("Owner found")}`);
  console.log(`   GitHub account: ${terminal.value(`@${owner.login}`)}`);
  console.log(`   Profile:        ${terminal.value(`https://github.com/${owner.login}`)}`);
  console.log(`   Internal ID:    ${terminal.muted(`${owner.id} (shown for reference only)`)}`);
  if (!await confirm("\n   Is this the correct permanent owner?", true)) {
    console.log(`\n${terminal.caution("Setup cancelled.")} No resources were changed.`);
    return;
  }

  console.log(`\n${terminal.heading("3. Choose where the GitHub App lives")}`);
  console.log(terminal.muted("   The private App connects GitHub repositories to this Gardener installation."));
  console.log(terminal.muted("   It can be installed on personal or organization repositories after setup.\n"));
  const appOwner = await selectAppOwner(options, owner.login);
  const names = deploymentNames(workspace);

  console.log(`\n${terminal.heading("Checking your setup")}`);
  printSuccess("GitHub owner found");
  const account = selectedAccount(repositoryRoot);
  printSuccess(`Cloudflare account: ${terminal.value(account.name)}`);
  const cloudflareAccountId = assertCloudflareResourceNamesAvailable(repositoryRoot, names);
  if (cloudflareAccountId !== account.id) {
    throw new Error("Cloudflare account changed while setup was being checked");
  }
  printSuccess("Resource names are available");
  await planGateway({ workspace, repositoryRoot, quiet: quietCommands });
  printSuccess("Deployment configuration is valid");

  const preview = setupPreview({
    workspace,
    cloudflareAccountId,
    permanentOwner: owner,
    githubAppOwner: appOwner,
  });
  printSummary(preview, account.name);
  if (!await confirm("\nCreate these resources now?", false)) {
    console.log(`\n${terminal.caution("Setup cancelled.")} No Cloudflare or GitHub resources were created.`);
    return;
  }

  console.log(`\n${terminal.heading("Installing Gardener")}`);
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
  console.log(`\n${terminal.success("✓")} ${terminal.strong("Setup and baseline checks passed")}`);
  console.log(terminal.muted("  Gardener remains paused until you deliberately enable an Agent assignment."));
}

function printInstallationQuestion(): void {
  console.log(terminal.heading("1. Name this installation"));
  console.log(terminal.muted("   Choose a short, stable name for this Gardener deployment."));
  console.log(terminal.muted("   It is used only to name your private Cloudflare resources."));
  console.log(terminal.muted("   Examples: acme, platform-team, dev"));
}

async function selectAppOwner(
  options: SetupOptions,
  permanentOwnerLogin: string,
): Promise<SetupAppOwner> {
  if (options.organization) {
    const login = validateGitHubLogin(options.organization, "organization");
    console.log(`   GitHub organization: ${terminal.value(`@${login}`)}`);
    return { kind: "organization", login };
  }
  if (options.personal) {
    console.log(`   Personal account: ${terminal.value(`@${permanentOwnerLogin}`)}`);
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
  const login = await prompt(`\n   ${terminal.strong("GitHub organization name:")} `);
  return { kind: "organization", login: validateGitHubLogin(login, "organization") };
}

function printWelcome(): void {
  console.log(`\n${terminal.title("Gardener setup")}`);
  console.log(terminal.muted("=============="));
  console.log(terminal.muted("This guided installer creates one private Gardener workspace in your Cloudflare account"));
  console.log(terminal.muted("and one GitHub App owned by you or your organization."));
  console.log(`\n${terminal.caution("Nothing is created until you review the summary and answer yes.")}\n`);
}

function printSummary(preview: SetupPreview, accountName: string): void {
  const appOwner = preview.githubAppOwner.kind === "personal"
    ? `Personal account @${preview.githubAppOwner.expectedLogin}`
    : `Organization @${preview.githubAppOwner.login}`;
  console.log(`\n${terminal.title("Ready to install")}`);
  console.log(terminal.muted("----------------"));
  console.log(`Installation:       ${terminal.value(preview.workspace)}`);
  console.log(`Permanent owner:    ${terminal.value(`@${preview.permanentOwner.login}`)}`);
  console.log(`GitHub App owner:   ${terminal.value(appOwner)}`);
  console.log(`Cloudflare account: ${terminal.value(accountName)}`);
  console.log(`\n${terminal.strong("Cloudflare resources")}`);
  console.log(`  Gardener Worker:  ${terminal.value(preview.resources.gardenerWorker)}`);
  console.log(`  Gateway Worker:   ${terminal.value(preview.resources.gatewayWorker)}`);
  console.log(`  Databases:        ${terminal.value(`${preview.resources.gardenerDatabase}, ${preview.resources.gatewayDatabase}`)}`);
  console.log(`  Storage bucket:   ${terminal.value(preview.resources.inputBucket)}`);
  console.log(`  Workflow:         ${terminal.value(preview.resources.workflow)}`);
  console.log(`\n${terminal.muted("GitHub will open once so you can approve creation of the private App.")}`);
  console.log(terminal.muted("Existing deployments are never deleted or replaced."));
}

function printSuccess(message: string): void {
  console.log(`  ${terminal.success("✓")} ${message}`);
}

function validateGitHubLogin(value: string, label: string): string {
  const normalized = value.trim().replace(/^@/, "");
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(normalized)) {
    throw new Error(`Invalid GitHub ${label} login`);
  }
  return normalized;
}
