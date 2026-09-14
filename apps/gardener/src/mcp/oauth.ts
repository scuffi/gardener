import OAuthProvider, { type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { McpServer } from "@modelcontextprotocol/server";
import { createMcpAuthInfo } from "./auth-context";
import {
  createAuthorizationHandler,
  type AuthorizationEnv,
  type ConsentStateStore,
  type GardenerOwnerPrincipal,
} from "./consent";
import { GARDENER_MCP_SCOPES } from "./scopes";
import { createGardenerStatelessMcpHandler } from "./server";
import type { GardenerMcpAuthorizedServices } from "./services";

export interface GardenerMcpEnv extends AuthorizationEnv {
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
}

export interface GardenerMcpOAuthConfiguration {
  /** Public authorization-server origin, for example https://gardener.example.com. */
  issuer: string;
  /** Exact protected MCP resource URL, for example https://gardener.example.com/mcp. */
  audience: string;
  mcpRoute?: string;
  authorizeEndpoint?: string;
  tokenEndpoint?: string;
  clientRegistrationEndpoint?: string;
}

export interface GardenerMcpOAuthDependencies<Env extends GardenerMcpEnv> {
  /** Existing Gardener Worker/Hono handler for every route not owned by OAuth consent. */
  applicationHandler: ExportedHandler<Env>;
  /** Must verify the existing GitHub-authenticated gardener_session owner cookie. */
  verifyOwnerSession(request: Request, env: Env): Promise<GardenerOwnerPrincipal | null>;
  /** Returns real Agent/run services backed by Gardener persistence. */
  services(env: Env): GardenerMcpAuthorizedServices;
  /** Must atomically validate and consume short-lived consent state. */
  consentState(env: Env): ConsentStateStore;
  now?: () => number;
  randomToken?: () => string;
  onMcpServerCreated?: (server: McpServer) => void;
}

function normalizedConfiguration(configuration: GardenerMcpOAuthConfiguration): Required<GardenerMcpOAuthConfiguration> {
  const issuer = new URL(configuration.issuer);
  const audience = new URL(configuration.audience);
  if (issuer.protocol !== "https:" || audience.protocol !== "https:") throw new Error("Gardener MCP OAuth requires HTTPS URLs");
  if (issuer.username || issuer.password || issuer.search || issuer.hash || audience.username || audience.password || audience.search || audience.hash) {
    throw new Error("Gardener MCP OAuth URLs must not contain credentials, query strings, or fragments");
  }
  const mcpRoute = configuration.mcpRoute ?? audience.pathname;
  const authorizeEndpoint = configuration.authorizeEndpoint ?? "/oauth/authorize";
  const tokenEndpoint = configuration.tokenEndpoint ?? "/oauth/token";
  const clientRegistrationEndpoint = configuration.clientRegistrationEndpoint ?? "/oauth/register";
  for (const route of [mcpRoute, authorizeEndpoint, tokenEndpoint, clientRegistrationEndpoint]) {
    if (!route.startsWith("/") || route.includes("?") || route.includes("#")) throw new Error("Invalid OAuth route");
  }
  if (audience.pathname !== mcpRoute) throw new Error("MCP audience path must match mcpRoute");
  return {
    issuer: issuer.origin,
    audience: audience.toString(),
    mcpRoute,
    authorizeEndpoint,
    tokenEndpoint,
    clientRegistrationEndpoint,
  };
}

function oauthApiError(): Response {
  return new Response(JSON.stringify({ error: "invalid_token" }), {
    status: 401,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      pragma: "no-cache",
      "x-content-type-options": "nosniff",
    },
  });
}

/**
 * Returns the OAuthProvider that the Gardener Worker should use as its default
 * export. The existing app, session verifier, persistence services, and atomic
 * consent state are deliberately injected by the main Worker.
 */
export function createGardenerMcpOAuthProvider<Env extends GardenerMcpEnv>(
  dependencies: GardenerMcpOAuthDependencies<Env>,
  configuration: GardenerMcpOAuthConfiguration,
): OAuthProvider<Env> {
  const config = normalizedConfiguration(configuration);
  const authorizationHandler = createAuthorizationHandler<Env>({
    audience: config.audience,
    verifyOwnerSession: dependencies.verifyOwnerSession,
    consentState: dependencies.consentState,
    ...(dependencies.now ? { now: dependencies.now } : {}),
    ...(dependencies.randomToken ? { randomToken: dependencies.randomToken } : {}),
  });

  const defaultHandler: ExportedHandler<Env> = {
    async fetch(request, env, ctx) {
      if (new URL(request.url).pathname === config.authorizeEndpoint) {
        return authorizationHandler.fetch!(request, env, ctx);
      }
      if (!dependencies.applicationHandler.fetch) return new Response("Not found", { status: 404 });
      return dependencies.applicationHandler.fetch(request, env, ctx);
    },
  };

  const apiHandler = {
    async fetch(request, env, ctx) {
      try {
        const providerContext = ctx as ExecutionContext & { props?: unknown };
        const { authInfo, props } = createMcpAuthInfo(request, providerContext.props, config.audience);
        const handler = createGardenerStatelessMcpHandler(dependencies.services(env), {
          route: config.mcpRoute,
          audience: config.audience,
          authProps: props,
          authInfo,
          ...(dependencies.onMcpServerCreated ? { onServerCreated: dependencies.onMcpServerCreated } : {}),
        });
        return handler.fetch(request, { authInfo });
      } catch {
        return oauthApiError();
      }
    },
  } satisfies ExportedHandler<Env>;

  return new OAuthProvider<Env>({
    apiRoute: config.mcpRoute,
    apiHandler,
    defaultHandler,
    authorizeEndpoint: config.authorizeEndpoint,
    tokenEndpoint: config.tokenEndpoint,
    clientRegistrationEndpoint: config.clientRegistrationEndpoint,
    scopesSupported: [...GARDENER_MCP_SCOPES],
    resourceMetadata: {
      resource: config.audience,
      authorization_servers: [config.issuer],
      scopes_supported: [...GARDENER_MCP_SCOPES],
      resource_name: "Gardener Agent authoring",
    },
  });
}

/** Default-export integration factory; the main Worker supplies real dependencies. */
export default createGardenerMcpOAuthProvider;
