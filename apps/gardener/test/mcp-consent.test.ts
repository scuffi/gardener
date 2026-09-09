import { describe, expect, it, vi } from "vitest";
import type { AuthRequest, ClientInfo, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import {
  createAuthorizationHandler,
  type AuthorizationEnv,
  type ConsentConsumeResult,
  type ConsentStateStore,
  type GardenerOwnerPrincipal,
  type StoredConsentState,
} from "../src/mcp/consent";

const owner: GardenerOwnerPrincipal = {
  githubUserId: "123456",
  githubLogin: "octo-owner",
  instanceId: "instance-1",
};
const audience = "https://gardener.example.test/mcp";
const oauthRequest: AuthRequest = {
  responseType: "code",
  clientId: "client-1",
  redirectUri: "https://client.example.test/callback",
  scope: ["gardener:agents:read"],
  state: "client-state",
  codeChallenge: "challenge",
  codeChallengeMethod: "S256",
  resource: audience,
  issuer: "https://gardener.example.test",
};

class AtomicConsentStore implements ConsentStateStore {
  state: StoredConsentState | null = null;
  used = false;
  create = vi.fn(async (state: StoredConsentState) => {
    this.state = structuredClone(state);
    this.used = false;
    return { handle: "opaque-consent-handle" };
  });
  consume = vi.fn(async (input: { handle: string; csrfDigest: string; ownerGithubUserId: string; now: number }): Promise<ConsentConsumeResult> => {
    if (this.used) return { status: "replayed" };
    if (!this.state || input.handle !== "opaque-consent-handle") return { status: "invalid" };
    if (input.csrfDigest !== this.state.csrfDigest) return { status: "csrf-mismatch" };
    if (input.ownerGithubUserId !== this.state.owner.githubUserId) return { status: "owner-mismatch" };
    if (input.now > this.state.expiresAt) return { status: "expired" };
    this.used = true;
    return { status: "ok", state: structuredClone(this.state) };
  });
}

function oauth(overrides: Partial<OAuthHelpers> = {}): OAuthHelpers {
  return {
    parseAuthRequest: vi.fn(async () => structuredClone(oauthRequest)),
    lookupClient: vi.fn(async () => ({
      clientId: "client-1",
      clientName: "Example client",
      redirectUris: [oauthRequest.redirectUri],
    } as ClientInfo)),
    completeAuthorization: vi.fn(async () => ({ redirectTo: "https://client.example.test/callback?code=issued" })),
    ...overrides,
  } as OAuthHelpers;
}

function harness(options: {
  owner?: GardenerOwnerPrincipal | null;
  oauth?: OAuthHelpers;
  store?: AtomicConsentStore;
  tokens?: string[];
} = {}) {
  const store = options.store ?? new AtomicConsentStore();
  const oauthHelpers = options.oauth ?? oauth();
  const tokens = options.tokens ?? ["csrf-token-1234567890", "authorization-token-1234567890"];
  let tokenIndex = 0;
  const verifyOwnerSession = vi.fn(async () => options.owner === undefined ? owner : options.owner);
  const handler = createAuthorizationHandler<AuthorizationEnv>({
    audience,
    verifyOwnerSession,
    consentState: () => store,
    now: () => 1_789_000_000,
    randomToken: () => tokens[tokenIndex++] ?? "fallback-token-1234567890",
  });
  const env: AuthorizationEnv = { OAUTH_PROVIDER: oauthHelpers };
  return { handler, env, store, oauthHelpers, verifyOwnerSession };
}

async function fetchHandler(handler: ExportedHandler<AuthorizationEnv>, env: AuthorizationEnv, request: Request): Promise<Response> {
  return handler.fetch!(request as never, env, {} as ExecutionContext);
}

function authorizationGet(): Request {
  return new Request("https://gardener.example.test/oauth/authorize?client_id=client-1", { method: "GET" });
}

async function beginConsent(h = harness()) {
  const response = await fetchHandler(h.handler, h.env, authorizationGet());
  const html = await response.text();
  const consent = /name="consent" value="([^"]+)"/.exec(html)?.[1] ?? "";
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";
  const setCookie = response.headers.get("set-cookie") ?? "";
  const cookie = setCookie.split(";", 1)[0] ?? "";
  return { ...h, response, html, consent, csrf, cookie };
}

function consentPost(input: { consent: string; csrf: string; cookie: string; decision: "approve" | "deny" }): Request {
  return new Request("https://gardener.example.test/oauth/authorize", {
    method: "POST",
    headers: {
      origin: "https://gardener.example.test",
      "content-type": "application/x-www-form-urlencoded",
      cookie: input.cookie,
    },
    body: new URLSearchParams({ consent: input.consent, csrf: input.csrf, decision: input.decision }),
  });
}

