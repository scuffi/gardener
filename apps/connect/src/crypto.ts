import { exportJWK, importPKCS8, importSPKI, jwtVerify, SignJWT, type JWTPayload } from "jose";
import type { Env } from "./env";

const encoder = new TextEncoder();
const signingKeys = new Map<string, Promise<CryptoKey>>();
const verifyKeys = new Map<string, Promise<CryptoKey>>();

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function randomToken(prefix = ""): string {
  return prefix + bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

function privateKey(env: Env): Promise<CryptoKey> {
  const pem = env.CONNECT_JWT_PRIVATE_KEY.replace(/\\n/g, "\n");
  let key = signingKeys.get(pem);
  if (!key) { key = importPKCS8(pem, "RS256"); signingKeys.set(pem, key); }
  return key;
}
function publicKey(env: Env): Promise<CryptoKey> {
  const pem = env.CONNECT_JWT_PUBLIC_KEY.replace(/\\n/g, "\n");
  let key = verifyKeys.get(pem);
  if (!key) { key = importSPKI(pem, "RS256"); verifyKeys.set(pem, key); }
  return key;
}

export async function signToken(env: Env, payload: JWTPayload, audience: string, ttlSeconds: number): Promise<string> {
  return new SignJWT(payload).setProtectedHeader({ alg: "RS256", typ: "JWT", kid: env.CONNECT_JWT_KID })
    .setIssuer(env.CONNECT_ISSUER).setAudience(audience).setIssuedAt().setExpirationTime(`${ttlSeconds}s`).sign(await privateKey(env));
}

export async function verifyToken(env: Env, token: string, audience: string): Promise<JWTPayload> {
  const result = await jwtVerify(token, await publicKey(env), { issuer: env.CONNECT_ISSUER, audience, algorithms: ["RS256"] });
  return result.payload;
}

export async function jwks(env: Env): Promise<{ keys: Array<Record<string, unknown>> }> {
  const key = await exportJWK(await publicKey(env));
  return { keys: [{ ...key, kid: env.CONNECT_JWT_KID, alg: "RS256", use: "sig" }] };
}

export async function verifyWebhookSignature(secret: string, body: string, header: string | null): Promise<boolean> {
  if (!header?.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  const expected = `sha256=${Array.from(new Uint8Array(signature), (b) => b.toString(16).padStart(2, "0")).join("")}`;
  return constantTimeEqual(expected, header.toLowerCase());
}

export function bearer(header: string | undefined): string | null {
  const match = header ? /^Bearer\s+(.+)$/i.exec(header) : null;
  return match?.[1] ?? null;
}
