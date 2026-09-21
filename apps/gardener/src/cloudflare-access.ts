import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { Env } from "./env";

export interface CloudflareAccessIdentity {
  subject: string;
  email: string;
  issuer: string;
}

export interface AccessConfiguration {
  issuer: string;
  audience: string;
  ownerEmail: string;
}

type TokenVerifier = (
  token: string,
  configuration: AccessConfiguration,
) => Promise<{ sub?: string; email?: string }>;

const remoteKeySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function accessConfiguration(env: Env): AccessConfiguration | null {
  const issuerValue = env.CLOUDFLARE_ACCESS_TEAM_DOMAIN?.trim();
  const audience = env.CLOUDFLARE_ACCESS_AUD?.trim();
  const ownerEmail = env.CLOUDFLARE_ACCESS_OWNER_EMAIL?.trim().toLowerCase();
  if (!issuerValue || !audience || !ownerEmail) return null;

  let issuer: URL;
  try {
    issuer = new URL(issuerValue);
  } catch {
    return null;
  }
  if (
    issuer.protocol !== "https:" ||
    issuer.username ||
    issuer.password ||
    issuer.search ||
    issuer.hash ||
    (issuer.pathname !== "/" && issuer.pathname !== "") ||
    !issuer.hostname.endsWith(".cloudflareaccess.com")
  ) return null;

  return { issuer: issuer.origin, audience, ownerEmail };
}

function remoteKeySet(configuration: AccessConfiguration): JWTVerifyGetKey {
  const certsUrl = `${configuration.issuer}/cdn-cgi/access/certs`;
  let keySet = remoteKeySets.get(certsUrl);
  if (!keySet) {
    keySet = createRemoteJWKSet(new URL(certsUrl));
    remoteKeySets.set(certsUrl, keySet);
  }
  return keySet;
}

export async function verifyCloudflareAccessToken(
  token: string,
  configuration: AccessConfiguration,
  keySet: JWTVerifyGetKey = remoteKeySet(configuration),
): Promise<{ sub?: string; email?: string }> {
  const result = await jwtVerify(token, keySet, {
    algorithms: ["RS256"],
    audience: configuration.audience,
    issuer: configuration.issuer,
  });
  const payload: { sub?: string; email?: string } = {};
  if (result.payload.sub) payload.sub = result.payload.sub;
  if (typeof result.payload.email === "string") payload.email = result.payload.email;
  return payload;
}

export function cloudflareAccessConfigured(env: Env): boolean {
  return accessConfiguration(env) !== null;
}

export function cloudflareAccessLogoutUrl(env: Env): string | null {
  const configuration = accessConfiguration(env);
  return configuration ? `${configuration.issuer}/cdn-cgi/access/logout` : null;
}

function accessTokenFromRequest(request: Request): string | null {
  const assertion = request.headers.get("cf-access-jwt-assertion")?.trim();
  if (assertion) return assertion;
  const cookies = request.headers.get("cookie");
  if (!cookies) return null;
  for (const part of cookies.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== "CF_Authorization") continue;
    return part.slice(separator + 1).trim() || null;
  }
  return null;
}

export async function verifyCloudflareAccessIdentity(
  request: Request,
  env: Env,
  verifier: TokenVerifier = verifyCloudflareAccessToken,
): Promise<CloudflareAccessIdentity | null> {
  const configuration = accessConfiguration(env);
  const token = accessTokenFromRequest(request);
  if (!configuration) return null;
  if (!token) return null;

  try {
    const payload = await verifier(token, configuration);
    const subject = payload.sub?.trim();
    const email = payload.email?.trim().toLowerCase();
    if (!subject || !email || email !== configuration.ownerEmail) return null;
    return { subject, email, issuer: configuration.issuer };
  } catch {
    return null;
  }
}
