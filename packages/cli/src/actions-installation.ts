import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { taskBundleV1Schema } from "@gardener/contracts";
import { canonicalJson, canonicalSha256 } from "@gardener/core";
import { z } from "zod";
import { actionsEnrollmentSql } from "./actions.js";
import { executeD1, isolatedWranglerDirectory, queryD1, queryD1IfTableExists, sql } from "./actions-d1.js";
import { compileGitHubActionsTask } from "./actions-target.js";
import { DEFAULT_WORKFLOW_REF } from "./project.js";
import { runCommand, workerOrigin, wrangler } from "./commands.js";
import { listDatabases, selectedAccountId, workerExists } from "./provision.js";

const workspaceName = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/);
const repositorySlug = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);

/**
 * An installation, derived from the Cloudflare account rather than stored on
 * the operator's machine: its resources are named `gardener-<workspace>`, and
 * the facts only a deploy knows live in the workspace's own D1.
 */
export interface ActionsInstallation {
  workspace: string;
  cloudflare: {
    accountId: string;
    database: { name: string; id: string };
    runtimeWorker: string;
    runtimeOrigin: string;
  };
  cliVersion: string | null;
  deploymentHash: string | null;
  deployedAt: string | null;
}

interface InstallationFacts {
  runtime_origin?: string;
  cli_version?: string;
  deployment_hash?: string;
  deployed_at?: string;
}

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
    // The release this Worker belongs to: a sync from its workflow is accepted
    // even before a repository's enrollment has moved to it.
    vars: { GARDENER_RELEASE_WORKFLOW_REF: DEFAULT_WORKFLOW_REF },
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

/** Reads the installation from Cloudflare. Throws if the workspace does not exist. */
export async function resolveInstallation(workspace: string): Promise<ActionsInstallation> {
  const names = actionsResourceNames(workspace);
  const cloudflareCwd = isolatedWranglerDirectory();
  const accountId = selectedAccountId(cloudflareCwd);
  const database = listDatabases(cloudflareCwd).find((candidate) => candidate.name === names.database);
  if (!database) {
    throw new Error(`No Gardener installation named ${workspace} exists on Cloudflare account ${accountId}; run gardener deploy --workspace ${workspace}`);
  }
  const facts = readInstallationFacts(names.database);
  if (!facts?.runtime_origin) {
    throw new Error(`Gardener ${workspace} was deployed by an older CLI, or its last deploy was interrupted; run gardener upgrade or gardener deploy --workspace ${workspace} with this one`);
  }
  return installation(workspace, accountId, names, database.uuid, facts.runtime_origin, facts);
}

function installation(
  workspace: string,
  accountId: string,
  names: ActionsResourceNames,
  databaseId: string,
  runtimeOrigin: string,
  facts: InstallationFacts,
): ActionsInstallation {
  return {
    workspace,
    cloudflare: {
      accountId,
      database: { name: names.database, id: databaseId },
      runtimeWorker: names.runtimeWorker,
      runtimeOrigin,
    },
    cliVersion: facts.cli_version ?? null,
    deploymentHash: facts.deployment_hash ?? null,
    deployedAt: facts.deployed_at ?? null,
  };
}

/**
 * Refuses to migrate a database of this name unless it is empty or already a
 * Gardener database, so a workspace-name collision cannot write into another
 * application's data.
 */
function assertAdoptableDatabase(workspace: string, database: string): void {
  const tables = queryD1(database, "SELECT name FROM sqlite_master WHERE type='table';")
    .map((row) => row.name)
    .filter((name): name is string => typeof name === "string"
      && !name.startsWith("_cf_") && !name.startsWith("sqlite_") && name !== "d1_migrations");
  if (tables.length > 0 && !tables.includes("actions_repository_enrollments")) {
    throw new Error(`D1 database ${database} exists but is not a Gardener installation; choose another --workspace than ${workspace}`);
  }
}

/** Null when the database predates the facts table. */
function readInstallationFacts(database: string): InstallationFacts | null {
  const rows = queryD1IfTableExists(database, "SELECT key, value FROM actions_installation;");
  if (rows === null) return null;
  const facts: InstallationFacts = {};
  for (const row of rows) {
    if (typeof row.key === "string" && typeof row.value === "string") {
      (facts as Record<string, string>)[row.key] = row.value;
    }
  }
  return facts;
}

/** This CLI's own version, from the package.json beside `dist/` or `src/`. */
export async function cliVersion(): Promise<string> {
  const value = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown };
  if (typeof value.version !== "string") throw new Error("Gardener CLI package.json has no version");
  return value.version;
}

