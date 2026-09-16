import { readFile, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { runCommand } from "./commands.js";
import { deploymentNames } from "./config.js";
import { listDatabases, r2BucketExists, selectedAccountId } from "./provision.js";
import { readCheckpoint, statePaths, writePrivateJson } from "./state.js";

export function destroyPlan(workspace: string) {
  const names = deploymentNames(workspace);
  return {
    schemaVersion: "gateway-destroy-plan/v1" as const,
    workspace,
    qualificationOnly: true,
    cloudflareResources: {
      workers: [names.gardenerWorker, names.gatewayWorker],
      d1Databases: [names.gardenerDatabase, names.gatewayDatabase],
      r2Buckets: [names.inputBucket],
    },
    retainedForAudit: ["setup.json", "teardown.json", "reports/"],
    manualGitHubCleanupRequired: true,
  };
}

export async function destroyQualification(input: {
  workspace: string;
  execute: boolean;
  confirm?: string;
  repositoryRoot?: string;
}): Promise<void> {
  const repositoryRoot = resolve(input.repositoryRoot ?? process.cwd());
  const paths = statePaths(input.workspace);
  const checkpoint = await readCheckpoint(paths.checkpoint);
  if (!checkpoint || checkpoint.workspace !== input.workspace) {
    throw new Error(`No setup checkpoint exists for ${input.workspace}`);
  }
  if (!input.workspace.startsWith("qual-") || checkpoint.purpose !== "qualification") {
    throw new Error("Destroy is restricted to checkpoints explicitly created as qual-* qualification stacks");
  }
  const plan = destroyPlan(input.workspace);
  const githubAppSlug = checkpoint.githubAppSlug ?? await recoveryAppSlug(paths.recovery);
  console.log(JSON.stringify({ ...plan, execute: input.execute }, null, 2));
  if (!input.execute) {
    console.log("\nDry run only. No remote or local resource was changed.");
    console.log(`Execute with --execute --confirm ${input.workspace}`);
    return;
  }
  if (input.confirm !== input.workspace) {
    throw new Error(`Destruction requires --confirm ${input.workspace}`);
  }
  const names = deploymentNames(input.workspace);
  assertWorkerOrigin(checkpoint.gardenerOrigin, names.gardenerWorker);
  assertWorkerOrigin(checkpoint.gatewayOrigin, names.gatewayWorker);
  if (!checkpoint.cloudflareAccountId) {
    await completeLocalTeardown(paths, checkpoint, plan, githubAppSlug);
    console.log("\nNo Cloudflare provisioning intent was recorded; only local qualification state existed.");
    return;
  }
  if (selectedAccountId(repositoryRoot) !== checkpoint.cloudflareAccountId) {
    throw new Error("Current Wrangler account does not match the qualification checkpoint");
  }

  const databases = listDatabases(repositoryRoot);
  assertDatabaseIdentity(databases, names.gardenerDatabase, checkpoint.gardenerDatabaseId);
  assertDatabaseIdentity(databases, names.gatewayDatabase, checkpoint.gatewayDatabaseId);

  const minimalConfig = `${paths.directory}/teardown-wrangler.json`;
  await writePrivateJson(minimalConfig, {
    name: names.gardenerWorker,
    account_id: checkpoint.cloudflareAccountId,
    compatibility_date: "2026-09-02",
  });
  try {
    deleteWorker(repositoryRoot, "apps/gardener", names.gardenerWorker, minimalConfig);
    deleteWorker(repositoryRoot, "apps/github-gateway", names.gatewayWorker, minimalConfig);
    deleteDatabase(
      repositoryRoot,
      names.gardenerDatabase,
      databases.some((database) => database.name === names.gardenerDatabase),
    );
    deleteDatabase(
      repositoryRoot,
      names.gatewayDatabase,
      databases.some((database) => database.name === names.gatewayDatabase),
    );
    if (r2BucketExists(repositoryRoot, names.inputBucket)) {
      runCommand(
        "pnpm",
        ["exec", "wrangler", "r2", "bucket", "delete", names.inputBucket],
        { cwd: `${repositoryRoot}/apps/github-gateway` },
      );
    }
  } finally {
    await unlink(minimalConfig).catch(() => undefined);
  }

  await completeLocalTeardown(paths, checkpoint, plan, githubAppSlug);
  console.log("\nQualification Cloudflare resources were deleted.");
  console.log(
    `Delete the GitHub App ${githubAppSlug ?? "recorded in the recovery file"} from GitHub settings ` +
    "and verify its installations are removed.",
  );
}

function assertWorkerOrigin(origin: string | undefined, worker: string): void {
  if (!origin) return;
  const hostname = new URL(origin).hostname;
  if (!hostname.startsWith(`${worker}.`) || !hostname.endsWith(".workers.dev")) {
    throw new Error(`Refusing to delete ${worker}: its recorded origin does not match`);
  }
}

function assertDatabaseIdentity(
  databases: Array<{ name: string; uuid: string }>,
  name: string,
  expectedId: string | undefined,
): void {
  const database = databases.find((candidate) => candidate.name === name);
  if (database && expectedId && database.uuid !== expectedId) {
    throw new Error(`Refusing to delete ${name}: its D1 ID does not match the setup checkpoint`);
  }
}

function deleteWorker(
  repositoryRoot: string,
  directory: string,
  worker: string,
  config: string,
): void {
  const result = runCommand(
    "pnpm",
    ["exec", "wrangler", "delete", worker, "--force", "--config", config],
    { cwd: `${repositoryRoot}/${directory}`, allowFailure: true },
  );
  if (result.status !== 0 && !/not found|does not exist|10090/i.test(`${result.stdout}\n${result.stderr}`)) {
    throw new Error(`Failed to delete qualification Worker ${worker}`);
  }
}

function deleteDatabase(
  repositoryRoot: string,
  database: string,
  exists: boolean,
): void {
  if (!exists) return;
  runCommand(
    "pnpm",
    ["exec", "wrangler", "d1", "delete", database, "--skip-confirmation"],
    { cwd: `${repositoryRoot}/apps/github-gateway` },
  );
}

async function completeLocalTeardown(
  paths: ReturnType<typeof statePaths>,
  checkpoint: NonNullable<Awaited<ReturnType<typeof readCheckpoint>>>,
  plan: ReturnType<typeof destroyPlan>,
  githubAppSlug: string | null,
): Promise<void> {
  await unlink(paths.operatorToken).catch(() => undefined);
  const destroyedAt = new Date().toISOString();
  await writePrivateJson(paths.teardown, {
    ...plan,
    cloudflareDestroyedAt: destroyedAt,
    githubAppSlug,
    githubAppDeleted: false,
  });
  await writePrivateJson(paths.checkpoint, {
    ...checkpoint,
    step: "destroyed",
    updatedAt: destroyedAt,
  });
}

async function recoveryAppSlug(path: string): Promise<string | null> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as {
      app?: { slug?: unknown };
    };
    return typeof value.app?.slug === "string" ? value.app.slug : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function qualificationPurpose(workspace: string): Promise<boolean> {
  const checkpoint = await readCheckpoint(statePaths(workspace).checkpoint);
  return checkpoint?.purpose === "qualification";
}

export async function readTeardownReport(workspace: string): Promise<unknown | null> {
  try { return JSON.parse(await readFile(statePaths(workspace).teardown, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
