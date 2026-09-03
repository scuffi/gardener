import { exportSPKI, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
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
      .setSubject("github:42")
      .setExpirationTime("5m")
      .sign(privateKey);
    await expect(verifyIdentityToken(token, env)).resolves.toMatchObject({ sub: "github:42" });
  });

  it("rejects events for another instance", async () => {
    const { privateKey, env } = await fixture();
    const event = {
      schemaVersion: "v1",
      id: "event-1",
      deliveryId: "delivery-1",
      instanceId: "instance-2",
      kind: "github.issue",
      action: "opened",
      occurredAt: "2026-09-02T12:00:00.000Z",
      repository: { id: "repo-1", installationId: "1", owner: "acme", name: "widgets" },
      issue: { id: "issue-1", number: 1, title: "Bug", body: null, state: "open", labels: [], author: "a", htmlUrl: "https://github.com/acme/widgets/issues/1" },
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
