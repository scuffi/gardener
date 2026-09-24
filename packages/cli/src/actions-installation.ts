import { readFile, readdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { taskBundleV1Schema } from "@gardener/contracts";
import { canonicalJson, canonicalSha256 } from "@gardener/core";
import { z } from "zod";
import { actionsEnrollmentSql } from "./actions.js";
import { compileGitHubActionsTask } from "./actions-target.js";
import { DEFAULT_WORKFLOW_REF } from "./project.js";
import { runCommand, workerOrigin, wrangler } from "./commands.js";
import { listDatabases, selectedAccountId, workerExists } from "./provision.js";
import { ensurePrivateDirectory, writePrivateJson, writePrivateText } from "./state.js";

const workspaceName = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/);
const repositorySlug = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const TEARDOWN_INTENT_TTL_MS = 24 * 60 * 60_000;

const intentSchema = z.strictObject({
  schemaVersion: z.literal("gardener.actions-deploy-intent/v1"),
  workspace: workspaceName,
  accountId: z.string().min(1),
  resources: z.strictObject({
    database: z.string().min(1),
    runtimeWorker: z.string().min(1),
  }),
  createdAt: z.string().datetime(),
});

const teardownIntentSchema = z.strictObject({
  schemaVersion: z.literal("gardener.actions-teardown-intent/v2"),
  workspace: workspaceName,
  accountId: z.string().min(1),
  manifestHash: sha256,
  resources: z.strictObject({
    database: z.strictObject({ name: z.string().min(1), id: z.string().uuid() }),
    runtimeWorker: z.string().min(1),
    runnerAccessBypassAppId: z.string().nullable(),
  }),
  createdAt: z.string().datetime(),
});

const deploymentRecordSchema = z.strictObject({
  sourceHash: sha256,
  deployedAt: z.string().datetime(),
});

