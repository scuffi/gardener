import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runCommand, uploadSecret, workerOrigin, wrangler } from "./commands.js";
import { deploymentNames, writeGardenerConfig, writeGatewayConfig } from "./config.js";
import { createGitHubAppFromManifest, type AppOwner } from "./manifest.js";
import { confirmExact, prompt, resolveGitHubOwner } from "./prompts.js";
import {
  assertCloudflareResourceNamesAvailable,
  provisionCloudflareResources,
} from "./provision.js";
import { terminal } from "./terminal.js";
import {
  atOrAfter,
  readCheckpoint,
  statePaths,
  type ManifestCredentials,
  type SetupCheckpoint,
  type SetupStep,
  writePrivateJson,
  writePrivateText,
} from "./state.js";

export interface InitOptions {
  workspace?: string;
  owner?: string;
  ownerId?: string;
  yes: boolean;
  organization?: string;
  repositoryRoot?: string;
  qualification?: boolean;
  quietCommands?: boolean;
}

interface SetupRecovery {
  app: ManifestCredentials;
  operationMarkerKey: string;
}

export async function initializeGateway(options: InitOptions): Promise<void> {
  const repositoryRoot = resolve(options.repositoryRoot ?? process.cwd());
  const commandOptions = { quiet: options.quietCommands === true };
  assertRepository(repositoryRoot);
  const workspace = validateWorkspace(options.workspace ?? await prompt("Workspace name: "));
  if (options.qualification && !workspace.startsWith("qual-")) {
    throw new Error("Qualification workspace names must start with qual-");
  }
  const paths = statePaths(workspace);
  const names = deploymentNames(workspace);
  let checkpoint = await readCheckpoint(paths.checkpoint);

  if (!checkpoint) {
    const requestedOwner = options.owner ?? await prompt("Permanent owner GitHub login: ");
    const owner = await resolveGitHubOwner(requestedOwner);
    console.log(`Resolved permanent owner: @${owner.login} (GitHub user ID ${owner.id})`);
    if (options.yes) {
      if (options.ownerId !== owner.id) {
        throw new Error("Non-interactive setup requires --owner-id matching the resolved GitHub ID");
      }
    } else {
      await confirmExact("Confirm this immutable GitHub identity as the permanent owner.", owner.id);
    }
    checkpoint = {
      version: 2,
      workspace,
      step: "new",
      owner,
      purpose: options.qualification ? "qualification" : "workspace",
      githubAppOwner: options.organization
        ? { kind: "organization", login: options.organization }
        : { kind: "personal", login: owner.login },
      updatedAt: new Date().toISOString(),
    };
    await writePrivateJson(paths.checkpoint, checkpoint);
  } else {
    assertCheckpoint(checkpoint, workspace, options.qualification === true, options.organization);
    console.log(`Resuming ${workspace} from checkpoint: ${checkpoint.step}`);
  }

  if (!atOrAfter(checkpoint.step, "resources-provisioning")) {
    printProgress("Preparing Cloudflare resources…");
    checkpoint.cloudflareAccountId = assertCloudflareResourceNamesAvailable(repositoryRoot, names);
    checkpoint = await advance(paths.checkpoint, checkpoint, "resources-provisioning");
    printProgressSuccess("Setup intent recorded");
  }

  if (!atOrAfter(checkpoint.step, "resources-provisioned")) {
    printProgress("Creating private data stores…");
    const resources = await provisionCloudflareResources({
      repositoryRoot,
      names,
      expectedAccountId: required(checkpoint.cloudflareAccountId, "Cloudflare account ID"),
      quiet: commandOptions.quiet,
    });
    checkpoint.gardenerDatabaseId = resources.gardenerDatabaseId;
    checkpoint.gatewayDatabaseId = resources.gatewayDatabaseId;
    checkpoint = await advance(paths.checkpoint, checkpoint, "resources-provisioned");
    printProgressSuccess("Private databases and storage are ready");
  }

  if (!atOrAfter(checkpoint.step, "gateway-shell-deployed")) {
    printProgress("Deploying the GitHub Gateway…");
    const shellConfig = await writeGatewayConfig({
      repositoryRoot,
      workspace,
      gatewayOrigin: "https://pending.invalid",
      gardenerOrigin: "https://pending.invalid",
      linked: false,
      gatewayDatabaseId: required(checkpoint.gatewayDatabaseId, "Gateway database ID"),
      cloudflareAccountId: required(checkpoint.cloudflareAccountId, "Cloudflare account ID"),
    });
    const deployed = wrangler(repositoryRoot, "apps/github-gateway", [
      "deploy", "--config", shellConfig,
    ], undefined, commandOptions);
    checkpoint.gatewayOrigin = workerOrigin(deployed, names.gatewayWorker);
    wrangler(repositoryRoot, "apps/github-gateway", [
      "d1", "migrations", "apply", names.gatewayDatabase, "--remote",
      "--config", shellConfig,
    ], undefined, commandOptions);
    checkpoint = await advance(paths.checkpoint, checkpoint, "gateway-shell-deployed");
    printProgressSuccess("GitHub Gateway deployed");
  }

  if (!atOrAfter(checkpoint.step, "gardener-deployed")) {
    printProgress("Deploying Gardener…");
    runCommand("pnpm", ["--filter", "@gardener/app", "build"], {
      cwd: repositoryRoot,
      quiet: commandOptions.quiet,
    });
    const gardenerConfig = await writeGardenerConfig({
      repositoryRoot,
      workspace,
      gardenerDatabaseId: required(checkpoint.gardenerDatabaseId, "Gardener database ID"),
      cloudflareAccountId: required(checkpoint.cloudflareAccountId, "Cloudflare account ID"),
    });
    const deployed = wrangler(repositoryRoot, "apps/gardener", [
      "deploy", "--config", gardenerConfig, "--containers-rollout", "none",
    ], undefined, commandOptions);
    checkpoint.gardenerOrigin = workerOrigin(deployed, names.gardenerWorker);
    wrangler(repositoryRoot, "apps/gardener", [
      "d1", "migrations", "apply", names.gardenerDatabase, "--remote",
      "--config", gardenerConfig,
    ], undefined, commandOptions);
    await seedPermanentOwner(
      repositoryRoot,
      checkpoint.owner,
      names.gardenerDatabase,
      gardenerConfig,
      options.quietCommands === true,
    );
    checkpoint = await advance(paths.checkpoint, checkpoint, "gardener-deployed");
    printProgressSuccess("Gardener deployed, migrated, and paused");
  }

  if (!atOrAfter(checkpoint.step, "gateway-linked")) {
    printProgress("Connecting Gardener and the Gateway…");
    const gatewayOrigin = required(checkpoint.gatewayOrigin, "Gateway origin");
    const gardenerOrigin = required(checkpoint.gardenerOrigin, "Gardener origin");
    const gatewayConfig = await writeGatewayConfig({
      repositoryRoot,
      workspace,
      gatewayOrigin,
      gardenerOrigin,
      linked: true,
      gatewayDatabaseId: required(checkpoint.gatewayDatabaseId, "Gateway database ID"),
      cloudflareAccountId: required(checkpoint.cloudflareAccountId, "Cloudflare account ID"),
    });
    wrangler(repositoryRoot, "apps/github-gateway", [
      "deploy", "--config", gatewayConfig,
    ], undefined, commandOptions);
    checkpoint = await advance(paths.checkpoint, checkpoint, "gateway-linked");
    printProgressSuccess("Private connection established");
  }

  let recovery = await readRecovery(paths.recovery);
  if (!atOrAfter(checkpoint.step, "manifest-created")) {
    printProgress("Opening GitHub to create your private App…");
    if (!recovery) {
      const appOwner: AppOwner = checkpoint.githubAppOwner
        ?? missingAppOwner();
      const operationMarkerKey = randomBytes(32).toString("base64url");
      const app = await createGitHubAppFromManifest({
        appName: `Gardener ${workspace} ${randomBytes(4).toString("hex")}`,
        gardenerOrigin: required(checkpoint.gardenerOrigin, "Gardener origin"),
        gatewayOrigin: required(checkpoint.gatewayOrigin, "Gateway origin"),
        owner: appOwner,
        persistCredentials: async (credentials) => {
          recovery = { app: credentials, operationMarkerKey };
          await writePrivateJson(paths.recovery, recovery);
        },
      });
      recovery = { app, operationMarkerKey };
    } else {
      console.log("Reusing the existing owner-only GitHub App recovery file.");
    }
    assertManifestOwner(recovery.app, checkpoint.githubAppOwner, paths.recovery);
    checkpoint.githubAppSlug = recovery.app.slug;
    checkpoint = await advance(paths.checkpoint, checkpoint, "manifest-created");
    printProgressSuccess(`GitHub App created: ${terminal.value(recovery.app.slug)}`);
  }

  let operatorToken: string;
  try {
    operatorToken = (await readFile(paths.operatorToken, "utf8")).trim();
    if (!/^[A-Za-z0-9_-]{43}$/.test(operatorToken)) {
      throw new Error(`Gateway operator token is invalid: ${paths.operatorToken}`);
    }
  }
  catch {
    if (atOrAfter(checkpoint.step, "secrets-uploaded")) {
      throw new Error(`Gateway operator token is missing: ${paths.operatorToken}`);
    }
    operatorToken = randomBytes(32).toString("base64url");
    await writePrivateText(paths.operatorToken, `${operatorToken}\n`);
  }

  if (!atOrAfter(checkpoint.step, "secrets-uploaded")) {
    printProgress("Securing GitHub credentials in the Gateway…");
    if (!recovery) throw new Error(`Setup recovery file is missing: ${paths.recovery}`);
    const secrets: Record<string, string> = {
      GITHUB_APP_ID: String(recovery.app.id),
      GITHUB_APP_SLUG: recovery.app.slug,
      GITHUB_APP_PRIVATE_KEY: recovery.app.pem,
      GITHUB_CLIENT_ID: recovery.app.client_id,
      GITHUB_CLIENT_SECRET: recovery.app.client_secret,
      GITHUB_WEBHOOK_SECRET: recovery.app.webhook_secret,
      GATEWAY_OPERATOR_TOKEN: operatorToken,
      OPERATION_MARKER_KEY: recovery.operationMarkerKey,
    };
    const gatewayConfig = await writeGatewayConfig({
      repositoryRoot,
      workspace,
      gatewayOrigin: required(checkpoint.gatewayOrigin, "Gateway origin"),
      gardenerOrigin: required(checkpoint.gardenerOrigin, "Gardener origin"),
      linked: true,
      gatewayDatabaseId: required(checkpoint.gatewayDatabaseId, "Gateway database ID"),
      cloudflareAccountId: required(checkpoint.cloudflareAccountId, "Cloudflare account ID"),
    });
    for (const [name, value] of Object.entries(secrets)) {
      uploadSecret(
        repositoryRoot,
        "apps/github-gateway",
        name,
        value,
        gatewayConfig,
        options.quietCommands === true,
      );
    }
    checkpoint = await advance(paths.checkpoint, checkpoint, "secrets-uploaded");
    printProgressSuccess("Credentials secured");
  }

  printProgress("Running final connection checks…");
  await verifyGateway(
    required(checkpoint.gatewayOrigin, "Gateway origin"),
    required(checkpoint.gardenerOrigin, "Gardener origin"),
    operatorToken,
  );
  if (!atOrAfter(checkpoint.step, "complete")) {
    checkpoint = await advance(paths.checkpoint, checkpoint, "complete");
  }
  await unlink(paths.recovery).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  printProgressSuccess(`Gardener is ready for ${terminal.value(workspace)}`);
  console.log(`\n  Gardener: ${terminal.value(required(checkpoint.gardenerOrigin, "Gardener origin"))}`);
  console.log(`  Gateway:  ${terminal.value(required(checkpoint.gatewayOrigin, "Gateway origin"))}`);
  if (options.quietCommands) {
    console.log(`  Local setup state: ${paths.directory}`);
  } else {
    console.log(`  Operator token: ${paths.operatorToken} (mode 0600)`);
  }
}

