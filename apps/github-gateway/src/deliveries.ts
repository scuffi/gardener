import { operationKindValues } from "@gardener/contracts";
import {
  availableGitHubOperationKinds,
  deliverGitHubEventResultSchema,
  gatewayDeliverySummarySchema,
  gatewayDoctorResultSchema,
  retryGatewayDeliveryResultSchema,
  type GatewayDeliverySummary,
  type GatewayDoctorResult,
  type RetryGatewayDeliveryResult,
} from "@gardener/provider-github";
import { canonicalSha256 } from "@gardener/core";
import { nowSeconds, randomToken, sha256Bytes } from "./database";
import type { Env } from "./env";
import { gatewayReady } from "./env";
import { verifyGitHubAppCredentials } from "./github-client";
import { syncInstallationRepositories } from "./repositories";
import { normalizeGitHubWebhook } from "./webhooks";

const MAX_WEBHOOK_BYTES = 1_000_000;
const DELIVERY_LEASE_SECONDS = 90;

interface DeliveryRow {
  delivery_id: string;
  event_name: string;
  installation_id?: string;
  repository_name: string | null;
  normalized_event_json: string | null;
  normalized_event_hash: string | null;
  status: "received" | "delivering" | "delivered" | "failed";
  attempt_count: number;
  attempt_token: string | null;
  lease_expires_at: number | null;
  last_error: string | null;
  received_at: string;
  delivered_at: string | null;
}

export interface AcceptedWebhook {
  deliveryId: string;
  duplicate: boolean;
  ignored: boolean;
}

export async function acceptGitHubWebhook(
  request: Request,
  env: Env,
  ctx: { waitUntil(promise: Promise<unknown>): void },
): Promise<AcceptedWebhook> {
  const deliveryId = requiredHeader(request, "x-github-delivery", 255);
  const eventName = requiredHeader(request, "x-github-event", 100);
  const signature = requiredHeader(request, "x-hub-signature-256", 80);
  const body = await readBoundedBody(request);
  if (!await verifyWebhookSignature(body, signature, env.GITHUB_WEBHOOK_SECRET)) {
    throw new WebhookError(401, "invalid_webhook_signature");
  }

  const payloadHash = await sha256Bytes(body);
  let payload: unknown;
  try { payload = JSON.parse(new TextDecoder().decode(body)); }
  catch { throw new WebhookError(400, "invalid_webhook_json"); }

  const facts = webhookFacts(payload);
  if (!facts.installationId) throw new WebhookError(400, "missing_installation");

  const normalized = normalizeGitHubWebhook(
    eventName,
    payload,
    deliveryId,
    env.GARDENER_WORKSPACE_ID,
  );
  if (!normalized) {
    const synchronizeRepositories = eventName === "installation_repositories";
    if (synchronizeRepositories) {
      const active = await env.DB.prepare(
        "SELECT 1 FROM installations WHERE id = ? AND suspended_at IS NULL AND revoked_at IS NULL",
      ).bind(facts.installationId).first();
      if (!active) throw new WebhookError(409, "installation_not_active");
    }
    const inserted = await env.DB.prepare(
      "INSERT INTO webhook_deliveries " +
      "(delivery_id, event_name, event_action, payload_hash, installation_id, repository_id, " +
      "repository_name, status, delivered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, " +
      (synchronizeRepositories ? "NULL" : "CURRENT_TIMESTAMP") +
      ") ON CONFLICT(delivery_id) DO NOTHING",
    ).bind(
      deliveryId,
      eventName,
      facts.action,
      payloadHash,
      facts.installationId,
      facts.repositoryId,
      facts.repositoryName,
      synchronizeRepositories ? "received" : "delivered",
    ).run();
    if ((inserted.meta.changes ?? 0) !== 1) {
      await assertSameDelivery(env.DB, deliveryId, payloadHash, eventName);
      await applyInstallationLifecycle(env, eventName, payload);
      if (synchronizeRepositories) ctx.waitUntil(deliverWebhook(env, deliveryId));
      return { deliveryId, duplicate: true, ignored: true };
    }
    await applyInstallationLifecycle(env, eventName, payload);
    if (synchronizeRepositories) ctx.waitUntil(deliverWebhook(env, deliveryId));
    return { deliveryId, duplicate: false, ignored: true };
  }

  await applyInstallationLifecycle(env, eventName, payload);
  const installation = await env.DB.prepare(
    "SELECT 1 FROM installations WHERE id = ? AND suspended_at IS NULL AND revoked_at IS NULL",
  ).bind(facts.installationId).first();
  if (!installation) throw new WebhookError(409, "installation_not_active");

  const normalizedEventHash = await canonicalSha256(normalized);
  const normalizedEventJson = JSON.stringify(normalized);
  const inserted = await env.DB.prepare(
    "INSERT INTO webhook_deliveries " +
    "(delivery_id, event_name, event_action, payload_hash, installation_id, repository_id, " +
    "repository_name, normalized_event_id, normalized_event_json, normalized_event_hash, status) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'received') ON CONFLICT(delivery_id) DO NOTHING",
  ).bind(
    deliveryId,
    eventName,
    facts.action,
    payloadHash,
    facts.installationId,
    facts.repositoryId,
    facts.repositoryName,
    normalized.id,
    normalizedEventJson,
    normalizedEventHash,
  ).run();

  if ((inserted.meta.changes ?? 0) !== 1) {
    await assertSameDelivery(env.DB, deliveryId, payloadHash, eventName);
    // A prior request may have crashed after the durable insert but before waitUntil.
    // Re-driving the fenced delivery is safe and closes that acceptance window.
    ctx.waitUntil(deliverWebhook(env, deliveryId));
    return { deliveryId, duplicate: true, ignored: false };
  }

  ctx.waitUntil(deliverWebhook(env, deliveryId));
  return { deliveryId, duplicate: false, ignored: false };
}

