import { generateKeyPairSync, webcrypto } from "node:crypto";
import { decodeJwt } from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { sha256, signIdentityAssertion } from "../src/crypto";
import { app } from "../src/index";

beforeAll(() => { if (!globalThis.crypto) Object.defineProperty(globalThis, "crypto", { value: webcrypto }); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

type StateRow = { instanceId: string; purpose: string; redirectUri: string | null; expiresAt: number; consumed: boolean };

class FakeStatement {
  private args: unknown[] = [];
  constructor(private readonly db: FakeDb, private readonly sql: string) {}
  bind(...args: unknown[]) { this.args = args; return this; }
  first<T>(): Promise<T | null> { return Promise.resolve(this.db.first(this.sql, this.args) as T | null); }
  run(): Promise<D1Result> { return Promise.resolve(this.db.run(this.sql, this.args) as D1Result); }
  all<T>(): Promise<D1Result<T>> { return Promise.resolve({ success: true, meta: {}, results: [] } as unknown as D1Result<T>); }
}

class FakeDb {
  readonly instanceId = "instance-1";
  tokenHash = "";
  owner: string | null = "101";
  identities: Array<{ instanceId: string; githubUserId: string; login: string }> = [];
  states = new Map<string, StateRow>();
  limiter: { window: number; attempts: number } | null = null;
  installationId: string | null = "installation-7";
  installationQueryInstanceId: string | null = null;

  prepare(sql: string) { return new FakeStatement(this, sql); }

  first(sql: string, args: unknown[]): unknown {
    if (sql.includes("SELECT id FROM instances WHERE token_hash")) {
      return args[0] === this.tokenHash ? { id: this.instanceId } : null;
    }
    if (sql.includes("SELECT instance_id, redirect_uri FROM oauth_states")) {
      const row = this.states.get(String(args[0]));
      return row && row.purpose === args[1] && !row.consumed && row.expiresAt > Number(args[2])
        ? { instance_id: row.instanceId, redirect_uri: row.redirectUri }
        : null;
    }
    if (sql.includes("SELECT owner_github_user_id FROM instances")) {
      return args[0] === this.instanceId ? { owner_github_user_id: this.owner } : null;
    }
    if (sql.includes("SELECT callback_url FROM instances")) {
      return args[0] === this.instanceId ? { callback_url: null } : null;
    }
    if (sql.includes("SELECT id FROM installations WHERE instance_id")) {
      this.installationQueryInstanceId = String(args[0]);
      return args[0] === this.instanceId && this.installationId ? { id: this.installationId } : null;
    }
    if (sql.includes("INSERT INTO github_username_resolution_limits")) {
      const window = Number(args[1]);
      this.limiter = this.limiter?.window === window
        ? { window, attempts: Math.min(this.limiter.attempts + 1, 31) }
        : { window, attempts: 1 };
      return { attempts: this.limiter.attempts };
    }
    throw new Error(`Unhandled first SQL: ${sql}`);
  }

  run(sql: string, args: unknown[]): unknown {
    if (sql.includes("INSERT INTO oauth_states")) {
      this.states.set(String(args[0]), {
        instanceId: String(args[1]), purpose: String(args[2]), redirectUri: args[3] === null ? null : String(args[3]),
        expiresAt: Number(args[4]), consumed: false,
      });
      return changed(1);
    }
    if (sql.includes("UPDATE oauth_states SET consumed_at")) {
      const row = this.states.get(String(args[0]));
      if (!row || row.consumed) return changed(0);
      row.consumed = true;
      return changed(1);
    }
    if (sql.includes("INSERT INTO identities")) {
      this.identities.push({ instanceId: String(args[0]), githubUserId: String(args[1]), login: String(args[2]) });
      return changed(1);
    }
    if (sql.includes("DELETE FROM github_username_resolution_limits")) {
      if (this.limiter && this.limiter.window < Number(args[0])) this.limiter = null;
      return changed(0);
    }
    throw new Error(`Unhandled run SQL: ${sql}`);
  }
}

function changed(changes: number) {
  return { success: true, meta: { changes }, results: [] };
}

const connectKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const appKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });

async function fixture(owner: string | null = "101") {
  const db = new FakeDb();
  db.owner = owner;
  const instanceToken = "gdn_instance-1.test-token";
  db.tokenHash = await sha256(instanceToken);
  const env = {
    DB: db as unknown as D1Database,
    ADMIN_BOOTSTRAP_SECRET: "admin",
    GITHUB_CLIENT_ID: "client",
    GITHUB_CLIENT_SECRET: "secret",
    GITHUB_APP_ID: "1",
    GITHUB_APP_SLUG: "gardener-connect-dev",
    GITHUB_APP_PRIVATE_KEY: appKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    GITHUB_WEBHOOK_SECRET: "webhook",
    GITHUB_OAUTH_CALLBACK_URL: "https://connect.example/v1/auth/github/callback",
    CONNECT_JWT_PRIVATE_KEY: connectKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    CONNECT_JWT_PUBLIC_KEY: connectKeys.publicKey.export({ type: "spki", format: "pem" }).toString(),
    CONNECT_JWT_KID: "test",
    CONNECT_ISSUER: "https://connect.example",
    CONNECT_AUDIENCE: "gardener",
  } satisfies Omit<Env, "DB"> & { DB: D1Database };
  return { db, env: env as Env, instanceToken };
}

