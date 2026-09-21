import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it, vi } from "vitest";
import {
  cloudflareAccessConfigured,
  verifyCloudflareAccessIdentity,
  verifyCloudflareAccessToken,
} from "../src/cloudflare-access";
import type { Env } from "../src/env";

function env(overrides: Partial<Env> = {}): Env {
  return {
    CLOUDFLARE_ACCESS_TEAM_DOMAIN: "https://example.cloudflareaccess.com",
    CLOUDFLARE_ACCESS_AUD: "access-application-audience",
    CLOUDFLARE_ACCESS_OWNER_EMAIL: "owner@example.com",
    ...overrides,
  } as Env;
}

function request(token = "signed-access-token"): Request {
  return new Request("https://gardener.example.test/api/auth/session", {
    headers: { "Cf-Access-Jwt-Assertion": token },
  });
}

describe("Cloudflare Access dashboard identity", () => {
  it("accepts only the configured owner from the exact issuer and audience", async () => {
    const verifier = vi.fn().mockResolvedValue({
      sub: "access-user-subject",
      email: "OWNER@EXAMPLE.COM",
    });

    await expect(verifyCloudflareAccessIdentity(request(), env(), verifier)).resolves.toEqual({
      subject: "access-user-subject",
      email: "owner@example.com",
      issuer: "https://example.cloudflareaccess.com",
    });
    expect(verifier).toHaveBeenCalledWith("signed-access-token", {
      issuer: "https://example.cloudflareaccess.com",
      audience: "access-application-audience",
      ownerEmail: "owner@example.com",
    });

    const cookieVerifier = vi.fn().mockResolvedValue({
      sub: "access-user-subject",
      email: "owner@example.com",
    });
    await expect(verifyCloudflareAccessIdentity(new Request("https://gardener.example.test", {
      headers: { cookie: "other=value; CF_Authorization=cookie-access-token" },
    }), env(), cookieVerifier)).resolves.toMatchObject({ subject: "access-user-subject" });
    expect(cookieVerifier).toHaveBeenCalledWith("cookie-access-token", expect.any(Object));
  });

  it("fails closed for a missing assertion, wrong owner, or invalid token", async () => {
    const valid = vi.fn().mockResolvedValue({ sub: "subject", email: "owner@example.com" });
    await expect(verifyCloudflareAccessIdentity(new Request("https://example.test"), env(), valid)).resolves.toBeNull();
    expect(valid).not.toHaveBeenCalled();

    await expect(verifyCloudflareAccessIdentity(
      request(),
      env(),
      vi.fn().mockResolvedValue({ sub: "subject", email: "someone@example.com" }),
    )).resolves.toBeNull();

    await expect(verifyCloudflareAccessIdentity(
      request(),
      env(),
      vi.fn().mockRejectedValue(new Error("bad signature")),
    )).resolves.toBeNull();
  });

  it("cryptographically binds signature, algorithm, issuer, audience, and expiry", async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwk = await exportJWK(publicKey);
    const kid = "access-test-key";
    jwk.kid = kid;
    const keySet = createLocalJWKSet({ keys: [jwk] });
    const configuration = {
      issuer: "https://example.cloudflareaccess.com",
      audience: "access-application-audience",
      ownerEmail: "owner@example.com",
    };
    const sign = (claims: { issuer?: string; audience?: string; expiration?: string } = {}) =>
      new SignJWT({ email: "owner@example.com" })
        .setProtectedHeader({ alg: "RS256", kid })
        .setSubject("access-user-subject")
        .setIssuer(claims.issuer ?? configuration.issuer)
        .setAudience(claims.audience ?? configuration.audience)
        .setIssuedAt()
        .setExpirationTime(claims.expiration ?? "5m")
        .sign(privateKey);

    await expect(verifyCloudflareAccessToken(await sign(), configuration, keySet)).resolves.toEqual({
      sub: "access-user-subject",
      email: "owner@example.com",
    });
    await expect(verifyCloudflareAccessToken(
      await sign({ audience: "wrong-audience" }), configuration, keySet,
    )).rejects.toThrow();
    await expect(verifyCloudflareAccessToken(
      await sign({ issuer: "https://other.cloudflareaccess.com" }), configuration, keySet,
    )).rejects.toThrow();
    await expect(verifyCloudflareAccessToken(
      await sign({ expiration: "0s" }), configuration, keySet,
    )).rejects.toThrow();

    const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const unsecured = `${encode({ alg: "none" })}.${encode({
      sub: "access-user-subject",
      email: "owner@example.com",
      iss: configuration.issuer,
      aud: configuration.audience,
      exp: Math.floor(Date.now() / 1000) + 300,
    })}.`;
    await expect(verifyCloudflareAccessToken(unsecured, configuration, keySet)).rejects.toThrow();
  });

  it("requires a complete, HTTPS cloudflareaccess.com configuration", () => {
    expect(cloudflareAccessConfigured(env())).toBe(true);
    const missingAudience = env();
    delete missingAudience.CLOUDFLARE_ACCESS_AUD;
    expect(cloudflareAccessConfigured(missingAudience)).toBe(false);
    const missingOwner = env();
    delete missingOwner.CLOUDFLARE_ACCESS_OWNER_EMAIL;
    expect(cloudflareAccessConfigured(missingOwner)).toBe(false);
    expect(cloudflareAccessConfigured(env({ CLOUDFLARE_ACCESS_TEAM_DOMAIN: "http://example.cloudflareaccess.com" }))).toBe(false);
    expect(cloudflareAccessConfigured(env({ CLOUDFLARE_ACCESS_TEAM_DOMAIN: "https://example.com" }))).toBe(false);
    expect(cloudflareAccessConfigured(env({ CLOUDFLARE_ACCESS_TEAM_DOMAIN: "https://example.cloudflareaccess.com/path" }))).toBe(false);
  });
});
