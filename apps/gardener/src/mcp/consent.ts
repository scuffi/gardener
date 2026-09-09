import type { AuthorizationError, AuthRequest, ClientInfo, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { gardenerMcpTokenPropsSchema, type GardenerMcpTokenProps } from "./auth-context";
import { GARDENER_MCP_SCOPE_LABELS, type GardenerMcpScope, validateGardenerMcpScopes } from "./scopes";

export const GARDENER_MCP_CONSENT_COOKIE = "__Host-gardener_mcp_consent";
export const GARDENER_MCP_CONSENT_TTL_SECONDS = 600;

export interface GardenerOwnerPrincipal {
  githubUserId: string;
  githubLogin: string;
  instanceId: string;
}

export interface SafeClientSnapshot {
  clientId: string;
  clientName: string;
}

export interface StoredConsentState {
  version: "gardener.mcp-consent/v1";
  oauthRequest: AuthRequest;
  client: SafeClientSnapshot;
  owner: GardenerOwnerPrincipal;
  requestedScopes: GardenerMcpScope[];
  csrfDigest: string;
  createdAt: number;
  expiresAt: number;
}

export type ConsentConsumeResult =
  | { status: "ok"; state: StoredConsentState }
  | { status: "invalid" | "expired" | "replayed" | "csrf-mismatch" | "owner-mismatch" };

/**
 * A real server-side store must implement atomic verify-and-consume semantics.
 * D1 conditional updates or a Durable Object are suitable; plain KV get/delete
 * is not atomic enough for this contract.
 */
export interface ConsentStateStore {
  create(state: StoredConsentState): Promise<{ handle: string }>;
  consume(input: {
    handle: string;
    csrfDigest: string;
    ownerGithubUserId: string;
    now: number;
  }): Promise<ConsentConsumeResult>;
}

export interface AuthorizationEnv {
  OAUTH_PROVIDER: OAuthHelpers;
}

export interface AuthorizationHandlerDependencies<Env extends AuthorizationEnv> {
  audience: string;
  verifyOwnerSession(request: Request, env: Env): Promise<GardenerOwnerPrincipal | null>;
  consentState(env: Env): ConsentStateStore;
  now?: () => number;
  randomToken?: () => string;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[character] ?? character);
}

