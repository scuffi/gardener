import { exportJWK, exportSPKI, generateKeyPair, SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bearerToken, verifyEventToken, verifyIdentityToken } from "../src/auth";
import { cloudflareAccessCredentials, instanceId, type Env } from "../src/env";

async function fixture() {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const publicPem = await exportSPKI(publicKey);
  const env = {
    CONNECT_PUBLIC_KEY: publicPem,
    CONNECT_JWT_ALG: "RS256",
    CONNECT_ISSUER: "https://connect.example",
    CONNECT_URL: "https://connect.example",
    GARDENER_INSTANCE_TOKEN: "gdn_instance-1.abcdefghijklmnopqrstuvwxyz012345",
  } as unknown as Env;
  return { privateKey, env };
}

afterEach(() => vi.restoreAllMocks());

describe("Connect authentication", () => {
  it("derives the non-secret instance id from the one copied bootstrap token", async () => {
    const { env } = await fixture();
    expect(instanceId(env)).toBe("instance-1");
    expect(() => instanceId({ GARDENER_INSTANCE_TOKEN: "invalid" })).toThrow("Invalid Gardener instance token");
  });

  it("keeps Cloudflare Access optional but requires a complete service-token pair", () => {
    expect(cloudflareAccessCredentials({})).toBeNull();
    expect(cloudflareAccessCredentials({ CLOUDFLARE_ACCESS_CLIENT_ID: " id ", CLOUDFLARE_ACCESS_CLIENT_SECRET: " secret " })).toEqual({ clientId: "id", clientSecret: "secret" });
    expect(() => cloudflareAccessCredentials({ CLOUDFLARE_ACCESS_CLIENT_ID: "id" })).toThrow("requires both");
    expect(() => cloudflareAccessCredentials({ CLOUDFLARE_ACCESS_CLIENT_SECRET: "secret" })).toThrow("requires both");
  });

  it("extracts bearer tokens", () => {
    expect(bearerToken("Bearer abc.def")).toBe("abc.def");
    expect(bearerToken("Basic nope")).toBeNull();
  });

  it("accepts an instance-audienced identity", async () => {
    const { privateKey, env } = await fixture();
    const token = await new SignJWT({ typ: "gardener-identity" })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(env.CONNECT_ISSUER)
      .setAudience(instanceId(env))
      .setSubject("42")
      .setExpirationTime("5m")
      .sign(privateKey);
    await expect(verifyIdentityToken(token, env)).resolves.toMatchObject({ sub: "42" });
  });

  it("authenticates protected Connect JWKS discovery with the optional Access service token", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const jwk = { ...await exportJWK(publicKey), kid: "protected-test", alg: "RS256", use: "sig" };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({ keys: [jwk] }), { status: 200, headers: { "content-type": "application/json" } }));
    const env = {
      CONNECT_ISSUER: "https://protected-connect.example",
      CONNECT_URL: "https://protected-connect.example",
      GARDENER_INSTANCE_TOKEN: "gdn_instance-1.abcdefghijklmnopqrstuvwxyz012345",
      CLOUDFLARE_ACCESS_CLIENT_ID: "access-id",
      CLOUDFLARE_ACCESS_CLIENT_SECRET: "access-secret",
    } as unknown as Env;
    const token = await new SignJWT({ typ: "gardener-identity", githubLogin: "owner" })
      .setProtectedHeader({ alg: "RS256", kid: "protected-test" })
      .setIssuer(env.CONNECT_ISSUER).setAudience(instanceId(env)).setSubject("42").setExpirationTime("5m").sign(privateKey);
    await expect(verifyIdentityToken(token, env)).resolves.toMatchObject({ sub: "42" });
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Headers;
    expect(headers.get("cf-access-client-id")).toBe("access-id");
    expect(headers.get("cf-access-client-secret")).toBe("access-secret");
  });

  it("rejects events for another instance", async () => {
    const { privateKey, env } = await fixture();
    const event = {
      schemaVersion: "v2",
      id: "event-1",
      deliveryId: "delivery-1",
      instanceId: "instance-2",
      kind: "github.issue",
      action: "opened",
      occurredAt: "2026-09-02T12:00:00.000Z",
      repository: { provider: "github", id: "1318443351", installationId: "158557952", owner: "acme", name: "widgets", defaultBranch: "main" },
      actor: { id: "42", login: "octocat", accountType: "User" },
      resourceAuthor: { id: "42", login: "octocat", accountType: "User" },
      issue: { id: "100", number: 1, title: "Bug", body: null, state: "open", labels: [], locked: false, updatedAt: "2026-09-02T12:00:00.000Z", htmlUrl: "https://github.com/acme/widgets/issues/1" },
    };
    const token = await new SignJWT({ typ: "gardener-event", event })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(env.CONNECT_ISSUER)
      .setAudience(instanceId(env))
      .setExpirationTime("5m")
      .sign(privateKey);
    await expect(verifyEventToken(token, env)).rejects.toThrow("Event instance mismatch");
  });
});
