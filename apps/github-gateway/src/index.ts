import { GITHUB_GATEWAY_CONTRACT_VERSION } from "@gardener/provider-github";
import { Hono } from "hono";
import { z } from "zod";
import {
  acceptGitHubWebhook,
  gatewayDoctor,
  retryWebhookDelivery,
  WebhookError,
} from "./deliveries";
import type { Env } from "./env";
import { gatewayReady } from "./env";
import { completeGitHubInstallationCallback } from "./installations";
import { completeGitHubOAuthCallback } from "./oauth";
import { authorizeOperator } from "./operator";

interface Bindings { Bindings: Env }
const app = new Hono<Bindings>();

app.onError((error, c) => {
  console.error("GitHub Gateway request failed", safeError(error));
  if (error instanceof WebhookError) return c.json({ error: error.code }, error.status);
  if (error instanceof z.ZodError) return c.json({ error: "invalid_request" }, 400);
  const code = error instanceof Error && /^[a-z0-9_]+$/.test(error.message)
    ? error.message
    : "gateway_request_failed";
  const clientErrors = new Set([
    "invalid_or_expired_oauth_state",
    "oauth_state_replayed",
    "invalid_or_expired_installation_state",
    "installation_state_replayed",
    "installation_callback_mismatch",
    "installation_not_ready",
    "installation_owner_mismatch",
    "delivery_not_found",
  ]);
  const status = code.includes("binding_unavailable")
    ? 503
    : code === "identity_not_authorized" || code === "installation_owner_mismatch"
      ? 403
      : code === "identity_handoff_replayed"
        ? 409
        : code === "delivery_not_found"
          ? 404
          : clientErrors.has(code)
            ? 400
            : 500;
  return c.json({ error: code }, status);
});

app.get("/health", async (c) => {
  let database = false;
  try { await c.env.DB.prepare("SELECT 1").first(); database = true; }
  catch { /* reported below */ }
  return c.json({
    contractVersion: GITHUB_GATEWAY_CONTRACT_VERSION,
    ready: database && gatewayReady(c.env),
    database,
    githubApp: Boolean(c.env.GITHUB_APP_ID && c.env.GITHUB_APP_PRIVATE_KEY),
    gardenerBinding: Boolean(c.env.GARDENER),
  }, 200, { "cache-control": "no-store" });
});

app.get("/oauth/github/callback", async (c) => {
  const input = z.object({
    code: z.string().min(1).max(1_000),
    state: z.string().min(1).max(255),
  }).strict().parse(c.req.query());
  const destination = await completeGitHubOAuthCallback(c.env, input);
  return redirectWithoutReferrer(destination);
});

app.get("/installations/github/callback", async (c) => {
  const input = z.object({
    installation_id: z.string().regex(/^[1-9][0-9]{0,31}$/),
    state: z.string().min(1).max(255),
    setup_action: z.string().max(100).optional(),
  }).strict().parse(c.req.query());
  const destination = await completeGitHubInstallationCallback(c.env, {
    installationId: input.installation_id,
    state: input.state,
  });
  return redirectWithoutReferrer(destination);
});

app.post("/webhooks/github", async (c) => {
  const accepted = await acceptGitHubWebhook(c.req.raw, c.env, c.executionCtx);
  return c.json({ accepted: true, ...accepted }, 202, { "cache-control": "no-store" });
});

app.use("/ops/*", async (c, next) => {
  if (!await authorizeOperator(c.req.raw, c.env)) {
    return c.json({ error: "operator_authentication_required" }, 401);
  }
  return next();
});

app.get("/ops/doctor", async (c) => c.json(await gatewayDoctor(c.env), 200, {
  "cache-control": "no-store",
}));

app.post("/ops/deliveries/:id/retry", async (c) => {
  const deliveryId = z.string().min(1).max(255).parse(c.req.param("id"));
  return c.json(await retryWebhookDelivery(c.env, deliveryId), 200, {
    "cache-control": "no-store",
  });
});

app.notFound((c) => c.json({ error: "not_found" }, 404));

function redirectWithoutReferrer(destination: string): Response {
  return new Response(null, {
    status: 302,
    headers: {
      location: destination,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "unknown error";
  return /^[A-Za-z0-9 ._():,-]{1,500}$/.test(message)
    ? message
    : "redacted gateway error";
}

export { GitHubGatewayEntrypoint } from "./entrypoint";
export default app;