async function seedPermanentOwner(
  repositoryRoot: string,
  owner: { id: string; login: string },
  databaseName: string,
  config: string,
  quiet: boolean,
): Promise<void> {
  const temporary = await mkdtemp(join(tmpdir(), "gardener-owner-"));
  const file = join(temporary, "owner.sql");
  const subject = sql(owner.id);
  const login = sql(owner.login);
  const userId = sql(`user_github_${owner.id}`);
  const identityId = sql(`identity_github_${owner.id}`);
  const membershipId = sql(`membership_github_${owner.id}`);
  const script = [
    `INSERT INTO users(id,display_name) VALUES(${userId},${login}) ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name;`,
    `INSERT INTO external_identities(id,user_id,provider,provider_subject,username,profile_json) VALUES(${identityId},${userId},'github',${subject},${login},json_object('login',${login})) ON CONFLICT(provider,provider_subject) DO UPDATE SET username=excluded.username,profile_json=excluded.profile_json;`,
    `INSERT INTO memberships(id,user_id,role,permanent) VALUES(${membershipId},${userId},'owner',1) ON CONFLICT(user_id) DO NOTHING;`,
  ].join("\n");
  await writeFile(file, script, { mode: 0o600 });
  try {
    wrangler(repositoryRoot, "apps/gardener", [
      "d1", "execute", databaseName, "--remote", "--file", file,
      "--config", config,
    ], undefined, { quiet });
    const verification = wrangler(repositoryRoot, "apps/gardener", [
      "d1", "execute", databaseName, "--remote", "--json",
      "--command",
      `SELECT role, permanent FROM memberships WHERE user_id = ${userId}`,
      "--config", config,
    ], undefined, { quiet });
    if (!containsPermanentOwner(verification.stdout)) {
      throw new Error("Permanent owner bootstrap verification failed");
    }
    const pauseVerification = wrangler(repositoryRoot, "apps/gardener", [
      "d1", "execute", databaseName, "--remote", "--json",
      "--command", "SELECT value FROM settings WHERE key = 'global_paused'",
      "--config", config,
    ], undefined, { quiet });
    if (!containsGlobalPause(pauseVerification.stdout)) {
      throw new Error("Fresh Gardener is not globally paused");
    }
  } finally {
    await unlink(file).catch(() => undefined);
  }
}