export async function deliverWebhook(
  env: Env,
  deliveryId: string,
  allowFailed = false,
): Promise<GatewayDeliverySummary> {
  const attemptToken = randomToken("delivery_");
  const now = nowSeconds();
  const claim = await env.DB.prepare(
    "UPDATE webhook_deliveries SET status = 'delivering', attempt_count = attempt_count + 1, " +
    "attempt_token = ?, lease_expires_at = ?, last_error = NULL " +
    "WHERE delivery_id = ? AND " +
    "(normalized_event_json IS NOT NULL OR event_name = 'installation_repositories') AND " +
    "(status = 'received' OR (status = 'delivering' AND lease_expires_at < ?)" +
    (allowFailed ? " OR status = 'failed'" : "") + ")",
  ).bind(attemptToken, now + DELIVERY_LEASE_SECONDS, deliveryId, now).run();

  if ((claim.meta.changes ?? 0) !== 1) {
    const current = await readDelivery(env.DB, deliveryId);
    if (!current) throw new Error("delivery_not_found");
    return deliverySummary(current);
  }

  const row = await readDelivery(env.DB, deliveryId);
  if (!row) throw new Error("delivery_not_found");

  try {
    if (row.event_name === "installation_repositories") {
      const installation = await env.DB.prepare(
        "SELECT id, sync_generation FROM installations WHERE id = ? " +
        "AND suspended_at IS NULL AND revoked_at IS NULL",
      ).bind(row.installation_id ?? "").first<{ id: string; sync_generation: number }>();
      if (!installation) throw new Error("installation_not_active");
      await syncInstallationRepositories(env, installation);
    } else {
      if (!row.normalized_event_json || !row.normalized_event_hash) {
        throw new Error("delivery_event_unavailable");
      }
      if (!env.GARDENER) throw new Error("Gardener binding is unavailable");
      const event = JSON.parse(row.normalized_event_json) as unknown;
      const result = deliverGitHubEventResultSchema.parse(await env.GARDENER.deliverGitHubEvent({
        event: event as never,
        eventHash: row.normalized_event_hash,
      }));
      if (!result.accepted) throw new Error("Gardener rejected the event");
    }
    await env.DB.prepare(
      "UPDATE webhook_deliveries SET status = 'delivered', delivered_at = CURRENT_TIMESTAMP, " +
      "attempt_token = NULL, lease_expires_at = NULL WHERE delivery_id = ? AND attempt_token = ?",
    ).bind(deliveryId, attemptToken).run();
  } catch (error) {
    await env.DB.prepare(
      "UPDATE webhook_deliveries SET status = 'failed', last_error = ?, attempt_token = NULL, " +
      "lease_expires_at = NULL WHERE delivery_id = ? AND attempt_token = ?",
    ).bind(safeError(error), deliveryId, attemptToken).run();
  }

  const completed = await readDelivery(env.DB, deliveryId);
  if (!completed) throw new Error("delivery_not_found");
  return deliverySummary(completed);
}