/** Compares `x.y.z` versions numerically, ignoring any prerelease suffix. */
export function compareVersions(left: string, right: string): number {
  const parts = (version: string) => version.split("-")[0]!.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const [a, b] = [parts(left), parts(right)];
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

/**
 * Creates or updates the runtime for a workspace. Existing `gardener-<workspace>`
 * resources on the account are adopted, so any operator with account access can
 * run it. It refuses to replace a runtime deployed by a newer CLI.
 */
export async function deployActions(input: {
  workspace: string;
  sourceRoot: string;
}): Promise<ActionsInstallation> {
  const workspace = workspaceName.parse(input.workspace);
  const sourceRoot = resolve(input.sourceRoot);
  const names = actionsResourceNames(workspace);
  const cloudflareCwd = isolatedWranglerDirectory();
  const accountId = selectedAccountId(cloudflareCwd);
  const version = await cliVersion();

  let database = listDatabases(cloudflareCwd).find((candidate) => candidate.name === names.database);
  const workerPresent = workerExists(cloudflareCwd, names.runtimeWorker);
  if (database) {
    const facts = readInstallationFacts(names.database);
    if (!facts) assertAdoptableDatabase(workspace, names.database);
    const deployed = facts?.cli_version;
    if (deployed && compareVersions(version, deployed) < 0) {
      throw new Error(`Gardener ${workspace} runs ${deployed}, newer than this CLI (${version}); use @scuffi/gardener@${deployed} or later`);
    }
  } else {
    // Gardener creates the database before the Worker and deletes neither, so
    // a lone Worker of this name belongs to something else.
    if (workerPresent) {
      throw new Error(`A Worker named ${names.runtimeWorker} exists without a ${names.database} database; choose another --workspace`);
    }
    wrangler(cloudflareCwd, ".", ["d1", "create", names.database], undefined, { quiet: true });
    database = listDatabases(cloudflareCwd).find((candidate) => candidate.name === names.database);
    if (!database) throw new Error("Gardener D1 creation could not be verified");
  }

  if (!(await isPackagedDistribution(sourceRoot))) {
    runCommand("pnpm", ["--filter", "@gardener/app", "build"], { cwd: sourceRoot, quiet: true });
  }
  const deploymentHash = await actionsDeploymentHash(sourceRoot);
  const configDirectory = await mkdtemp(join(tmpdir(), "gardener-runtime-"));
  let runtimeOrigin: string;
  try {
    const runtimeConfig = join(configDirectory, "wrangler.json");
    await writeFile(runtimeConfig, renderRuntimeConfig({
      names,
      databaseId: database.uuid,
      sourceRoot,
      workspace,
      migrationMode: workerPresent ? "steady" : "fresh",
    }), { mode: 0o600 });
    wrangler(sourceRoot, "apps/gardener", [
      "d1", "migrations", "apply", names.database, "--remote", "--config", runtimeConfig,
    ], undefined, { quiet: true });
    const runtimeDeploy = wrangler(sourceRoot, "apps/gardener", [
      "deploy", "--config", runtimeConfig,
    ], undefined, { quiet: true });
    runtimeOrigin = workerOrigin(runtimeDeploy, names.runtimeWorker);
  } finally {
    await rm(configDirectory, { recursive: true, force: true });
  }

  await ensurePublicRuntime({ accountId, workspace, runtimeOrigin, existingAppId: null });
  await requireHealthyRuntime(runtimeOrigin);

  // Recorded last, so a deploy only counts once its runtime is healthy.
  const facts: Required<InstallationFacts> = {
    runtime_origin: runtimeOrigin,
    cli_version: version,
    deployment_hash: deploymentHash,
    deployed_at: new Date().toISOString(),
  };
  executeD1(names.database, `INSERT INTO actions_installation(key,value) VALUES ${
    Object.entries(facts).map(([key, value]) => `(${sql(key)},${sql(value)})`).join(",")
  } ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP;`);
  return installation(workspace, accountId, names, database.uuid, runtimeOrigin, facts);
}

export async function upgradeActions(input: {
  workspace: string;
  sourceRoot: string;
}): Promise<{ previousHash: string | null; deploymentHash: string; changed: boolean }> {
  const names = actionsResourceNames(input.workspace);
  if (!listDatabases(isolatedWranglerDirectory()).some((candidate) => candidate.name === names.database)) {
    throw new Error(`No Gardener installation named ${input.workspace} exists; run gardener deploy --workspace ${input.workspace}`);
  }
  const previousHash = readInstallationFacts(names.database)?.deployment_hash ?? null;
  const deployed = await deployActions(input);
  const deploymentHash = deployed.deploymentHash!;
  return { previousHash, deploymentHash, changed: previousHash !== deploymentHash };
}

export function actionsRepositoryTaskEnrollmentSql(input: {
  repositoryId: string;
  taskId: string;
  bundleHash: string;
  sourcePath: string;
}): string {
  // The checkout's bundles are the live ones, as a sync from the default
  // branch would make them; connectActions then disables every other bundle.
  return `INSERT INTO actions_repository_tasks(repository_id,bundle_hash,task_id,source_path,enabled) VALUES (${sql(input.repositoryId)},${sql(input.bundleHash)},${sql(input.taskId)},${sql(input.sourcePath)},1) ON CONFLICT(repository_id,bundle_hash) DO UPDATE SET task_id=excluded.task_id,source_path=excluded.source_path,enabled=1,updated_at=CURRENT_TIMESTAMP;`;
}

export async function connectActions(input: {
  workspace: string;
  repository: string;
  repositoryRoot: string;
  sourceRoot: string;
}): Promise<{ repositoryId: string; bundles: string[]; runtimeOrigin: string }> {
  const repository = repositorySlug.parse(input.repository);
  const installation = await resolveInstallation(input.workspace);
  const runtimeOrigin = installation.cloudflare.runtimeOrigin;
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
  // The lock comes from the repository. Pinning another repository's
  // workflows would make them the ones the runtime trusts, syncs included.
  const releaseRepository = (ref: string) => ref.split("/.github/workflows/")[0];
  if (releaseRepository(lock.release.workflowRef) !== releaseRepository(DEFAULT_WORKFLOW_REF)) {
    throw new Error(`The lock pins ${lock.release.workflowRef}, which is not a ${releaseRepository(DEFAULT_WORKFLOW_REF)} release; run gardener upgrade`);
  }
  const enrollmentSql = actionsEnrollmentSql({
    ...metadata,
    workflowRef: lock.release.workflowRef,
    audience: runtimeOrigin,
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
  executeD1(installation.cloudflare.database.name, statements.join("\n"));
  // Setting a variable needs repository admin, so leave a correct one alone.
  const current = runCommand("gh", ["variable", "get", "GARDENER_RUNTIME_URL", "--repo", repository], {
    cwd: input.repositoryRoot, quiet: true, allowFailure: true,
  });
  if (current.status !== 0 || current.stdout.trim() !== runtimeOrigin) {
    runCommand("gh", [
      "variable", "set", "GARDENER_RUNTIME_URL", "--repo", repository, "--body", runtimeOrigin,
    ], { cwd: input.repositoryRoot, quiet: true });
  }
  return { repositoryId: metadata.repositoryId, bundles, runtimeOrigin };
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
  const installation = await resolveInstallation(workspace);
  const database = installation.cloudflare.database.name;
  if (!workerExists(isolatedWranglerDirectory(), installation.cloudflare.runtimeWorker)) {
    throw new Error(`Gardener Worker ${installation.cloudflare.runtimeWorker} does not exist; run gardener deploy --workspace ${workspace}`);
  }
  const requiredTables = [
    "actions_control_audit",
    "actions_installation",
    "actions_repository_enrollments",
    "actions_repository_syncs",
    "actions_repository_tasks",
    "actions_task_audit",
    "actions_task_bundles",
    "actions_task_runs",
  ];
  const schemaRows = queryD1(database,
    `SELECT name FROM sqlite_master WHERE type='table' AND name IN (${requiredTables.map(sql).join(",")}) ORDER BY name;`);
  const presentTables = new Set(schemaRows.map((row) => String(row.name)));
  const missingTables = requiredTables.filter((name) => !presentTables.has(name));
  if (missingTables.length > 0) {
    throw new Error(`Gardener D1 schema is incomplete (${missingTables.join(", ")}); run gardener deploy --workspace ${workspace} to apply migrations`);
  }
  const counts = queryD1(database,
    `SELECT (SELECT COUNT(*) FROM actions_repository_enrollments) AS repositories,(SELECT COUNT(*) FROM actions_repository_enrollments WHERE enabled=1) AS enabled_repositories,(SELECT COUNT(*) FROM actions_repository_tasks WHERE enabled=1) AS enabled_tasks,(SELECT COUNT(*) FROM actions_repository_enrollments WHERE enabled=1 AND plan_job_workflow_ref<>${sql(DEFAULT_WORKFLOW_REF)}) AS stale_bridge_repositories;`)[0];
  if (!counts) throw new Error("Gardener D1 did not return operational counts");
  const pullRequestTasks = queryD1(database,
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
  const response = await fetch(`${installation.cloudflare.runtimeOrigin}/health`);
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
    deploymentHash: installation.deploymentHash,
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
const PULL_REQUEST_PERMISSION_KINDS = ["pull_request.open", "pull_request.open_draft", "pull_request.review.submit"] as const;

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
    const needs = kinds.includes("pull_request.open") || kinds.includes("pull_request.open_draft")
      ? "open pull requests"
      : "approve pull requests";
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
