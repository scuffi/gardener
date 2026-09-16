import { join, resolve } from "node:path";
import { runCommand, wrangler } from "./commands.js";
import { deploymentNames, writeGardenerConfig, writeGatewayConfig } from "./config.js";
import { validateWorkspace } from "./init.js";
import { statePaths, writePrivateJson } from "./state.js";

const DRY_GATEWAY_DATABASE_ID = "00000000-0000-4000-8000-000000000001";
const DRY_GARDENER_DATABASE_ID = "00000000-0000-4000-8000-000000000002";

export function gatewayPlan(workspaceInput: string) {
  const workspace = validateWorkspace(workspaceInput);
  const names = deploymentNames(workspace);
  return {
    schemaVersion: "gateway-plan/v1" as const,
    workspace,
    mutatesRemoteResources: false,
    resources: {
      workers: [names.gatewayWorker, names.gardenerWorker],
      d1Databases: [names.gatewayDatabase, names.gardenerDatabase],
      r2Buckets: [names.inputBucket],
      workflows: [names.workflow],
      githubApps: [`Gardener ${workspace} <random-suffix>`],
    },
    deploymentOrder: [
      "create Gateway and Gardener D1 databases plus Gardener R2 bucket",
      "deploy credential-free Gateway shell and apply Gateway migrations",
      "deploy Gardener, apply migrations, and install safe unassigned starter Agents",
      "seed the confirmed immutable permanent owner",
      "redeploy Gateway with reverse Gardener RPC binding",
      "create the customer-owned GitHub App from a manifest",
      "upload credentials to Gateway secrets through stdin",
      "verify both RPC directions, App credentials, capability split, and delivery diagnostics",
    ],
  };
}

export async function planGateway(input: {
  workspace: string;
  repositoryRoot?: string;
  quiet?: boolean;
}): Promise<void> {
  const repositoryRoot = resolve(input.repositoryRoot ?? process.cwd());
  const quiet = input.quiet === true;
  const plan = gatewayPlan(input.workspace);
  const names = deploymentNames(plan.workspace);
  if (!input.quiet) {
    console.log(JSON.stringify(plan, null, 2));
    console.log("\nBuilding and dry-running the generated qualification topology.");
  }

  runCommand("pnpm", ["--filter", "@gardener/app", "build"], {
    cwd: repositoryRoot,
    quiet,
  });
  const gatewayOrigin = `https://${names.gatewayWorker}.example.workers.dev`;
  const gardenerOrigin = `https://${names.gardenerWorker}.example.workers.dev`;
  const shellConfig = await writeGatewayConfig({
    repositoryRoot,
    workspace: plan.workspace,
    gatewayOrigin,
    gardenerOrigin,
    linked: false,
    gatewayDatabaseId: DRY_GATEWAY_DATABASE_ID,
  });
  const gardenerConfig = await writeGardenerConfig({
    repositoryRoot,
    workspace: plan.workspace,
    gardenerDatabaseId: DRY_GARDENER_DATABASE_ID,
  });
  const linkedConfig = await writeGatewayConfig({
    repositoryRoot,
    workspace: plan.workspace,
    gatewayOrigin,
    gardenerOrigin,
    linked: true,
    gatewayDatabaseId: DRY_GATEWAY_DATABASE_ID,
  });
  const output = join(repositoryRoot, "dist", "gateway-plan", plan.workspace);
  wrangler(repositoryRoot, "apps/github-gateway", [
    "deploy", "--dry-run", "--config", shellConfig, "--outdir", join(output, "gateway-shell"),
  ], undefined, { quiet });
  wrangler(repositoryRoot, "apps/gardener", [
    "deploy", "--dry-run", "--config", gardenerConfig,
    "--outdir", join(output, "gardener"), "--containers-rollout", "none",
  ], undefined, { quiet });
  wrangler(repositoryRoot, "apps/github-gateway", [
    "deploy", "--dry-run", "--config", linkedConfig, "--outdir", join(output, "gateway-linked"),
  ], undefined, { quiet });

  const reportPath = join(statePaths(plan.workspace).reports, "latest-plan.json");
  await writePrivateJson(reportPath, { ...plan, validatedAt: new Date().toISOString() });
  if (!input.quiet) {
    console.log(`\nDry-run topology validated. Report: ${reportPath}`);
    console.log("No Cloudflare or GitHub resource was created or changed.");
  }
}
