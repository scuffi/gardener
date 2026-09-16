import { runCommand, wrangler } from "./commands.js";
import type { DeploymentNames } from "./config.js";

export interface CloudflareResources {
  accountId: string;
  gardenerDatabaseId: string;
  gatewayDatabaseId: string;
}

export interface D1DatabaseDescription {
  uuid: string;
  name: string;
}

export interface CloudflareAccountDescription {
  id: string;
  name: string;
}

export function assertCloudflareResourceNamesAvailable(
  repositoryRoot: string,
  names: DeploymentNames,
): string {
  const accountId = selectedAccountId(repositoryRoot);
  const databases = listDatabases(repositoryRoot);
  const collision = databases.some(
    (database) => database.name === names.gardenerDatabase || database.name === names.gatewayDatabase,
  ) || r2BucketExists(repositoryRoot, names.inputBucket)
    || workerExists(repositoryRoot, names.gardenerWorker)
    || workerExists(repositoryRoot, names.gatewayWorker);
  if (collision) {
    throw new Error(
      "Cloudflare resources already use this workspace name. Choose another workspace or resume its existing checkpoint.",
    );
  }
  return accountId;
}

export async function provisionCloudflareResources(input: {
  repositoryRoot: string;
  names: DeploymentNames;
  expectedAccountId: string;
  quiet?: boolean;
}): Promise<CloudflareResources> {
  const accountId = selectedAccountId(input.repositoryRoot);
  const quiet = input.quiet === true;
  if (accountId !== input.expectedAccountId) {
    throw new Error("Wrangler Cloudflare account changed after setup intent was recorded");
  }
  let databases = listDatabases(input.repositoryRoot);
  const existingGardener = databases.find((database) => database.name === input.names.gardenerDatabase);
  const existingGateway = databases.find((database) => database.name === input.names.gatewayDatabase);
  const bucketExists = r2BucketExists(input.repositoryRoot, input.names.inputBucket);

  if (!existingGardener) {
    wrangler(input.repositoryRoot, "apps/github-gateway", ["d1", "create", input.names.gardenerDatabase], undefined, { quiet });
  }
  if (!existingGateway) {
    wrangler(input.repositoryRoot, "apps/github-gateway", ["d1", "create", input.names.gatewayDatabase], undefined, { quiet });
  }
  if (!bucketExists) {
    wrangler(input.repositoryRoot, "apps/github-gateway", ["r2", "bucket", "create", input.names.inputBucket], undefined, { quiet });
  }

  databases = listDatabases(input.repositoryRoot);
  const gardener = databases.find((database) => database.name === input.names.gardenerDatabase);
  const gateway = databases.find((database) => database.name === input.names.gatewayDatabase);
  if (!gardener || !gateway || !r2BucketExists(input.repositoryRoot, input.names.inputBucket)) {
    throw new Error("Cloudflare resource provisioning verification failed");
  }
  return {
    accountId,
    gardenerDatabaseId: gardener.uuid,
    gatewayDatabaseId: gateway.uuid,
  };
}

export function selectedAccountId(repositoryRoot: string): string {
  return selectedAccount(repositoryRoot).id;
}

export function selectedAccount(repositoryRoot: string): CloudflareAccountDescription {
  const result = wrangler(repositoryRoot, "apps/github-gateway", ["whoami", "--json"], undefined, {
    quiet: true,
  });
  const value = JSON.parse(result.stdout) as unknown;
  const accounts = collectAccounts(value);
  const requested = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (requested) {
    const selected = accounts.find((account) => account.id === requested);
    if (!selected) throw new Error("CLOUDFLARE_ACCOUNT_ID is not available to the current Wrangler identity");
    return selected;
  }
  if (accounts.length !== 1) {
    throw new Error("Set CLOUDFLARE_ACCOUNT_ID when the Wrangler identity belongs to multiple accounts");
  }
  return accounts[0]!;
}

function collectAccounts(value: unknown): CloudflareAccountDescription[] {
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const collections = [record.accounts, record.memberships].filter(Array.isArray).flat();
  const found = new Map<string, CloudflareAccountDescription>();
  for (const item of collections) {
    if (!item || typeof item !== "object") continue;
    const account = item as Record<string, unknown>;
    const candidate = account.id ?? account.account_id ?? account.accountId;
    if (typeof candidate === "string" && /^[a-f0-9]{32}$/i.test(candidate)) {
      found.set(candidate, {
        id: candidate,
        name: typeof account.name === "string" ? account.name : candidate,
      });
    }
  }
  const direct = record.account_id ?? record.accountId;
  if (typeof direct === "string" && /^[a-f0-9]{32}$/i.test(direct) && !found.has(direct)) {
    found.set(direct, { id: direct, name: direct });
  }
  return [...found.values()];
}

export function listDatabases(repositoryRoot: string): D1DatabaseDescription[] {
  const result = wrangler(repositoryRoot, "apps/github-gateway", ["d1", "list", "--json"], undefined, {
    quiet: true,
  });
  const value = JSON.parse(result.stdout) as unknown;
  if (!Array.isArray(value)) throw new Error("Wrangler returned an invalid D1 database list");
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    const uuid = typeof row.uuid === "string" ? row.uuid : row.id;
    return typeof uuid === "string" && typeof row.name === "string"
      ? [{ uuid, name: row.name }]
      : [];
  });
}

export function workerExists(repositoryRoot: string, worker: string): boolean {
  const result = runCommand(
    "pnpm",
    ["exec", "wrangler", "deployments", "list", "--name", worker, "--json"],
    {
      cwd: `${repositoryRoot}/apps/github-gateway`,
      quiet: true,
      allowFailure: true,
    },
  );
  if (result.status === 0) {
    try {
      const deployments = JSON.parse(result.stdout) as unknown;
      return Array.isArray(deployments) ? deployments.length > 0 : true;
    } catch {
      throw new Error(`Wrangler returned invalid deployment data for Worker ${worker}`);
    }
  }
  const output = `${result.stdout}\n${result.stderr}`;
  if (/not found|does not exist|10090/i.test(output)) return false;
  throw new Error(`Unable to determine whether Worker ${worker} exists`);
}

export function r2BucketExists(repositoryRoot: string, bucket: string): boolean {
  const result = runCommand(
    "pnpm",
    ["exec", "wrangler", "r2", "bucket", "info", bucket, "--json"],
    {
      cwd: `${repositoryRoot}/apps/github-gateway`,
      quiet: true,
      allowFailure: true,
    },
  );
  if (result.status === 0) return true;
  const output = `${result.stdout}\n${result.stderr}`;
  if (/not found|does not exist|10006/i.test(output)) return false;
  throw new Error("Unable to determine whether the Gardener R2 bucket exists");
}