export async function gatewayDoctor(env: Env): Promise<GatewayDoctorResult> {
  const now = nowSeconds();
  const [failed, stale] = await Promise.all([
    env.DB.prepare(
      "SELECT delivery_id, event_name, repository_name, normalized_event_json, " +
      "normalized_event_hash, status, attempt_count, attempt_token, lease_expires_at, " +
      "last_error, received_at, delivered_at FROM webhook_deliveries " +
      "WHERE status = 'failed' ORDER BY received_at DESC LIMIT 100",
    ).all<DeliveryRow>(),
    env.DB.prepare(
      "SELECT delivery_id, event_name, repository_name, normalized_event_json, " +
      "normalized_event_hash, status, attempt_count, attempt_token, lease_expires_at, " +
      "last_error, received_at, delivered_at FROM webhook_deliveries " +
      "WHERE (status = 'delivering' AND lease_expires_at < ?) OR " +
      "(status = 'received' AND received_at < datetime('now', '-5 minutes')) " +
      "ORDER BY received_at DESC LIMIT 100",
    ).bind(now).all<DeliveryRow>(),
  ]);

  let database = false;
  try { await env.DB.prepare("SELECT 1").first(); database = true; } catch { /* reported */ }
  let githubApp = false;
  try { githubApp = await verifyGitHubAppCredentials(env); } catch { /* sanitized below */ }
  let gardenerBinding = false;
  try {
    const health = await env.GARDENER?.health();
    gardenerBinding = health?.contractVersion === "github-gateway/v1"
      && health.ready === true
      && health.workspaceId === env.GARDENER_WORKSPACE_ID;
  } catch { /* sanitized below */ }
  return gatewayDoctorResultSchema.parse({
    health: {
      contractVersion: "github-gateway/v1",
      ready: Boolean(database && githubApp && gatewayReady(env) && gardenerBinding),
      database,
      githubApp,
      gardenerBinding,
    },
    capabilities: {
      contractVersion: "github-gateway/v1",
      operations: operationKindValues.map((kind) => ({
        kind,
        available: availableGitHubOperationKinds.includes(
          kind as (typeof availableGitHubOperationKinds)[number],
        ),
      })),
    },
    failedDeliveries: failed.results.map(deliverySummary),
    staleDeliveries: stale.results.map(deliverySummary),
  });
}

export async function retryWebhookDelivery(
  env: Env,
  deliveryId: string,
): Promise<RetryGatewayDeliveryResult> {
  return retryGatewayDeliveryResultSchema.parse({
    delivery: await deliverWebhook(env, deliveryId, true),
  });
}

export class WebhookError extends Error {
  constructor(readonly status: 400 | 401 | 409 | 413, readonly code: string) {
    super(code);
  }
}

async function verifyWebhookSignature(
  body: Uint8Array,
  header: string,
  secret: string,
): Promise<boolean> {
  if (!/^sha256=[a-f0-9]{64}$/i.test(header)) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = new Uint8Array(await crypto.subtle.sign(
    "HMAC",
    key,
    Uint8Array.from(body).buffer,
  ));
  const actual = Uint8Array.from(header.slice(7).match(/.{2}/g) ?? [], (part) => Number.parseInt(part, 16));
  if (actual.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index++) difference |= expected[index]! ^ actual[index]!;
  return difference === 0;
}