describe("Gardener MCP OAuth consent", () => {
  it("requires an authenticated dashboard owner", async () => {
    const h = harness({ owner: null });
    const response = await fetchHandler(h.handler, h.env, authorizationGet());
    expect(response.status).toBe(401);
    expect(h.oauthHelpers.parseAuthRequest).not.toHaveBeenCalled();
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects unknown scopes before creating consent state", async () => {
    const helpers = oauth({
      parseAuthRequest: vi.fn(async () => ({ ...oauthRequest, scope: ["gardener:agents:read", "gardener:admin"] })),
    });
    const h = harness({ oauth: helpers });
    const response = await fetchHandler(h.handler, h.env, authorizationGet());
    expect(response.status).toBe(400);
    expect(h.store.create).not.toHaveBeenCalled();
    expect(helpers.completeAuthorization).not.toHaveBeenCalled();
  });

  it("escapes malicious client metadata and emits hardened script-free HTML", async () => {
    const helpers = oauth({
      lookupClient: vi.fn(async () => ({
        clientId: "client-1",
        clientName: '<script>alert("x")</script><img src=x onerror=alert(1)>&',
        logoUri: 'https://client.example.test/"><img src=x onerror=alert(1)>',
        redirectUris: [oauthRequest.redirectUri],
      } as ClientInfo)),
    });
    const started = await beginConsent(harness({ oauth: helpers }));
    expect(started.response.status).toBe(200);
    expect(started.html).not.toContain("<script>");
    expect(started.html).not.toContain("<img");
    expect(started.html).toContain("&lt;script&gt;");
    expect(started.html).toContain("&lt;img");
    expect(started.html).not.toContain(oauthRequest.redirectUri);
    expect(started.response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(started.response.headers.get("x-frame-options")).toBe("DENY");
    expect(started.response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(started.response.headers.get("set-cookie")).toContain("__Host-gardener_mcp_consent=");
    expect(started.response.headers.get("set-cookie")).toContain("Secure");
    expect(started.response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(started.html).not.toContain("client-state");
  });

  it("rejects CSRF mismatch without consuming or completing authorization", async () => {
    const started = await beginConsent();
    const response = await fetchHandler(started.handler, started.env, consentPost({
      consent: started.consent,
      csrf: "wrong-csrf-token",
      cookie: started.cookie,
      decision: "approve",
    }));
    expect(response.status).toBe(403);
    expect(started.store.consume).not.toHaveBeenCalled();
    expect(started.oauthHelpers.completeAuthorization).not.toHaveBeenCalled();
  });

  it("denies with the original OAuth state and atomically prevents replay", async () => {
    const started = await beginConsent();
    const request = () => consentPost({
      consent: started.consent,
      csrf: started.csrf,
      cookie: started.cookie,
      decision: "deny",
    });
    const denied = await fetchHandler(started.handler, started.env, request());
    expect(denied.status).toBe(302);
    const location = new URL(denied.headers.get("location")!);
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("state")).toBe("client-state");
    expect(location.searchParams.get("iss")).toBe("https://gardener.example.test");
    expect(started.oauthHelpers.completeAuthorization).not.toHaveBeenCalled();

    const replay = await fetchHandler(started.handler, started.env, request());
    expect(replay.status).toBe(403);
    expect(started.store.consume).toHaveBeenCalledTimes(2);
  });

  it("approves exact scopes with bounded public metadata and encrypted owner props", async () => {
    const completeAuthorization = vi.fn(async (_options: unknown) => ({ redirectTo: "https://client.example.test/callback?code=issued" }));
    const started = await beginConsent(harness({ oauth: oauth({ completeAuthorization }) }));
    const approved = await fetchHandler(started.handler, started.env, consentPost({
      consent: started.consent,
      csrf: started.csrf,
      cookie: started.cookie,
      decision: "approve",
    }));
    expect(approved.status).toBe(302);
    expect(completeAuthorization).toHaveBeenCalledOnce();
    const options = completeAuthorization.mock.calls[0]![0] as any;
    expect(options.scope).toEqual(["gardener:agents:read"]);
    expect(options.userId).toBe(owner.githubUserId);
    expect(options.metadata).toEqual({ schema: "gardener.mcp-consent/v1", clientName: "Example client" });
    expect(JSON.stringify(options.metadata)).not.toContain(owner.githubLogin);
    expect(JSON.stringify(options.metadata)).not.toContain(owner.githubUserId);
    expect(options.props).toMatchObject({
      kind: "gardener.mcp-token/v1",
      githubUserId: owner.githubUserId,
      githubLogin: owner.githubLogin,
      instanceId: owner.instanceId,
      clientId: "client-1",
      audience,
      scopes: ["gardener:agents:read"],
    });
    expect(options.props).not.toHaveProperty("token");
    expect(options.props).not.toHaveProperty("cookie");
    expect(approved.headers.get("set-cookie")).toContain("Max-Age=0");
  });
});