async function verifyGateway(
  origin: string,
  gardenerOrigin: string,
  operatorToken: string,
): Promise<void> {
  const health = await fetch(`${origin}/health`, { headers: { accept: "application/json" } });
  const healthBody = await health.json() as { ready?: boolean };
  if (!health.ok || healthBody.ready !== true) throw new Error("Gateway health check is not ready");
  const doctor = await fetch(`${origin}/ops/doctor`, {
    headers: { authorization: `Bearer ${operatorToken}`, accept: "application/json" },
  });
  const doctorBody = await doctor.json() as { health?: { ready?: boolean } };
  if (!doctor.ok) throw new Error(`Gateway doctor failed (${doctor.status})`);
  if (doctorBody.health?.ready !== true) {
    throw new Error("Gateway credential and binding verification is not ready");
  }
  const gardener = await fetch(`${gardenerOrigin}/api/health`, {
    headers: { accept: "application/json" },
  });
  const gardenerBody = await gardener.json() as {
    ok?: boolean;
    githubGateway?: { configured?: boolean; ready?: boolean };
  };
  if (!gardener.ok || gardenerBody.ok !== true || gardenerBody.githubGateway?.ready !== true) {
    throw new Error("Gardener to Gateway binding verification is not ready");
  }
}

async function readRecovery(path: string): Promise<SetupRecovery | null> {
  try { return JSON.parse(await readFile(path, "utf8")) as SetupRecovery; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function advance(
  path: string,
  checkpoint: SetupCheckpoint,
  step: SetupStep,
): Promise<SetupCheckpoint> {
  const next = { ...checkpoint, step, updatedAt: new Date().toISOString() };
  await writePrivateJson(path, next);
  return next;
}

export function validateWorkspace(value: string): string {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(value)) {
    throw new Error("Workspace must be 1-32 lowercase letters, numbers, or hyphens");
  }
  return value;
}

function assertRepository(root: string): void {
  try { requireFile(`${root}/apps/gardener/package.json`); requireFile(`${root}/apps/github-gateway/package.json`); }
  catch { throw new Error("Run `gardener setup` from a Gardener repository checkout"); }
}

function requireFile(path: string): void {
  runCommand(process.execPath, ["-e", "require('node:fs').accessSync(process.argv[1])", path], {
    cwd: process.cwd(),
    quiet: true,
  });
}

function assertCheckpoint(
  checkpoint: SetupCheckpoint,
  workspace: string,
  qualification: boolean,
  organization: string | undefined,
): void {
  if (checkpoint.version !== 2 || checkpoint.workspace !== workspace) {
    throw new Error("Setup checkpoint does not match this workspace");
  }
  const purpose = checkpoint.purpose ?? "workspace";
  if (qualification !== (purpose === "qualification")) {
    throw new Error("Setup checkpoint purpose does not match this invocation");
  }
  if (checkpoint.step === "destroyed") {
    throw new Error("This qualification workspace was already destroyed; choose a new workspace name");
  }
  if (organization && (
    checkpoint.githubAppOwner?.kind !== "organization"
    || checkpoint.githubAppOwner.login !== organization
  )) {
    throw new Error("GitHub App owner does not match the setup checkpoint");
  }
}

function missingAppOwner(): never {
  throw new Error(
    "Setup checkpoint predates GitHub App owner binding; remove the incomplete stack and begin setup again",
  );
}

function assertManifestOwner(
  app: ManifestCredentials,
  expected: SetupCheckpoint["githubAppOwner"],
  recoveryPath: string,
): void {
  if (!expected) missingAppOwner();
  const expectedType = expected.kind === "personal" ? "User" : "Organization";
  if (
    app.owner.type !== expectedType
    || app.owner.login.toLowerCase() !== expected.login.toLowerCase()
  ) {
    throw new Error(
      `GitHub created App ${app.slug} under ${app.owner.type} @${app.owner.login}, not the confirmed `
      + `${expectedType} @${expected.login}. Delete that App, remove ${recoveryPath} without reading `
      + "it, and rerun setup.",
    );
  }
}

function required(value: string | undefined, label: string): string {
  if (!value) throw new Error(`${label} is missing from the setup checkpoint`);
  return value;
}

function containsPermanentOwner(output: string): boolean {
  try {
    const visit = (value: unknown): boolean => {
      if (!value || typeof value !== "object") return false;
      if (!Array.isArray(value)) {
        const row = value as Record<string, unknown>;
        if (row.role === "owner" && Number(row.permanent) === 1) return true;
      }
      return Object.values(value).some(visit);
    };
    return visit(JSON.parse(output));
  } catch {
    return false;
  }
}

function containsGlobalPause(output: string): boolean {
  try {
    const visit = (value: unknown): boolean => {
      if (!value || typeof value !== "object") return false;
      if (!Array.isArray(value) && (value as Record<string, unknown>).value === "true") return true;
      return Object.values(value).some(visit);
    };
    return visit(JSON.parse(output));
  } catch {
    return false;
  }
}

function printProgress(message: string): void {
  console.log(`\n  ${terminal.strong(message)}`);
}

function printProgressSuccess(message: string): void {
  console.log(`  ${terminal.success("✓")} ${message}`);
}

function sql(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