function auth(token: string) { return { authorization: `Bearer ${token}`, "content-type": "application/json" }; }
function json(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }); }

async function oauthState(env: Env, instanceToken: string): Promise<string> {
  const response = await app.request("/v1/auth/github/start", { method: "POST", headers: auth(instanceToken), body: "{}" }, env);
  expect(response.status).toBe(200);
  return new URL((await response.json() as { authorizationUrl: string }).authorizationUrl).searchParams.get("state")!;
}

function mockOauthUser(id: number, login: string) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.hostname === "github.com") return json({ access_token: "oauth-token" });
    if (url.pathname === "/user") return json({ id, login });
    return json({ message: "unexpected" }, 500);
  }));
}

async function callback(env: Env, state: string) {
  return app.request(`/v1/auth/github/callback?code=code&state=${encodeURIComponent(state)}`, {}, env);
}

describe("Connect team foundation stage 1", () => {
  it("requires a valid nonempty owner subject for admin bootstrap", async () => {
    const { env } = await fixture();
    const headers = auth("admin");
    const missing = await app.request("/v1/admin/bootstrap", { method: "POST", headers, body: JSON.stringify({ instanceId: "new-instance" }) }, env);
    const invalid = await app.request("/v1/admin/bootstrap", { method: "POST", headers, body: JSON.stringify({ instanceId: "new-instance", ownerGithubUserId: "0" }) }, env);
    expect(missing.status).toBe(400);
    expect(invalid.status).toBe(400);
  });

  it("rejects a NULL owner without adopting the authenticated user or writing identity state", async () => {
    const { db, env, instanceToken } = await fixture(null);
    const state = await oauthState(env, instanceToken);
    mockOauthUser(101, "owner");
    const response = await callback(env, state);
    expect(response.status).toBe(409);
    expect(db.owner).toBeNull();
    expect(db.identities).toEqual([]);
  });

  it("signs owner assertions with instanceOwner true and a fresh nonempty jti", async () => {
    const { env, instanceToken } = await fixture("101");
    mockOauthUser(101, "owner");
    const first = await callback(env, await oauthState(env, instanceToken));
    const second = await callback(env, await oauthState(env, instanceToken));
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstClaims = decodeJwt((await first.json() as { token: string }).token);
    const secondClaims = decodeJwt((await second.json() as { token: string }).token);
    expect(firstClaims.instanceOwner).toBe(true);
    expect(firstClaims.jti).toMatch(/^identity_[A-Za-z0-9_-]{43}$/);
    expect(secondClaims.jti).not.toBe(firstClaims.jti);
  });

  it("keeps callback login owner-only in stage 1", async () => {
    const { db, env, instanceToken } = await fixture("101");
    const state = await oauthState(env, instanceToken);
    mockOauthUser(202, "member");
    const response = await callback(env, state);
    expect(response.status).toBe(403);
    expect(db.identities).toEqual([]);
  });

  it("requires the immutable owner subject on the legacy identity installation route", async () => {
    const { env } = await fixture("101");
    const token = await signIdentityAssertion(env, { sub: "202", instanceId: "instance-1", githubLogin: "member", instanceOwner: false });
    const response = await app.request("/v1/installations/setup", { method: "POST", headers: auth(token), body: "{}" }, env);
    expect(response.status).toBe(403);
  });

  it("allows the immutable owner on the legacy identity installation route", async () => {
    const { db, env } = await fixture("101");
    const token = await signIdentityAssertion(env, { sub: "101", instanceId: "instance-1", githubLogin: "owner", instanceOwner: true });
    const response = await app.request("/v1/installations/setup", { method: "POST", headers: auth(token), body: "{}" }, env);
    expect(response.status).toBe(200);
    expect((await response.json() as { installationUrl: string }).installationUrl).toContain("/installations/new?state=");
    expect(db.states.size).toBe(1);
  });

  it("checks owner equality on the instance-token installation route", async () => {
    const { db, env, instanceToken } = await fixture("101");
    const denied = await app.request("/v1/instances/installations/setup", { method: "POST", headers: auth(instanceToken), body: JSON.stringify({ githubUserId: "202" }) }, env);
    expect(denied.status).toBe(403);
    expect(db.states.size).toBe(0);
    const allowed = await app.request("/v1/instances/installations/setup", { method: "POST", headers: auth(instanceToken), body: JSON.stringify({ githubUserId: "101" }) }, env);
    expect(allowed.status).toBe(200);
    expect((await allowed.json() as { installationUrl: string }).installationUrl).toContain("/installations/new?state=");
  });

  it("authenticates and validates bounded username lookup requests", async () => {
    const { env, instanceToken } = await fixture();
    expect((await app.request("/v1/instances/github/users/resolve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ login: "octocat" }) }, env)).status).toBe(401);
    expect((await app.request("/v1/instances/github/users/resolve", { method: "POST", headers: auth(instanceToken), body: JSON.stringify({ login: "-invalid" }) }, env)).status).toBe(400);
  });

  it("uses an installation token from the authenticated instance for 404 and successful lookups", async () => {
    const { db, env, instanceToken } = await fixture();
    const requests: Array<{ url: URL; authorization: string | null }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input));
      const authorization = new Headers(init.headers).get("authorization");
      requests.push({ url, authorization });
      if (url.pathname === "/app/installations/installation-7/access_tokens") return json({ token: "instance-installation-token" }, 201);
      if (url.pathname.endsWith("/missing")) return json({ message: "Not Found" }, 404);
      return json({ id: 583231, login: "octocat" });
    }));
    const missing = await app.request("/v1/instances/github/users/resolve", { method: "POST", headers: auth(instanceToken), body: JSON.stringify({ login: "missing" }) }, env);
    expect(missing.status).toBe(404);
    expect(db.identities).toEqual([]);
    expect(db.states.size).toBe(0);
    const found = await app.request("/v1/instances/github/users/resolve", { method: "POST", headers: auth(instanceToken), body: JSON.stringify({ login: "OctoCat" }) }, env);
    expect(found.status).toBe(200);
    expect(await found.json()).toEqual({ githubUserId: "583231", githubLogin: "octocat" });
    expect(db.installationQueryInstanceId).toBe("instance-1");
    expect(requests.filter(({ url }) => url.pathname.startsWith("/users/")).map(({ authorization }) => authorization)).toEqual([
      "Bearer instance-installation-token",
      "Bearer instance-installation-token",
    ]);
    expect(requests.filter(({ url }) => url.pathname.includes("/access_tokens")).every(({ authorization }) => authorization?.startsWith("Bearer eyJ"))).toBe(true);
  });

  it("fails closed when the instance has no active installation", async () => {
    const { db, env, instanceToken } = await fixture();
    db.installationId = null;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const response = await app.request("/v1/instances/github/users/resolve", { method: "POST", headers: auth(instanceToken), body: JSON.stringify({ login: "octocat" }) }, env);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "An active GitHub installation is required for username lookup" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sanitizes upstream failures and emits only status and classification", async () => {
    const { env, instanceToken } = await fixture();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.includes("/access_tokens")) return json({ token: "never-log-this-token" }, 201);
      return new Response("upstream secret response", { status: 500 });
    }));
    const response = await app.request("/v1/instances/github/users/resolve", { method: "POST", headers: auth(instanceToken), body: JSON.stringify({ login: "private-login" }) }, env);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "GitHub username lookup failed" });
    expect(warning).toHaveBeenCalledWith("github username lookup upstream failure", { classification: "user_lookup_http", status: 500 });

    vi.stubGlobal("fetch", vi.fn(async () => new Response("installation failure", { status: 503 })));
    const unavailable = await app.request("/v1/instances/github/users/resolve", { method: "POST", headers: auth(instanceToken), body: JSON.stringify({ login: "private-login" }) }, env);
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({ error: "GitHub installation is unavailable" });
  });

  it("returns stable 429 after 30 username lookups in one instance window", async () => {
    const { env, instanceToken } = await fixture();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => new URL(String(input)).pathname.includes("/access_tokens")
      ? json({ token: "instance-installation-token" }, 201)
      : json({ id: 101, login: "owner" }));
    vi.stubGlobal("fetch", fetchMock);
    for (let attempt = 1; attempt <= 30; attempt++) {
      const response = await app.request("/v1/instances/github/users/resolve", { method: "POST", headers: auth(instanceToken), body: JSON.stringify({ login: "owner" }) }, env);
      expect(response.status, `attempt ${attempt}`).toBe(200);
    }
    const limited = await app.request("/v1/instances/github/users/resolve", { method: "POST", headers: auth(instanceToken), body: JSON.stringify({ login: "owner" }) }, env);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "GitHub username lookup rate limit exceeded" });
    expect(fetchMock).toHaveBeenCalledTimes(60);
  });
});