function securityHeaders(contentType?: string): Headers {
  const headers = new Headers({
    "cache-control": "no-store",
    pragma: "no-cache",
    "content-security-policy": "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    "x-frame-options": "DENY",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  if (contentType) headers.set("content-type", contentType);
  return headers;
}

function response(body: string, status: number, contentType = "text/plain; charset=utf-8"): Response {
  return new Response(body, { status, headers: securityHeaders(contentType) });
}

function redirect(location: string, clearCookie = false): Response {
  const headers = securityHeaders();
  headers.set("location", location);
  if (clearCookie) headers.append("set-cookie", clearConsentCookie());
  return new Response(null, { status: 302, headers });
}

function consentCookie(token: string): string {
  return `${GARDENER_MCP_CONSENT_COOKIE}=${token}; Path=/; Max-Age=${GARDENER_MCP_CONSENT_TTL_SECONDS}; Secure; HttpOnly; SameSite=Lax`;
}

function clearConsentCookie(): string {
  return `${GARDENER_MCP_CONSENT_COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`;
}

function cookie(request: Request, name: string): string | null {
  const raw = request.headers.get("cookie");
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}

function defaultRandomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function clientSnapshot(client: ClientInfo): SafeClientSnapshot {
  return {
    clientId: client.clientId.slice(0, 512),
    clientName: (client.clientName?.trim() || "Unnamed OAuth client").slice(0, 200),
  };
}

function renderConsent(stateHandle: string, csrfToken: string, client: SafeClientSnapshot, scopes: GardenerMcpScope[]): string {
  const scopeItems = scopes.map((scope) =>
    `<li><code>${escapeHtml(scope)}</code> — ${escapeHtml(GARDENER_MCP_SCOPE_LABELS[scope])}</li>`
  ).join("");
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Authorize Gardener MCP</title></head>
<body>
<main>
<h1>Authorize Gardener MCP</h1>
<p><strong>${escapeHtml(client.clientName)}</strong> is requesting access.</p>
<p>Client ID: <code>${escapeHtml(client.clientId)}</code></p>
<h2>Requested permissions</h2>
<ul>${scopeItems}</ul>
<p>This access cannot activate or enable Agents, approve actions, change policy, retrieve credentials, or execute GitHub operations.</p>
<form method="post">
<input type="hidden" name="consent" value="${escapeHtml(stateHandle)}">
<input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}">
<button type="submit" name="decision" value="approve">Approve</button>
<button type="submit" name="decision" value="deny">Deny</button>
</form>
</main>
</body>
</html>`;
}

function isAuthorizationError(error: unknown): error is AuthorizationError {
  if (!error || typeof error !== "object") return false;
  const candidate = error as Partial<AuthorizationError>;
  return typeof candidate.code === "string" && typeof candidate.description === "string";
}

function oauthError(error: AuthorizationError): Response {
  if (!error.redirectUri) return response(error.description, 400);
  const location = new URL(error.redirectUri);
  location.searchParams.set("error", error.code);
  location.searchParams.set("error_description", error.description);
  if (error.state) location.searchParams.set("state", error.state);
  if (error.issuer) location.searchParams.set("iss", error.issuer);
  return redirect(location.toString());
}

function denyRedirect(request: AuthRequest): string {
  const location = new URL(request.redirectUri);
  location.searchParams.set("error", "access_denied");
  location.searchParams.set("state", request.state);
  if (request.issuer) location.searchParams.set("iss", request.issuer);
  return location.toString();
}

function singleFormValue(form: URLSearchParams, name: string): string | null {
  const values = form.getAll(name);
  return values.length === 1 && values[0] ? values[0] : null;
}

async function parseForm(request: Request): Promise<URLSearchParams | null> {
  const type = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  const length = Number(request.headers.get("content-length") ?? "0");
  if (type !== "application/x-www-form-urlencoded" || !Number.isFinite(length) || length > 16_384) return null;
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > 16_384) return null;
  return new URLSearchParams(body);
}

export function createAuthorizationHandler<Env extends AuthorizationEnv>(
  dependencies: AuthorizationHandlerDependencies<Env>,
): ExportedHandler<Env> {
  const now = dependencies.now ?? (() => Math.floor(Date.now() / 1_000));
  const randomToken = dependencies.randomToken ?? defaultRandomToken;

  return {
    async fetch(request, env) {
      if (request.method !== "GET" && request.method !== "POST") {
        const result = response("Method not allowed", 405);
        result.headers.set("allow", "GET, POST");
        return result;
      }

      const owner = await dependencies.verifyOwnerSession(request, env);
      if (!owner) return response("Dashboard owner authentication required", 401);

      if (request.method === "GET") {
        let oauthRequest: AuthRequest;
        try {
          oauthRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
        } catch (error) {
          if (isAuthorizationError(error)) return oauthError(error);
          return response("Invalid authorization request", 400);
        }

        let scopes: GardenerMcpScope[];
        try {
          scopes = validateGardenerMcpScopes(oauthRequest.scope);
        } catch {
          return response("Unknown OAuth scope", 400);
        }
        if (scopes.length === 0) return response("At least one scope is required", 400);

        const client = await env.OAUTH_PROVIDER.lookupClient(oauthRequest.clientId);
        if (!client || client.clientId !== oauthRequest.clientId) return response("Unknown OAuth client", 400);

        const csrfToken = randomToken();
        const createdAt = now();
        const stored: StoredConsentState = {
          version: "gardener.mcp-consent/v1",
          oauthRequest,
          client: clientSnapshot(client),
          owner,
          requestedScopes: scopes,
          csrfDigest: await sha256(csrfToken),
          createdAt,
          expiresAt: createdAt + GARDENER_MCP_CONSENT_TTL_SECONDS,
        };
        const { handle } = await dependencies.consentState(env).create(stored);
        if (!handle || handle.length > 512) return response("Consent state unavailable", 503);

        const headers = securityHeaders("text/html; charset=utf-8");
        headers.append("set-cookie", consentCookie(csrfToken));
        return new Response(renderConsent(handle, csrfToken, stored.client, scopes), { status: 200, headers });
      }

      if (request.headers.get("origin") !== new URL(request.url).origin) return response("Invalid request origin", 403);
      const form = await parseForm(request);
      if (!form) return response("Invalid consent submission", 400);
      const handle = singleFormValue(form, "consent");
      const submittedCsrf = singleFormValue(form, "csrf");
      const cookieCsrf = cookie(request, GARDENER_MCP_CONSENT_COOKIE);
      const decision = singleFormValue(form, "decision");
      if (!handle || !submittedCsrf || !cookieCsrf || submittedCsrf !== cookieCsrf || !["approve", "deny"].includes(decision ?? "")) {
        return response("Invalid consent submission", 403);
      }

      const consumed = await dependencies.consentState(env).consume({
        handle,
        csrfDigest: await sha256(submittedCsrf),
        ownerGithubUserId: owner.githubUserId,
        now: now(),
      });
      if (consumed.status !== "ok") return response("Consent state is invalid or expired", 403);
      const stored = consumed.state;
      if (
        stored.owner.githubUserId !== owner.githubUserId ||
        stored.owner.githubLogin !== owner.githubLogin ||
        stored.owner.instanceId !== owner.instanceId ||
        stored.expiresAt <= now()
      ) {
        return response("Consent state is invalid or expired", 403);
      }

      let exactScopes: GardenerMcpScope[];
      try {
        exactScopes = validateGardenerMcpScopes(stored.requestedScopes);
      } catch {
        return response("Invalid consent state", 400);
      }
      if (
        exactScopes.length === 0 ||
        exactScopes.length !== stored.oauthRequest.scope.length ||
        !exactScopes.every((scope) => stored.oauthRequest.scope.includes(scope))
      ) return response("Invalid consent state", 400);

      const client = await env.OAUTH_PROVIDER.lookupClient(stored.oauthRequest.clientId);
      if (
        !client ||
        client.clientId !== stored.client.clientId ||
        !client.redirectUris.includes(stored.oauthRequest.redirectUri)
      ) return response("OAuth client is no longer available", 400);

      if (decision === "deny") return redirect(denyRedirect(stored.oauthRequest), true);

      const props: GardenerMcpTokenProps = gardenerMcpTokenPropsSchema.parse({
        kind: "gardener.mcp-token/v1",
        githubUserId: owner.githubUserId,
        githubLogin: owner.githubLogin,
        instanceId: owner.instanceId,
        clientId: client.clientId,
        audience: dependencies.audience,
        scopes: exactScopes,
        authorizationId: randomToken(),
      });

      const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
        request: stored.oauthRequest,
        userId: owner.githubUserId,
        metadata: {
          schema: "gardener.mcp-consent/v1",
          clientName: stored.client.clientName,
        },
        scope: exactScopes,
        props,
      });
      return redirect(redirectTo, true);
    },
  };
}
