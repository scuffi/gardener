import { readFile } from "node:fs/promises";
import { fetchJsonEndpoint } from "./access.js";
import { readCheckpoint, statePaths } from "./state.js";

export async function doctor(workspace: string): Promise<void> {
  const { origin, token } = await operatorContext(workspace);
  const [health, diagnostics] = await Promise.all([
    fetchJsonEndpoint(
      `${origin}/health`,
      { headers: { accept: "application/json" } },
      { label: "Gateway health" },
    ) as Promise<Record<string, unknown>>,
    fetchJsonEndpoint(
      `${origin}/ops/doctor`,
      { headers: { authorization: `Bearer ${token}`, accept: "application/json" } },
      { label: "Gateway doctor" },
    ) as Promise<{ failedDeliveries?: unknown[]; staleDeliveries?: unknown[] }>,
  ]);
  const report = {
    health,
    failedDeliveries: diagnostics.failedDeliveries ?? [],
    staleDeliveries: diagnostics.staleDeliveries ?? [],
  };
  console.log(JSON.stringify(report, null, 2));
  if (health.ready !== true) throw new Error("Gateway is not ready");
  if (report.failedDeliveries.length || report.staleDeliveries.length) {
    throw new Error("Gateway has deliveries requiring operator attention");
  }
}

export async function retryDelivery(workspace: string, deliveryId: string): Promise<void> {
  if (!/^[A-Za-z0-9_-]{1,255}$/.test(deliveryId)) throw new Error("Invalid delivery id");
  const { origin, token } = await operatorContext(workspace);
  const response = await fetch(
    `${origin}/ops/deliveries/${encodeURIComponent(deliveryId)}/retry`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    },
  );
  const body = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(`Delivery retry failed (${response.status})`);
  console.log(JSON.stringify(body, null, 2));
  const delivery = body.delivery as Record<string, unknown> | undefined;
  if (delivery?.status !== "delivered") {
    throw new Error(`Delivery retry ended in ${String(delivery?.status ?? "an unknown state")}`);
  }
}

export async function operatorContext(workspace: string): Promise<{
  origin: string;
  gardenerOrigin: string;
  token: string;
}> {
  const paths = statePaths(workspace);
  const checkpoint = await readCheckpoint(paths.checkpoint);
  if (!checkpoint?.gatewayOrigin || !checkpoint.gardenerOrigin) {
    throw new Error(`No complete Gateway setup found for ${workspace}`);
  }
  const token = (await readFile(paths.operatorToken, "utf8")).trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("Gateway operator token is invalid");
  return {
    origin: checkpoint.gatewayOrigin,
    gardenerOrigin: checkpoint.gardenerOrigin,
    token,
  };
}
