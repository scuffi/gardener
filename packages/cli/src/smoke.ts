import { join } from "node:path";
import { fetchJsonEndpoint } from "./access.js";
import {
  availableGitHubOperationKinds,
  gatewayDoctorResultSchema,
  githubGatewayHealthSchema,
  unavailableGitHubOperationKinds,
} from "@gardener/provider-github";
import { operatorContext } from "./operator.js";
import { statePaths, writePrivateJson } from "./state.js";

interface GardenerHealth {
  ok?: boolean;
  database?: boolean;
  githubGateway?: { configured?: boolean; ready?: boolean };
  agentRuntime?: { enabled?: boolean; status?: string };
}

export interface SmokeReport {
  schemaVersion: "gateway-smoke/v1";
  workspace: string;
  checkedAt: string;
  passed: boolean;
  checks: {
    gatewayPublicHealth: boolean;
    gatewayCredentials: boolean;
    gatewayToGardenerRpc: boolean;
    gardenerToGatewayRpc: boolean;
    capabilities: boolean;
    deliveryBacklogClear: boolean;
  };
  capabilityCounts: { total: number; available: number; unavailable: number };
  failedDeliveryCount: number;
  staleDeliveryCount: number;
  runtimeStatus: string | null;
}

export async function smokeGateway(workspace: string): Promise<void> {
  const { origin, gardenerOrigin, token } = await operatorContext(workspace);
  const [gatewayValue, diagnosticsValue, gardenerValue] = await Promise.all([
    fetchJsonEndpoint(
      `${origin}/health`,
      { headers: { accept: "application/json" } },
      { label: "Gateway health" },
    ),
    fetchJsonEndpoint(
      `${origin}/ops/doctor`,
      { headers: { authorization: `Bearer ${token}`, accept: "application/json" } },
      { label: "Gateway doctor" },
    ),
    fetchJsonEndpoint(
      `${gardenerOrigin}/api/health`,
      { headers: { accept: "application/json" } },
      { label: "Gardener health", allowUserAccess: true },
    ),
  ]);

  const gateway = githubGatewayHealthSchema.parse(gatewayValue);
  const diagnostics = gatewayDoctorResultSchema.parse(diagnosticsValue);
  const gardener = gardenerValue as GardenerHealth;
  const report = evaluateSmoke(workspace, gateway, diagnostics, gardener);
  const paths = statePaths(workspace);
  const timestamp = report.checkedAt.replaceAll(":", "-");
  const reportPath = join(paths.reports, `smoke-${timestamp}.json`);
  await writePrivateJson(reportPath, report);
  console.log(JSON.stringify({ ...report, reportPath }, null, 2));
  if (!report.passed) throw new Error("Gateway smoke checks failed");
}

export function evaluateSmoke(
  workspace: string,
  gateway: ReturnType<typeof githubGatewayHealthSchema.parse>,
  diagnostics: ReturnType<typeof gatewayDoctorResultSchema.parse>,
  gardener: GardenerHealth,
): SmokeReport {
  const available = diagnostics.capabilities.operations.filter((item) => item.available).length;
  const unavailable = diagnostics.capabilities.operations.length - available;
  const checks = {
    gatewayPublicHealth: gateway.ready === true && gateway.database === true,
    gatewayCredentials: diagnostics.health.githubApp === true,
    gatewayToGardenerRpc: diagnostics.health.gardenerBinding === true,
    gardenerToGatewayRpc: gardener.ok === true
      && gardener.githubGateway?.configured === true
      && gardener.githubGateway.ready === true,
    capabilities: diagnostics.capabilities.operations.length === 29
      && available === availableGitHubOperationKinds.length
      && unavailable === unavailableGitHubOperationKinds.length,
    deliveryBacklogClear: diagnostics.failedDeliveries.length === 0
      && diagnostics.staleDeliveries.length === 0,
  };
  return {
    schemaVersion: "gateway-smoke/v1",
    workspace,
    checkedAt: new Date().toISOString(),
    passed: Object.values(checks).every(Boolean),
    checks,
    capabilityCounts: {
      total: diagnostics.capabilities.operations.length,
      available,
      unavailable,
    },
    failedDeliveryCount: diagnostics.failedDeliveries.length,
    staleDeliveryCount: diagnostics.staleDeliveries.length,
    runtimeStatus: gardener.agentRuntime?.status ?? null,
  };
}