async function readBoundedBody(request: Request): Promise<Uint8Array> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_WEBHOOK_BYTES) {
    throw new WebhookError(413, "webhook_too_large");
  }
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_WEBHOOK_BYTES) {
      await reader.cancel();
      throw new WebhookError(413, "webhook_too_large");
    }
    chunks.push(value);
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body;
}

function requiredHeader(request: Request, name: string, maxLength: number): string {
  const value = request.headers.get(name);
  if (!value || value.length > maxLength) throw new WebhookError(400, `invalid_${name}`);
  return value;
}

function webhookFacts(payload: unknown): {
  action: string | null;
  installationId: string | null;
  repositoryId: string | null;
  repositoryName: string | null;
} {
  if (!payload || typeof payload !== "object") {
    return { action: null, installationId: null, repositoryId: null, repositoryName: null };
  }
  const value = payload as Record<string, unknown>;
  const installation = value.installation as Record<string, unknown> | undefined;
  const repository = value.repository as Record<string, unknown> | undefined;
  const owner = repository?.owner as Record<string, unknown> | undefined;
  return {
    action: typeof value.action === "string" ? value.action : null,
    installationId: typeof installation?.id === "number" ? String(installation.id) : null,
    repositoryId: typeof repository?.id === "number" ? String(repository.id) : null,
    repositoryName: typeof owner?.login === "string" && typeof repository?.name === "string"
      ? `${owner.login}/${repository.name}`
      : null,
  };
}

async function applyInstallationLifecycle(env: Env, eventName: string, payload: unknown): Promise<void> {
  if (!payload || typeof payload !== "object") return;
  const value = payload as Record<string, unknown>;
  const action = value.action;
  const installation = value.installation as Record<string, unknown> | undefined;
  if (eventName !== "installation" || typeof installation?.id !== "number") return;
  const installationId = String(installation.id);
  if (action === "deleted") {
    await env.DB.prepare(
      "UPDATE installations SET revoked_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    ).bind(installationId).run();
  } else if (action === "suspend") {
    await env.DB.prepare(
      "UPDATE installations SET suspended_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    ).bind(installationId).run();
  } else if (action === "unsuspend") {
    await env.DB.prepare(
      "UPDATE installations SET suspended_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    ).bind(installationId).run();
  }
}

async function assertSameDelivery(
  db: D1Database,
  deliveryId: string,
  payloadHash: string,
  eventName: string,
): Promise<void> {
  const existing = await db.prepare(
    "SELECT payload_hash, event_name FROM webhook_deliveries WHERE delivery_id = ?",
  ).bind(deliveryId).first<{ payload_hash: string; event_name: string }>();
  if (!existing || existing.payload_hash !== payloadHash || existing.event_name !== eventName) {
    throw new WebhookError(409, "delivery_id_payload_mismatch");
  }
}

async function readDelivery(db: D1Database, deliveryId: string): Promise<DeliveryRow | null> {
  return db.prepare(
    "SELECT delivery_id, event_name, installation_id, repository_name, normalized_event_json, " +
    "normalized_event_hash, status, attempt_count, attempt_token, lease_expires_at, " +
    "last_error, received_at, delivered_at FROM webhook_deliveries WHERE delivery_id = ?",
  ).bind(deliveryId).first<DeliveryRow>();
}

function deliverySummary(row: DeliveryRow): GatewayDeliverySummary {
  return gatewayDeliverySummarySchema.parse({
    deliveryId: row.delivery_id,
    eventName: row.event_name,
    repository: row.repository_name,
    status: row.status,
    attempts: row.attempt_count,
    lastError: row.last_error,
    receivedAt: row.received_at,
    deliveredAt: row.delivered_at,
  });
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "unknown delivery failure";
  return /^[A-Za-z0-9 ._():,-]{1,500}$/.test(message)
    ? message
    : "Gardener delivery failed";
}