const manifestSchema = z.strictObject({
  schemaVersion: z.literal("gardener.actions-installation/v2"),
  workspace: workspaceName,
  cloudflare: z.strictObject({
    accountId: z.string().min(1),
    database: z.strictObject({ name: z.string().min(1), id: z.string().uuid() }),
    runtimeWorker: z.string().min(1),
    runtimeOrigin: z.string().url(),
    runnerAccessBypassAppId: z.string().nullable(),
    runtimeConfig: z.string().min(1),
  }),
  deployment: deploymentRecordSchema.optional(),
  deploymentHistory: z.array(deploymentRecordSchema).max(20).optional(),
  deploymentHashVersion: z.literal("actions-v2").optional(),
  runtimeGeneration: z.literal("actions-only").optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ActionsInstallationManifest = z.infer<typeof manifestSchema>;

export interface ActionsResourceNames {
  database: string;
  runtimeWorker: string;
}

export function actionsResourceNames(workspace: string): ActionsResourceNames {
  const name = workspaceName.parse(workspace);
  return {
    database: `gardener-${name}`,
    runtimeWorker: `gardener-${name}`,
  };
}

export function actionsInstallationDirectory(workspace: string): string {
  const root = process.env.GARDENER_CONFIG_HOME
    ? resolve(process.env.GARDENER_CONFIG_HOME)
    : join(homedir(), ".config", "gardener");
  return join(root, workspaceName.parse(workspace), "actions");
}

export function renderRuntimeConfig(input: {
  names: ActionsResourceNames;
  databaseId: string;
  sourceRoot: string;
  workspace: string;
  migrationMode?: "fresh" | "steady";
}): string {
  return `${JSON.stringify({
    name: input.names.runtimeWorker,
    main: join(input.sourceRoot, "apps/gardener/dist/gardener_runtime/index.js"),
    compatibility_date: "2026-09-02",
    compatibility_flags: ["nodejs_compat", "experimental", "global_fetch_strictly_public"],
    workers_dev: true,
    d1_databases: [{
      binding: "DB",
      database_name: input.names.database,
      database_id: input.databaseId,
      migrations_dir: join(input.sourceRoot, "apps/gardener/migrations"),
    }],
    ai: { binding: "AI" },
    durable_objects: { bindings: [
      { name: "RUNNER_SESSIONS", class_name: "TaskRunnerSession" },
      { name: "FLUE_GARDENER_TASK_HARNESS_AGENT", class_name: "FlueGardenerTaskHarnessAgent" },
    ] },
    ...(input.migrationMode === "steady" ? {} : {
      migrations: [{
        tag: "actions-task-runtime-v1",
        new_sqlite_classes: ["FlueGardenerTaskHarnessAgent", "TaskRunnerSession"],
      }],
    }),
    observability: {
      enabled: true,
      logs: { enabled: true, invocation_logs: false },
      traces: { enabled: false },
    },
  }, null, 2)}\n`;
}

export async function deployActions(input: {
  workspace: string;
  sourceRoot: string;
  expectedDeploymentHash?: string;
}): Promise<ActionsInstallationManifest> {
  const workspace = workspaceName.parse(input.workspace);
  const sourceRoot = resolve(input.sourceRoot);
  const names = actionsResourceNames(workspace);
  const directory = actionsInstallationDirectory(workspace);
  const manifestPath = join(directory, "installation.json");
  const intentPath = join(directory, "deploy-intent.json");
  await ensurePrivateDirectory(directory);
  const prior = await readActionsManifest(workspace);
  const intent = await readDeployIntent(intentPath);
  const accountId = selectedAccountId(sourceRoot);
  if (prior && prior.cloudflare.accountId !== accountId) {
    throw new Error("Current Wrangler account does not match the existing Actions installation");
  }
  if (intent && (
    intent.accountId !== accountId
    || JSON.stringify(intent.resources) !== JSON.stringify(names)
  )) {
    throw new Error("Existing deployment intent does not match the requested Actions installation");
  }
  let databases = listDatabases(sourceRoot);
  if (!prior && !intent && (
    databases.some((database) => database.name === names.database)
    || workerExists(sourceRoot, names.runtimeWorker)
  )) {
    throw new Error("Cloudflare resources already use this workspace name; choose another workspace or restore its installation manifest");
  }
  if (!prior && !intent) {
    await writePrivateJson(intentPath, intentSchema.parse({
      schemaVersion: "gardener.actions-deploy-intent/v1",
      workspace,
      accountId,
      resources: names,
      createdAt: new Date().toISOString(),
    }));
  }

  if (!databases.some((database) => database.name === names.database)) {
    wrangler(sourceRoot, ".", ["d1", "create", names.database], undefined, { quiet: true });
    databases = listDatabases(sourceRoot);
  }
  const database = databases.find((candidate) => candidate.name === names.database);
  if (!database) throw new Error("Gardener D1 creation could not be verified");
  if (prior && prior.cloudflare.database.id !== database.uuid) {
    throw new Error("Existing installation manifest does not match the Cloudflare D1 database");
  }

  if (!(await isPackagedDistribution(sourceRoot))) {
    runCommand("pnpm", ["--filter", "@gardener/app", "build"], { cwd: sourceRoot, quiet: true });
  }
  const sourceHash = await actionsDeploymentHash(sourceRoot);
  if (input.expectedDeploymentHash && sourceHash !== sha256.parse(input.expectedDeploymentHash)) {
    throw new Error("Trusted rollback source does not match the confirmed historical deployment digest");
  }
  const runtimeConfig = join(directory, "runtime.wrangler.json");
  await writePrivateText(runtimeConfig, renderRuntimeConfig({
    names,
    databaseId: database.uuid,
    sourceRoot,
    workspace,
    migrationMode: prior === null ? "fresh" : "steady",
  }));
  wrangler(sourceRoot, "apps/gardener", [
    "d1", "migrations", "apply", names.database, "--remote", "--config", runtimeConfig,
  ], undefined, { quiet: true });
  const runtimeDeploy = wrangler(sourceRoot, "apps/gardener", [
    "deploy", "--config", runtimeConfig,
  ], undefined, { quiet: true });
  const runtimeOrigin = workerOrigin(runtimeDeploy, names.runtimeWorker);
  const now = new Date().toISOString();
  const deploymentHistory = prior?.deploymentHashVersion !== "actions-v2"
    ? []
    : prior.deployment && prior.deployment.sourceHash !== sourceHash
      ? [prior.deployment, ...(prior.deploymentHistory ?? [])]
        .filter((record, index, records) => record.sourceHash !== sourceHash
          && records.findIndex((candidate) => candidate.sourceHash === record.sourceHash) === index)
        .slice(0, 20)
      : prior.deploymentHistory ?? [];
  let manifest = manifestSchema.parse({
    schemaVersion: "gardener.actions-installation/v2",
    workspace,
    cloudflare: {
      accountId,
      database: { name: names.database, id: database.uuid },
      runtimeWorker: names.runtimeWorker,
      runtimeOrigin,
      runnerAccessBypassAppId: prior?.cloudflare.runnerAccessBypassAppId ?? null,
      runtimeConfig,
    },
    deployment: { sourceHash, deployedAt: now },
    deploymentHistory,
    deploymentHashVersion: "actions-v2",
    runtimeGeneration: "actions-only",
    createdAt: prior?.createdAt ?? now,
    updatedAt: now,
  });
  await writePrivateJson(manifestPath, manifest);
  await unlink(intentPath).catch(() => undefined);

  const accessAppId = await ensurePublicRuntime({
    accountId,
    workspace,
    runtimeOrigin,
    existingAppId: manifest.cloudflare.runnerAccessBypassAppId,
  });
  if (accessAppId !== manifest.cloudflare.runnerAccessBypassAppId) {
    manifest = manifestSchema.parse({
      ...manifest,
      cloudflare: { ...manifest.cloudflare, runnerAccessBypassAppId: accessAppId },
      updatedAt: new Date().toISOString(),
    });
    await writePrivateJson(manifestPath, manifest);
  }
  await requireHealthyRuntime(runtimeOrigin);
  return manifest;
}

export async function upgradeActions(input: {
  workspace: string;
  sourceRoot: string;
}): Promise<{ previousHash: string | null; deploymentHash: string; changed: boolean }> {
  const prior = await requiredActionsManifest(input.workspace);
  const previousHash = prior.deployment?.sourceHash ?? null;
  const manifest = await deployActions(input);
  const deploymentHash = manifest.deployment!.sourceHash;
  return { previousHash, deploymentHash, changed: previousHash !== deploymentHash };
}

export async function rollbackActions(input: {
  workspace: string;
  sourceRoot: string;
  confirm: string;
}): Promise<{ previousHash: string; deploymentHash: string; rolledBack: true }> {
  const prior = await requiredActionsManifest(input.workspace);
  const previousHash = prior.deployment?.sourceHash;
  if (!previousHash) throw new Error("The installation predates deployment history and cannot be rolled back automatically");
  const confirmedHash = sha256.parse(input.confirm);
  if (!(prior.deploymentHistory ?? []).some((record) => record.sourceHash === confirmedHash)) {
    throw new Error("Confirmed rollback digest is not present in this installation's deployment history");
  }
  const manifest = await deployActions({
    workspace: input.workspace,
    sourceRoot: input.sourceRoot,
    expectedDeploymentHash: confirmedHash,
  });
  return { previousHash, deploymentHash: manifest.deployment!.sourceHash, rolledBack: true };
}

export function actionsRepositoryTaskEnrollmentSql(input: {
  repositoryId: string;
  taskId: string;
  bundleHash: string;
  sourcePath: string;
}): string {
  const repositoryId = sql(input.repositoryId);
  const taskId = sql(input.taskId);
  // Connecting never disables the bundle being kept. A bundle disabled only for
  // being stale, such as a reverted task, comes back when another bundle of the
  // task is enabled; after `task disable` every row is 0, so it stays disabled.
  const inherited = (except: string) => `(SELECT MAX(o.enabled) FROM actions_repository_tasks o WHERE o.repository_id=${repositoryId} AND o.task_id=${taskId}${except})`;
  return `INSERT INTO actions_repository_tasks(repository_id,bundle_hash,task_id,source_path,enabled) SELECT ${repositoryId},${sql(input.bundleHash)},${taskId},${sql(input.sourcePath)},COALESCE(${inherited("")},1) WHERE true ON CONFLICT(repository_id,bundle_hash) DO UPDATE SET task_id=excluded.task_id,source_path=excluded.source_path,enabled=MAX(actions_repository_tasks.enabled,COALESCE(${inherited(" AND o.bundle_hash<>excluded.bundle_hash")},0)),updated_at=CURRENT_TIMESTAMP;`;
}

export async function connectActions(input: {
  workspace: string;
  repository: string;
  repositoryRoot: string;
  sourceRoot: string;
}): Promise<{ repositoryId: string; bundles: string[]; runtimeOrigin: string }> {
  const repository = repositorySlug.parse(input.repository);
  const manifest = await requiredActionsManifest(input.workspace);
  const lock = await readProjectLock(input.repositoryRoot);
  const metadata = JSON.parse(runCommand("gh", [
    "api", `repos/${repository}`,
    "--jq", "{repositoryId:(.id|tostring),ownerId:(.owner.id|tostring),ownerLogin:.owner.login,repositoryName:.name,visibility:.visibility}",
  ], { cwd: input.repositoryRoot, quiet: true }).stdout) as {
    repositoryId: string;
    ownerId: string;
    ownerLogin: string;
    repositoryName: string;
    visibility: "public" | "private" | "internal";
  };
  const enrollmentSql = actionsEnrollmentSql({
    ...metadata,
    workflowRef: lock.release.workflowRef,
    audience: manifest.cloudflare.runtimeOrigin,
  });
  const statements = [enrollmentSql];
  const bundles: string[] = [];
  for (const [taskId, task] of Object.entries(lock.tasks).sort(([left], [right]) => left.localeCompare(right))) {
    const bundle = taskBundleV1Schema.parse(task.bundle);
    const deployment = compileGitHubActionsTask(bundle);
    if (canonicalJson(deployment) !== canonicalJson(task.deployment)) {
      throw new Error(`Lock task ${taskId} does not match its github-actions/v1 deployment plan`);
    }
    if (bundle.taskId !== taskId) throw new Error(`Lock task ${taskId} does not match its compiled bundle identity`);
    const canonical = canonicalJson(bundle);
    const hash = sha256.parse(task.bundleHash);
    if (await canonicalSha256(bundle) !== hash) throw new Error(`Lock task ${taskId} does not match its bundle hash`);
    bundles.push(hash);
    const sourcePath = `.gardener/${task.source}`;
    statements.push(
      `INSERT INTO actions_task_bundles(bundle_hash,task_id,bundle_json) VALUES (${sql(hash)},${sql(taskId)},${sql(canonical)}) ON CONFLICT(bundle_hash) DO NOTHING;`,
      actionsRepositoryTaskEnrollmentSql({
        repositoryId: metadata.repositoryId,
        taskId,
        bundleHash: hash,
        sourcePath,
      }),
    );
  }
  statements.push(bundles.length > 0
    ? `UPDATE actions_repository_tasks SET enabled=0,updated_at=CURRENT_TIMESTAMP WHERE repository_id=${sql(metadata.repositoryId)} AND bundle_hash NOT IN (${bundles.map(sql).join(",")});`
    : `UPDATE actions_repository_tasks SET enabled=0,updated_at=CURRENT_TIMESTAMP WHERE repository_id=${sql(metadata.repositoryId)};`);
  wrangler(resolve(input.sourceRoot), "apps/gardener", [
    "d1", "execute", manifest.cloudflare.database.name,
    "--remote", "--config", manifest.cloudflare.runtimeConfig,
    "--command", statements.join("\n"),
  ], undefined, { quiet: true });
  runCommand("gh", [
    "variable", "set", "GARDENER_RUNTIME_URL", "--repo", repository,
    "--body", manifest.cloudflare.runtimeOrigin,
  ], { cwd: input.repositoryRoot, quiet: true });
  return { repositoryId: metadata.repositoryId, bundles, runtimeOrigin: manifest.cloudflare.runtimeOrigin };
}

export async function doctorActions(workspace: string, sourceRoot: string): Promise<{
  ok: true;
  account: true;
  runtime: true;
  database: true;
  access: true;
  schema: true;
  deploymentHash: string | null;
  repositories: number;
  enabledRepositories: number;
  enabledTasks: number;
  staleBridgeRepositories: number;
  pullRequestPermissionWarnings: PullRequestPermissionWarning[];
}> {
  const manifest = await requiredActionsManifest(workspace);
  if (selectedAccountId(resolve(sourceRoot)) !== manifest.cloudflare.accountId) {
    throw new Error("Current Wrangler account does not match the Actions installation");
  }
  const database = listDatabases(resolve(sourceRoot))
    .find((candidate) => candidate.name === manifest.cloudflare.database.name);
  if (!database || database.uuid !== manifest.cloudflare.database.id) {
    throw new Error("Gardener D1 does not match the installation manifest");
  }
  if (!workerExists(resolve(sourceRoot), manifest.cloudflare.runtimeWorker)) {
    throw new Error("Gardener Worker does not match the installation manifest");
  }
  const requiredTables = [
    "actions_control_audit",
    "actions_repository_enrollments",
    "actions_repository_tasks",
    "actions_task_audit",
    "actions_task_bundles",
    "actions_task_runs",
  ];
  const schemaRows = queryDoctorD1(resolve(sourceRoot), manifest,
    `SELECT name FROM sqlite_master WHERE type='table' AND name IN (${requiredTables.map(sql).join(",")}) ORDER BY name;`);
  const presentTables = new Set(schemaRows.map((row) => String(row.name)));
  const missingTables = requiredTables.filter((name) => !presentTables.has(name));
  if (missingTables.length > 0) {
    throw new Error(`Gardener D1 schema is incomplete (${missingTables.join(", ")}); run gardener deploy --workspace ${workspace} to apply migrations`);
  }
  const counts = queryDoctorD1(resolve(sourceRoot), manifest,
    `SELECT (SELECT COUNT(*) FROM actions_repository_enrollments) AS repositories,(SELECT COUNT(*) FROM actions_repository_enrollments WHERE enabled=1) AS enabled_repositories,(SELECT COUNT(*) FROM actions_repository_tasks WHERE enabled=1) AS enabled_tasks,(SELECT COUNT(*) FROM actions_repository_enrollments WHERE enabled=1 AND plan_job_workflow_ref<>${sql(DEFAULT_WORKFLOW_REF)}) AS stale_bridge_repositories;`)[0];
  if (!counts) throw new Error("Gardener D1 did not return operational counts");
  const pullRequestTasks = queryDoctorD1(resolve(sourceRoot), manifest,
    `SELECT e.repository_id AS repository_id, e.owner_login || '/' || e.repository_name AS full_name, group_concat(DISTINCT effect.value) AS kinds FROM actions_repository_enrollments e JOIN actions_repository_tasks t ON t.repository_id=e.repository_id AND t.enabled=1 JOIN actions_task_bundles b ON b.bundle_hash=t.bundle_hash JOIN json_each(CASE WHEN json_valid(b.bundle_json) THEN b.bundle_json ELSE '{}' END, '$.effects') effect WHERE e.enabled=1 AND effect.value IN (${PULL_REQUEST_PERMISSION_KINDS.map(sql).join(",")}) GROUP BY e.repository_id ORDER BY full_name;`);
  const pullRequestPermissionWarnings = pullRequestPermissionWarningsFor(pullRequestTasks.map((row) => ({
    repositoryId: String(row.repository_id),
    repository: String(row.full_name),
    kinds: String(row.kinds ?? "").split(",").filter((kind) => kind !== ""),
  })), (repositoryId) => {
    // allowFailure keeps gh's own error output off the terminal; a failure
    // becomes the tidy "could not confirm" warning instead.
    const result = runCommand("gh", ["api", `repositories/${repositoryId}/actions/permissions/workflow`], {
      cwd: resolve(sourceRoot), quiet: true, allowFailure: true, timeoutMs: 30_000,
    });
    if (result.status !== 0) throw new Error("gh api failed");
    return JSON.parse(result.stdout) as unknown;
  });
  if (manifest.cloudflare.runnerAccessBypassAppId) {
    const record = objectResult(await cloudflareApi(
      manifest.cloudflare.accountId,
      `/access/apps/${encodeURIComponent(manifest.cloudflare.runnerAccessBypassAppId)}`,
    ));
    if (record.domain !== new URL(manifest.cloudflare.runtimeOrigin).hostname
      || record.name !== `Gardener ${workspace} runtime`) {
      throw new Error("Runtime Access bypass does not match the installation manifest");
    }
  }
  const response = await fetch(`${manifest.cloudflare.runtimeOrigin}/health`);
  const health = await response.json().catch(() => null) as { ok?: unknown } | null;
  if (!response.ok || health?.ok !== true) {
    throw new Error("Gardener runtime is unhealthy");
  }
  return {
    ok: true,
    account: true,
    runtime: true,
    database: true,
    access: true,
    schema: true,
    deploymentHash: manifest.deployment?.sourceHash ?? null,
    repositories: Number(counts.repositories),
    enabledRepositories: Number(counts.enabled_repositories),
    enabledTasks: Number(counts.enabled_tasks),
    staleBridgeRepositories: Number(counts.stale_bridge_repositories),
    pullRequestPermissionWarnings,
  };
}

/**
 * Effects GitHub refuses to a workflow's token unless the repository allows
 * Actions to create and approve pull requests. A review only needs it to
 * approve, but the task may approve, so it is checked too.
 */
const PULL_REQUEST_PERMISSION_KINDS = ["pull_request.open_draft", "pull_request.review.submit"] as const;

export interface PullRequestPermissionWarning {
  repository: string;
  kinds: string[];
  message: string;
}

/**
 * Warns about each repository whose enabled tasks need the "Allow GitHub
 * Actions to create and approve pull requests" setting while it is off or
 * cannot be read. New repositories have it off, and without it apply stops at
 * the pull request step.
 */
export function pullRequestPermissionWarningsFor(
  repositories: ReadonlyArray<{ repositoryId: string; repository: string; kinds: readonly string[] }>,
  readWorkflowPermissions: (repositoryId: string) => unknown,
): PullRequestPermissionWarning[] {
  const warnings: PullRequestPermissionWarning[] = [];
  for (const { repositoryId, repository, kinds } of repositories) {
    const needs = kinds.includes("pull_request.open_draft") ? "open pull requests" : "approve pull requests";
    let allowed: boolean | null;
    try {
      const value = readWorkflowPermissions(repositoryId) as { can_approve_pull_request_reviews?: unknown } | null;
      allowed = typeof value?.can_approve_pull_request_reviews === "boolean" ? value.can_approve_pull_request_reviews : null;
    } catch {
      allowed = null;
    }
    if (allowed === true) continue;
    const setting = "Allow GitHub Actions to create and approve pull requests (Settings → Actions → General)";
    warnings.push({
      repository,
      kinds: [...kinds],
      message: allowed === false
        ? `${repository} has tasks that ${needs}, but "${setting}" is off. Turn it on, or apply will stop at that step.`
        : `${repository} has tasks that ${needs}; could not confirm "${setting}" is on.`,
    });
  }
  return warnings;
}

export async function destroyActions(input: {
  workspace: string;
  sourceRoot: string;
  execute: boolean;
  confirm?: string;
}): Promise<{
  destroyed: boolean;
  intentDigest: string;
  resources: { database: string; runtimeWorker: string };
}> {
  const manifest = await requiredActionsManifest(input.workspace);
  const sourceRoot = resolve(input.sourceRoot);
  const resources = {
    database: manifest.cloudflare.database.name,
    runtimeWorker: manifest.cloudflare.runtimeWorker,
  };
  const directory = actionsInstallationDirectory(input.workspace);
  const intentPath = join(directory, "teardown-intent.json");
  const manifestHash = await canonicalSha256(manifest);
  const teardownResources = {
    database: manifest.cloudflare.database,
    runtimeWorker: manifest.cloudflare.runtimeWorker,
    runnerAccessBypassAppId: manifest.cloudflare.runnerAccessBypassAppId,
  };
  let intent = await readTeardownIntent(intentPath);

  if (!input.execute) {
    if (!intent || intent.manifestHash !== manifestHash || teardownIntentExpired(intent.createdAt)) {
      intent = teardownIntentSchema.parse({
        schemaVersion: "gardener.actions-teardown-intent/v2",
        workspace: input.workspace,
        accountId: manifest.cloudflare.accountId,
        manifestHash,
        resources: teardownResources,
        createdAt: new Date().toISOString(),
      });
      await writePrivateJson(intentPath, intent);
    }
    return { destroyed: false, intentDigest: await canonicalSha256(intent), resources };
  }

  if (!intent) throw new Error("No teardown intent exists; run gardener down without --execute first");
  if (teardownIntentExpired(intent.createdAt)) {
    throw new Error("Teardown intent expired; run gardener down without --execute to create a new intent");
  }
  const intentDigest = await canonicalSha256(intent);
  if (input.confirm !== intentDigest) {
    throw new Error(`Destructive teardown requires --confirm ${intentDigest}`);
  }
  if (intent.workspace !== input.workspace || intent.accountId !== manifest.cloudflare.accountId
    || intent.manifestHash !== manifestHash
    || canonicalJson(intent.resources) !== canonicalJson(teardownResources)) {
    throw new Error("Teardown intent no longer matches the installation manifest");
  }
  if (selectedAccountId(sourceRoot) !== manifest.cloudflare.accountId) {
    throw new Error("Current Wrangler account does not match the Actions installation");
  }
  const database = listDatabases(sourceRoot)
    .find((candidate) => candidate.name === manifest.cloudflare.database.name);
  if (database && database.uuid !== manifest.cloudflare.database.id) {
    throw new Error("Refusing teardown because the D1 identity does not match the installation manifest");
  }
  if (manifest.cloudflare.runnerAccessBypassAppId) {
    await cloudflareApi(
      manifest.cloudflare.accountId,
      `/access/apps/${encodeURIComponent(manifest.cloudflare.runnerAccessBypassAppId)}`,
      { method: "DELETE" },
      true,
    );
  }
  deleteWorker(sourceRoot, manifest.cloudflare.runtimeWorker);
  if (database) {
    wrangler(sourceRoot, "apps/gardener", [
      "d1", "delete", manifest.cloudflare.database.name, "--skip-confirmation",
    ], undefined, { quiet: true });
  }
  await writePrivateJson(join(directory, "teardown.json"), {
    schemaVersion: "gardener.actions-teardown/v1",
    workspace: input.workspace,
    intentDigest,
    destroyedAt: new Date().toISOString(),
    cloudflare: manifest.cloudflare,
  });
  await unlink(join(directory, "installation.json")).catch(() => undefined);
  await unlink(intentPath).catch(() => undefined);
  await unlink(join(directory, "deploy-intent.json")).catch(() => undefined);
  return { destroyed: true, intentDigest, resources };
}

export async function actionsDeploymentHash(sourceRootInput: string): Promise<string> {
  const sourceRoot = resolve(sourceRootInput);
  const migrationRoot = join(sourceRoot, "apps/gardener/migrations");
  const migrationNames = (await readdir(migrationRoot)).filter((name) => name.endsWith(".sql")).sort();
  return canonicalSha256({
    runtimeBundle: await readFile(join(sourceRoot, "apps/gardener/dist/gardener_runtime/index.js"), "utf8"),
    migrations: await Promise.all(migrationNames.map(async (name) => ({
      name,
      sql: await readFile(join(migrationRoot, name), "utf8"),
    }))),
  });
}

export async function readActionsManifest(workspace: string): Promise<ActionsInstallationManifest | null> {
  try {
    return manifestSchema.parse(JSON.parse(await readFile(
      join(actionsInstallationDirectory(workspace), "installation.json"),
      "utf8",
    )));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

async function readDeployIntent(path: string): Promise<z.infer<typeof intentSchema> | null> {
  try {
    return intentSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

function teardownIntentExpired(createdAt: string, now = Date.now()): boolean {
  return now - Date.parse(createdAt) > TEARDOWN_INTENT_TTL_MS;
}

async function readTeardownIntent(path: string): Promise<z.infer<typeof teardownIntentSchema> | null> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as { schemaVersion?: unknown };
    return value.schemaVersion === "gardener.actions-teardown-intent/v2"
      ? teardownIntentSchema.parse(value)
      : null;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

async function requiredActionsManifest(workspace: string): Promise<ActionsInstallationManifest> {
  const manifest = await readActionsManifest(workspace);
  if (!manifest) throw new Error(`No Actions installation exists for workspace ${workspace}`);
  return manifest;
}

const lockSchema = z.strictObject({
  schemaVersion: z.literal("gardener.lock/v1"),
  target: z.strictObject({
    id: z.literal("github-actions/v1"),
    adapterVersion: z.literal("1"),
    workflowRef: z.string().min(1),
  }),
  release: z.strictObject({ workflowRef: z.string().min(1) }),
  tasks: z.record(z.string(), z.strictObject({
    source: z.string(),
    bundleHash: sha256,
    workflow: z.string(),
    bundle: z.record(z.string(), z.unknown()),
    deployment: z.record(z.string(), z.unknown()),
  })),
});

export async function readProjectLock(repositoryRoot: string) {
  return lockSchema.parse(JSON.parse(await readFile(
    join(resolve(repositoryRoot), ".gardener", "gardener.lock.json"),
    "utf8",
  )));
}

export async function ensurePublicRuntime(input: {
  accountId: string;
  workspace: string;
  runtimeOrigin: string;
  existingAppId: string | null;
}, stabilizationMs = 5_000): Promise<string | null> {
  // A newly assigned workers.dev hostname can briefly answer before account-wide
  // Access policy propagation. Wait before deciding that no bypass is required.
  if (stabilizationMs > 0) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, stabilizationMs));
  }
  let accessIntercepted = false;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await fetch(`${input.runtimeOrigin}/health`, { redirect: "manual" });
    if (isAccessRedirect(response)) {
      accessIntercepted = true;
      break;
    }
    const body = await response.json().catch(() => null) as { ok?: unknown } | null;
    if (response.ok && body?.ok === true) return input.existingAppId;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  }
  if (!accessIntercepted) return input.existingAppId;
  const expectedName = `Gardener ${input.workspace} runtime`;
  const domain = new URL(input.runtimeOrigin).hostname;

  if (input.existingAppId) {
    const existing = await cloudflareApi(input.accountId, `/access/apps/${encodeURIComponent(input.existingAppId)}`);
    const record = objectResult(existing);
    if (record.domain !== domain || record.name !== expectedName) {
      throw new Error("Recorded runtime Access bypass does not match the deployed Worker");
    }
    return input.existingAppId;
  }

  const listed = await cloudflareApi(input.accountId, "/access/apps?per_page=100");
  const exact = arrayResult(listed).filter((item) => item.domain === domain);
  if (exact.length > 0) {
    const owned = exact.find((item) => item.name === expectedName && typeof item.id === "string");
    if (!owned) throw new Error("An unmanaged Cloudflare Access application already owns the runtime hostname");
    return owned.id as string;
  }

  const created = await cloudflareApi(input.accountId, "/access/apps", {
    method: "POST",
    body: JSON.stringify({
      name: expectedName,
      domain,
      type: "self_hosted",
      session_duration: "24h",
      policies: [{
        name: "Allow GitHub OIDC bridge sessions",
        decision: "bypass",
        precedence: 1,
        include: [{ everyone: {} }],
      }],
    }),
  });
  const result = objectResult(created);
  if (typeof result.id !== "string") throw new Error("Cloudflare did not return an Access application ID");
  return result.id;
}

async function requireHealthyRuntime(runtimeOrigin: string): Promise<void> {
  for (let attempt = 0; attempt < 15; attempt += 1) {
    const response = await fetch(`${runtimeOrigin}/health`, { redirect: "manual" });
    if (!isAccessRedirect(response)) {
      const body = await response.json().catch(() => null) as { ok?: unknown } | null;
      if (response.ok && body?.ok === true) return;
      throw new Error("Gardener runtime health check failed");
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  }
  throw new Error("Cloudflare Access runtime bypass did not become active");
}

function isAccessRedirect(response: Response): boolean {
  if (response.status < 300 || response.status >= 400) return false;
  const location = response.headers.get("location");
  if (!location) return false;
  try { return new URL(location).hostname.endsWith(".cloudflareaccess.com"); }
  catch { return false; }
}

async function cloudflareApi(
  accountId: string,
  path: string,
  init: RequestInit = {},
  allowNotFound = false,
): Promise<unknown> {
  const token = process.env.CLOUDFLARE_API_TOKEN ?? process.env.CF_API_TOKEN;
  if (!token) {
    throw new Error(
      "Cloudflare Access protects the runtime hostname. Set a scoped CLOUDFLARE_API_TOKEN with Access Apps and Policies edit permission, then rerun deploy.",
    );
  }
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (allowNotFound && response.status === 404) return null;
  const body = await response.json().catch(() => null) as {
    success?: unknown;
    errors?: Array<{ message?: unknown }>;
    result?: unknown;
  } | null;
  if (!response.ok || body?.success !== true) {
    const message = body?.errors?.map((error) => String(error.message ?? "unknown error")).join("; ");
    throw new Error(`Cloudflare Access API request failed: ${message || response.status}`);
  }
  return body.result;
}

function objectResult(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Cloudflare Access API returned an invalid object");
  }
  return value as Record<string, unknown>;
}

function arrayResult(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) throw new Error("Cloudflare Access API returned an invalid list");
  return value.filter((item): item is Record<string, unknown> =>
    Boolean(item) && typeof item === "object" && !Array.isArray(item)
  );
}

async function isPackagedDistribution(sourceRoot: string): Promise<boolean> {
  try {
    const value = JSON.parse(await readFile(join(sourceRoot, "gardener-distribution.json"), "utf8")) as {
      schemaVersion?: unknown;
    };
    return value.schemaVersion === "gardener.cli-distribution/v1";
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

function queryDoctorD1(
  sourceRoot: string,
  manifest: ActionsInstallationManifest,
  command: string,
): Array<Record<string, unknown>> {
  const result = wrangler(sourceRoot, "apps/gardener", [
    "d1", "execute", manifest.cloudflare.database.name,
    "--remote", "--json", "--command", command,
  ], undefined, { quiet: true });
  const value = JSON.parse(result.stdout) as unknown;
  if (!Array.isArray(value)) throw new Error("Wrangler returned invalid D1 doctor output");
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const rows = (entry as { results?: unknown }).results;
    return Array.isArray(rows)
      ? rows.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object")
      : [];
  });
}

function deleteWorker(sourceRoot: string, worker: string): void {
  const result = wrangler(sourceRoot, ".", [
    "delete", worker, "--force",
  ], undefined, { quiet: true, allowFailure: true });
  if (result.status !== 0 && !/not found|does not exist|10090/i.test(`${result.stdout}\n${result.stderr}`)) {
    throw new Error(`Failed to delete Gardener Worker ${worker}`);
  }
}

function sql(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
