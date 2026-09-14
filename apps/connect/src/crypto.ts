import { exportJWK, importPKCS8, importSPKI, jwtVerify, SignJWT, type JWTPayload } from "jose";
import type { Env } from "./env";
import { normalizeGitHubAppPrivateKey } from "./github";
import { identityAssertionSchema } from "./schema";

const encoder = new TextEncoder();
const signingKeys = new Map<string, Promise<CryptoKey>>();
const verifyKeys = new Map<string, Promise<CryptoKey>>();
const encryptionKeys = new Map<string, Promise<CryptoKey>>();

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function randomToken(prefix = ""): string {
  return prefix + bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid encryption key encoding");
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "="));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function accessEncryptionKey(value: string): Promise<CryptoKey> {
  let key = encryptionKeys.get(value);
  if (!key) {
    const bytes = base64UrlToBytes(value);
    if (bytes.byteLength !== 32) throw new Error("Access credential encryption key must be 32 bytes");
    key = crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
    encryptionKeys.set(value, key);
  }
  return key;
}

function accessAdditionalData(instanceId: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(`gardener:cloudflare-access:${instanceId}:v1`);
}

export async function encryptAccessCredentials(
  encryptionKey: string,
  instanceId: string,
  credentials: { clientId: string; clientSecret: string },
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = encoder.encode(JSON.stringify(credentials));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: accessAdditionalData(instanceId) },
    await accessEncryptionKey(encryptionKey),
    plaintext,
  );
  return `v1.${bytesToBase64Url(iv)}.${bytesToBase64Url(new Uint8Array(ciphertext))}`;
}

export async function decryptAccessCredentials(
  encryptionKey: string,
  instanceId: string,
  encrypted: string,
): Promise<{ clientId: string; clientSecret: string }> {
  const [version, encodedIv, encodedCiphertext, extra] = encrypted.split(".");
  if (version !== "v1" || !encodedIv || !encodedCiphertext || extra) throw new Error("Invalid encrypted Access credentials");
  const iv = base64UrlToBytes(encodedIv);
  if (iv.byteLength !== 12) throw new Error("Invalid encrypted Access credentials");
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv, additionalData: accessAdditionalData(instanceId) },
    await accessEncryptionKey(encryptionKey),
    base64UrlToBytes(encodedCiphertext),
  );
  const parsed: unknown = JSON.parse(new TextDecoder().decode(plaintext));
  if (!parsed || typeof parsed !== "object" || typeof (parsed as Record<string, unknown>).clientId !== "string" || typeof (parsed as Record<string, unknown>).clientSecret !== "string") {
    throw new Error("Invalid encrypted Access credentials");
  }
  return parsed as { clientId: string; clientSecret: string };
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

export async function signIdentityAssertion(
  env: Env,
  payload: { sub: string; instanceId: string; githubLogin: string; instanceOwner: boolean },
): Promise<string> {
  const claims = identityAssertionSchema.parse({
    typ: "gardener-identity",
    ...payload,
    jti: randomToken("identity_"),
  });
  return signToken(env, claims, claims.instanceId, 28_800);
}

export async function signGitHubAppJwt(env: Env): Promise<string> {
  const key = await importPKCS8(normalizeGitHubAppPrivateKey(env.GITHUB_APP_PRIVATE_KEY), "RS256");
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({}).setProtectedHeader({ alg: "RS256", typ: "JWT" }).setIssuer(env.GITHUB_APP_ID)
    .setIssuedAt(now - 60).setExpirationTime(now + 540).sign(key);
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
