import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface DeploymentNames {
  gardenerWorker: string;
  gatewayWorker: string;
  gardenerDatabase: string;
  gatewayDatabase: string;
  workflow: string;
  inputBucket: string;
}

export function deploymentNames(workspace: string): DeploymentNames {
  return {
    gardenerWorker: `gardener-${workspace}`,
    gatewayWorker: `gardener-${workspace}-github-gateway`,
    gardenerDatabase: `gardener-${workspace}`,
    gatewayDatabase: `gardener-${workspace}-github-gateway`,
    workflow: `gardener-${workspace}-agent-runs`,
    inputBucket: `gardener-${workspace}-computer-inputs`,
  };
}

export async function writeGatewayConfig(input: {
  repositoryRoot: string;
  workspace: string;
  gatewayOrigin: string;
  gardenerOrigin: string;
  linked: boolean;
  gatewayDatabaseId?: string;
  cloudflareAccountId?: string;
}): Promise<string> {
  const names = deploymentNames(input.workspace);
  const application = join(input.repositoryRoot, "apps", "github-gateway");
  const outputDirectory = join(application, ".wrangler", "gardener-cli");
  await mkdir(outputDirectory, { recursive: true });
  const path = join(outputDirectory, input.linked ? `${input.workspace}.json` : `${input.workspace}-shell.json`);
  const config: Record<string, unknown> = {
    name: names.gatewayWorker,
    ...(input.cloudflareAccountId ? { account_id: input.cloudflareAccountId } : {}),
    main: join(application, "src", "index.ts"),
    compatibility_date: "2026-09-02",
    compatibility_flags: ["global_fetch_strictly_public"],
    observability: {
      enabled: true,
      logs: { enabled: true, invocation_logs: false },
      traces: { enabled: false },
    },
    vars: {
      GATEWAY_ORIGIN: input.gatewayOrigin,
      GARDENER_ORIGIN: input.gardenerOrigin,
      GARDENER_WORKSPACE_ID: input.workspace,
    },
    d1_databases: [{
      binding: "DB",
      database_name: names.gatewayDatabase,
      ...(input.gatewayDatabaseId ? { database_id: input.gatewayDatabaseId } : {}),
      migrations_dir: join(application, "migrations"),
    }],
  };
  if (input.linked) {
    config.services = [{
      binding: "GARDENER",
      service: names.gardenerWorker,
      entrypoint: "GardenerGitHubEntrypoint",
    }];
  }
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return path;
}

export async function writeGardenerConfig(input: {
  repositoryRoot: string;
  workspace: string;
  gardenerDatabaseId?: string;
  cloudflareAccountId?: string;
}): Promise<string> {
  const names = deploymentNames(input.workspace);
  const application = join(input.repositoryRoot, "apps", "gardener");
  const generatedDirectory = join(application, "dist", "gardener");
  const source = join(generatedDirectory, "wrangler.json");
  const config = JSON.parse(await readFile(source, "utf8")) as Record<string, any>;
  config.name = names.gardenerWorker;
  config.topLevelName = names.gardenerWorker;
  if (input.cloudflareAccountId) config.account_id = input.cloudflareAccountId;
  config.main = join(generatedDirectory, "index.js");
  config.assets = { ...config.assets, directory: join(application, "dist", "client") };
  config.vars = {
    AI_MODEL: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    GARDENER_WORKSPACE_ID: input.workspace,
    LOCAL_DEV_BYPASS: "false",
  };
  config.services = [{
    binding: "GITHUB_GATEWAY",
    service: names.gatewayWorker,
    entrypoint: "GitHubGatewayEntrypoint",
  }];
  config.d1_databases = [{
    binding: "DB",
    database_name: names.gardenerDatabase,
    ...(input.gardenerDatabaseId ? { database_id: input.gardenerDatabaseId } : {}),
    migrations_dir: join(application, "migrations"),
  }];
  config.r2_buckets = [{ binding: "COMPUTER_INPUTS", bucket_name: names.inputBucket }];
  config.workflows = (config.workflows ?? []).map((workflow: Record<string, unknown>) => ({
    ...workflow,
    name: names.workflow,
  }));
  config.containers = (config.containers ?? []).map((container: Record<string, unknown>) => ({
    ...container,
    name: `${names.gardenerWorker}-computerworkspace`,
    image: join(application, "Dockerfile.computer"),
    image_build_context: application,
  }));
  const output = join(generatedDirectory, `wrangler.${input.workspace}.json`);
  await writeFile(output, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return output;
}
