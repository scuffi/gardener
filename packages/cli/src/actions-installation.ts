import { readFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { taskBundleV1Schema } from "@gardener/contracts";
import { canonicalJson, canonicalSha256 } from "@gardener/core";
import { z } from "zod";
import { actionsEnrollmentSql } from "./actions.js";
import { runCommand, workerOrigin, wrangler } from "./commands.js";
import { listDatabases, selectedAccountId, workerExists } from "./provision.js";
import { ensurePrivateDirectory, writePrivateJson, writePrivateText } from "./state.js";

const workspaceName = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/);
const repositorySlug = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);

const intentSchema = z.strictObject({
  schemaVersion: z.literal("gardener.actions-deploy-intent/v1"),
  workspace: workspaceName,
  accountId: z.string().min(1),
  resources: z.strictObject({
    database: z.string().min(1),
    runtimeWorker: z.string().min(1),
    ingressWorker: z.string().min(1),
  }),
  createdAt: z.string().datetime(),
});

const manifestSchema = z.strictObject({
  schemaVersion: z.literal("gardener.actions-installation/v1"),
  workspace: workspaceName,
  cloudflare: z.strictObject({
    accountId: z.string().min(1),
    database: z.strictObject({ name: z.string().min(1), id: z.string().uuid() }),
    runtimeWorker: z.string().min(1),
    ingressWorker: z.string().min(1),
    ingressOrigin: z.string().url(),
    runnerAccessBypassAppId: z.string().nullable(),
    runtimeConfig: z.string().min(1),
    ingressConfig: z.string().min(1),
  }),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ActionsInstallationManifest = z.infer<typeof manifestSchema>;

export interface ActionsResourceNames {
  database: string;
  runtimeWorker: string;
  ingressWorker: string;
}

export function actionsResourceNames(workspace: string): ActionsResourceNames {
  const name = workspaceName.parse(workspace);
  return {
    database: `gardener-${name}`,
    runtimeWorker: `gardener-${name}-runtime`,
    ingressWorker: `gardener-${name}-runner-ingress`,
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
}): string {
  return `${JSON.stringify({
    name: input.names.runtimeWorker,
    main: join(input.sourceRoot, "apps/gardener/dist/gardener_actions_v1_runtime/index.js"),
    compatibility_date: "2026-09-02",
    compatibility_flags: ["nodejs_compat", "experimental", "global_fetch_strictly_public"],
    workers_dev: false,
    d1_databases: [{
      binding: "DB",
      database_name: input.names.database,
      database_id: input.databaseId,
      migrations_dir: join(input.sourceRoot, "apps/gardener/migrations"),
    }],
    ai: { binding: "AI" },
    durable_objects: { bindings: [
      { name: "COMPUTER_WORKSPACES", class_name: "ComputerWorkspace" },
      { name: "RUNNER_SESSIONS", class_name: "TaskRunnerSession" },
      { name: "FLUE_GARDENER_HARNESS_AGENT", class_name: "FlueGardenerHarnessAgent" },
      { name: "FLUE_GARDENER_TASK_HARNESS_AGENT", class_name: "FlueGardenerTaskHarnessAgent" },
    ] }, 
    migrations: [
      {
        tag: "agent-native-foundation-v1",
        new_sqlite_classes: ["ComputerWorkspace", "GardenerThinkHarnessAgent", "GardenerCloudflareAgentsHarness", "FlueGardenerHarnessAgent"],
      },
      {
        tag: "flue-only-runtime-v1",
        deleted_classes: ["GardenerThinkHarnessAgent", "GardenerCloudflareAgentsHarness"],
      },
      {
        tag: "actions-task-runtime-v1",
        new_sqlite_classes: ["FlueGardenerTaskHarnessAgent", "TaskRunnerSession"],
      },
    ],
    triggers: { crons: ["* * * * *"] },
    vars: {
      AI_MODEL: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      GARDENER_WORKSPACE_ID: input.workspace,
      GARDENER_DEPLOYMENT_MODE: "actions-v1",
      LOCAL_DEV_BYPASS: "false",
    },
    observability: {
      enabled: true,
      logs: { enabled: true, invocation_logs: false },
      traces: { enabled: false },
    },
  }, null, 2)}\n`;
}

export function renderIngressConfig(input: {
  names: ActionsResourceNames;
  sourceRoot: string;
}): string {
  return `${JSON.stringify({
    name: input.names.ingressWorker,
    main: join(input.sourceRoot, "apps/runner-ingress/src/index.ts"),
    compatibility_date: "2026-09-02",
    compatibility_flags: ["nodejs_compat", "global_fetch_strictly_public"],
    workers_dev: true,
    services: [{
      binding: "GARDENER",
      service: input.names.runtimeWorker,
      entrypoint: "GardenerRunnerIngressEntrypoint",
    }],
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
    || workerExists(sourceRoot, names.ingressWorker)
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

  runCommand("pnpm", ["--filter", "@gardener/app", "build"], { cwd: sourceRoot, quiet: true });
  const runtimeConfig = join(directory, "runtime.wrangler.json");
  const ingressConfig = join(directory, "ingress.wrangler.json");
  await writePrivateText(runtimeConfig, renderRuntimeConfig({
    names,
    databaseId: database.uuid,
    sourceRoot,
    workspace,
  }));
  await writePrivateText(ingressConfig, renderIngressConfig({ names, sourceRoot }));

  wrangler(sourceRoot, "apps/gardener", [
    "d1", "migrations", "apply", names.database, "--remote", "--config", runtimeConfig,
  ], undefined, { quiet: true });
  if (!workerExists(sourceRoot, names.runtimeWorker)) {
    // Cloudflare cannot disable workers.dev on a Worker that has never existed.
    // Create it with a data-less 404 handler, then immediately replace it with
    // the private runtime and disable its public hostname.
    const bootstrapSource = join(directory, "runtime-bootstrap.mjs");
    const bootstrapConfig = join(directory, "runtime-bootstrap.wrangler.json");
    await writePrivateText(
      bootstrapSource,
      "export default { fetch() { return new Response('Not found', { status: 404 }); } };\n",
    );
    await writePrivateText(bootstrapConfig, `${JSON.stringify({
      name: names.runtimeWorker,
      main: bootstrapSource,
      compatibility_date: "2026-09-02",
      workers_dev: true,
    }, null, 2)}\n`);
    wrangler(sourceRoot, ".", ["deploy", "--config", bootstrapConfig], undefined, { quiet: true });
  }
  wrangler(sourceRoot, "apps/gardener", ["deploy", "--config", runtimeConfig], undefined, { quiet: true });
  const ingressDeploy = wrangler(sourceRoot, "apps/runner-ingress", [
    "deploy", "--config", ingressConfig,
  ], undefined, { quiet: true });
  const ingressOrigin = workerOrigin(ingressDeploy, names.ingressWorker);
  const now = new Date().toISOString();
  let manifest = manifestSchema.parse({
    schemaVersion: "gardener.actions-installation/v1",
    workspace,
    cloudflare: {
      accountId,
      database: { name: names.database, id: database.uuid },
      runtimeWorker: names.runtimeWorker,
      ingressWorker: names.ingressWorker,
      ingressOrigin,
      runnerAccessBypassAppId: prior?.cloudflare.runnerAccessBypassAppId ?? null,
      runtimeConfig,
      ingressConfig,
    },
    createdAt: prior?.createdAt ?? now,
    updatedAt: now,
  });
  await writePrivateJson(manifestPath, manifest);
  await unlink(intentPath).catch(() => undefined);

  const accessAppId = await ensurePublicRunnerIngress({
    accountId,
    workspace,
    ingressOrigin,
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
  await requireHealthyIngress(ingressOrigin);
  return manifest;
}

export async function connectActions(input: {
  workspace: string;
  repository: string;
  repositoryRoot: string;
  sourceRoot: string;
}): Promise<{ repositoryId: string; bundles: string[]; ingressOrigin: string }> {
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
    audience: manifest.cloudflare.ingressOrigin,
  });
  const statements = [
    enrollmentSql,
    `UPDATE actions_repository_tasks SET enabled=0,updated_at=CURRENT_TIMESTAMP WHERE repository_id=${sql(metadata.repositoryId)};`,
  ];
  const bundles: string[] = [];
  for (const [taskId, task] of Object.entries(lock.tasks).sort(([left], [right]) => left.localeCompare(right))) {
    const bundle = taskBundleV1Schema.parse(task.bundle);
    if (bundle.taskId !== taskId) throw new Error(`Lock task ${taskId} does not match its compiled bundle identity`);
    const canonical = canonicalJson(bundle);
    const hash = sha256.parse(task.bundleHash);
    if (await canonicalSha256(bundle) !== hash) throw new Error(`Lock task ${taskId} does not match its bundle hash`);
    bundles.push(hash);
    statements.push(
      `INSERT INTO actions_task_bundles(bundle_hash,task_id,bundle_json) VALUES (${sql(hash)},${sql(taskId)},${sql(canonical)}) ON CONFLICT(bundle_hash) DO NOTHING;`,
      `INSERT INTO actions_repository_tasks(repository_id,bundle_hash,enabled) VALUES (${sql(metadata.repositoryId)},${sql(hash)},1) ON CONFLICT(repository_id,bundle_hash) DO UPDATE SET enabled=1,updated_at=CURRENT_TIMESTAMP;`,
    );
  }
  wrangler(resolve(input.sourceRoot), "apps/gardener", [
    "d1", "execute", manifest.cloudflare.database.name,
    "--remote", "--config", manifest.cloudflare.runtimeConfig,
    "--command", statements.join("\n"),
  ], undefined, { quiet: true });
  runCommand("gh", [
    "variable", "set", "GARDENER_INGRESS_URL", "--repo", repository,
    "--body", manifest.cloudflare.ingressOrigin,
  ], { cwd: input.repositoryRoot, quiet: true });
  return { repositoryId: metadata.repositoryId, bundles, ingressOrigin: manifest.cloudflare.ingressOrigin };
}

export async function doctorActions(workspace: string, sourceRoot: string): Promise<{
  ok: true;
  runtime: true;
  database: true;
  ingress: true;
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
  if (!workerExists(resolve(sourceRoot), manifest.cloudflare.runtimeWorker)
    || !workerExists(resolve(sourceRoot), manifest.cloudflare.ingressWorker)) {
    throw new Error("Gardener Workers do not match the installation manifest");
  }
  const response = await fetch(`${manifest.cloudflare.ingressOrigin}/health`);
  const health = await response.json().catch(() => null) as { ok?: unknown; runtime?: unknown } | null;
  if (!response.ok || health?.ok !== true || health.runtime !== true) {
    throw new Error("Gardener ingress or private runtime binding is unhealthy");
  }
  return { ok: true, runtime: true, database: true, ingress: true };
}

export async function destroyActions(input: {
  workspace: string;
  sourceRoot: string;
  execute: boolean;
  confirm?: string;
}): Promise<{ destroyed: boolean; resources: ActionsResourceNames }> {
  const manifest = await requiredActionsManifest(input.workspace);
  const sourceRoot = resolve(input.sourceRoot);
  const resources = actionsResourceNames(input.workspace);
  if (!input.execute) return { destroyed: false, resources };
  if (input.confirm !== input.workspace) {
    throw new Error(`Destructive teardown requires --confirm ${input.workspace}`);
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
    );
  }
  deleteWorker(sourceRoot, "apps/runner-ingress", manifest.cloudflare.ingressWorker, manifest.cloudflare.ingressConfig);
  deleteWorker(sourceRoot, "apps/gardener", manifest.cloudflare.runtimeWorker, manifest.cloudflare.runtimeConfig);
  if (database) {
    runCommand("pnpm", [
      "exec", "wrangler", "d1", "delete", manifest.cloudflare.database.name, "--skip-confirmation",
    ], { cwd: join(sourceRoot, "apps/gardener"), quiet: true });
  }
  const directory = actionsInstallationDirectory(input.workspace);
  await writePrivateJson(join(directory, "teardown.json"), {
    schemaVersion: "gardener.actions-teardown/v1",
    workspace: input.workspace,
    destroyedAt: new Date().toISOString(),
    cloudflare: manifest.cloudflare,
  });
  await unlink(join(directory, "installation.json"));
  await unlink(join(directory, "deploy-intent.json")).catch(() => undefined);
  return { destroyed: true, resources };
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

async function requiredActionsManifest(workspace: string): Promise<ActionsInstallationManifest> {
  const manifest = await readActionsManifest(workspace);
  if (!manifest) throw new Error(`No Actions installation exists for workspace ${workspace}`);
  return manifest;
}

const lockSchema = z.strictObject({
  schemaVersion: z.literal("gardener.lock/v1"),
  release: z.strictObject({ workflowRef: z.string().min(1) }),
  tasks: z.record(z.string(), z.strictObject({
    source: z.string(),
    bundleHash: sha256,
    workflow: z.string(),
    bundle: z.record(z.string(), z.unknown()),
  })),
});

export async function readProjectLock(repositoryRoot: string) {
  return lockSchema.parse(JSON.parse(await readFile(
    join(resolve(repositoryRoot), ".gardener", "gardener.lock.json"),
    "utf8",
  )));
}

export async function ensurePublicRunnerIngress(input: {
  accountId: string;
  workspace: string;
  ingressOrigin: string;
  existingAppId: string | null;
}, stabilizationMs = 5_000): Promise<string | null> {
  // A newly assigned workers.dev hostname can briefly answer before account-wide
  // Access policy propagation. Wait before deciding that no bypass is required.
  if (stabilizationMs > 0) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, stabilizationMs));
  }
  let accessIntercepted = false;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await fetch(`${input.ingressOrigin}/health`, { redirect: "manual" });
    if (isAccessRedirect(response)) {
      accessIntercepted = true;
      break;
    }
    const body = await response.json().catch(() => null) as { ok?: unknown; runtime?: unknown } | null;
    if (response.ok && body?.ok === true && body.runtime === true) return input.existingAppId;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  }
  if (!accessIntercepted) return input.existingAppId;
  const expectedName = `Gardener ${input.workspace} runner ingress`;
  const domain = new URL(input.ingressOrigin).hostname;

  if (input.existingAppId) {
    const existing = await cloudflareApi(input.accountId, `/access/apps/${encodeURIComponent(input.existingAppId)}`);
    const record = objectResult(existing);
    if (record.domain !== domain || record.name !== expectedName) {
      throw new Error("Recorded runner Access bypass does not match the deployed ingress");
    }
    return input.existingAppId;
  }

  const listed = await cloudflareApi(input.accountId, "/access/apps?per_page=100");
  const exact = arrayResult(listed).filter((item) => item.domain === domain);
  if (exact.length > 0) {
    const owned = exact.find((item) => item.name === expectedName && typeof item.id === "string");
    if (!owned) throw new Error("An unmanaged Cloudflare Access application already owns the runner ingress hostname");
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
        name: "Allow GitHub OIDC runner sessions",
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

async function requireHealthyIngress(ingressOrigin: string): Promise<void> {
  for (let attempt = 0; attempt < 15; attempt += 1) {
    const response = await fetch(`${ingressOrigin}/health`, { redirect: "manual" });
    if (!isAccessRedirect(response)) {
      const body = await response.json().catch(() => null) as { ok?: unknown; runtime?: unknown } | null;
      if (response.ok && body?.ok === true && body.runtime === true) return;
      throw new Error("Gardener ingress could not verify its private runtime binding");
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  }
  throw new Error("Cloudflare Access runner bypass did not become active");
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
): Promise<unknown> {
  const token = process.env.CLOUDFLARE_API_TOKEN ?? process.env.CF_API_TOKEN;
  if (!token) {
    throw new Error(
      "Cloudflare Access protects the runner hostname. Set a scoped CLOUDFLARE_API_TOKEN with Access Apps and Policies edit permission, then rerun deploy.",
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

function deleteWorker(sourceRoot: string, directory: string, worker: string, config: string): void {
  const result = runCommand("pnpm", [
    "exec", "wrangler", "delete", worker, "--force", "--config", config,
  ], { cwd: join(sourceRoot, directory), quiet: true, allowFailure: true });
  if (result.status !== 0 && !/not found|does not exist|10090/i.test(`${result.stdout}\n${result.stderr}`)) {
    throw new Error(`Failed to delete Gardener Worker ${worker}`);
  }
}

function sql(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
