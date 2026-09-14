import { createRemoteJWKSet, importSPKI, jwtVerify, type JWTPayload } from "jose";
import { z } from "zod";
import { repositoryEventV2Schema, type RepositoryEventV2 } from "./domain";
import { cloudflareAccessCredentials, instanceId, type Env } from "./env";

const keyCache = new Map<string, Promise<CryptoKey>>();
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function publicKey(env: Env): Promise<CryptoKey> {
  const pem = env.CONNECT_PUBLIC_KEY?.replace(/\\n/g, "\n");
  if (!pem) throw new Error("Connect public key is not configured");
  const algorithm = env.CONNECT_JWT_ALG || "RS256";
  let pending = keyCache.get(`${algorithm}:${pem}`);
  if (!pending) {
    pending = importSPKI(pem, algorithm);
    keyCache.set(`${algorithm}:${pem}`, pending);
  }
  return pending;
}

function remoteKey(env: Env): ReturnType<typeof createRemoteJWKSet> {
  const url = new URL("/.well-known/jwks.json", env.CONNECT_URL).toString();
  let key = jwksCache.get(url);
  if (!key) {
    const access = cloudflareAccessCredentials(env);
    key = createRemoteJWKSet(new URL(url), access ? {
      headers: {
        "CF-Access-Client-Id": access.clientId,
        "CF-Access-Client-Secret": access.clientSecret,
      },
    } : undefined);
    jwksCache.set(url, key);
  }
  return key;
}

async function verify(token: string, env: Env): Promise<JWTPayload> {
  const key = env.CONNECT_PUBLIC_KEY ? await publicKey(env) : remoteKey(env);
  const { payload } = await jwtVerify(token, key, {
    issuer: env.CONNECT_ISSUER,
    audience: instanceId(env),
    algorithms: [env.CONNECT_JWT_ALG || "RS256"],
  });
  return payload;
}

const verifiedIdentityAssertionSchema = z.object({
  typ: z.literal("gardener-identity"),
  sub: z.string().regex(/^[1-9][0-9]{0,31}$/),
  instanceId: z.string().min(1).max(128),
  githubLogin: z.string().min(1).max(39),
  instanceOwner: z.boolean(),
  jti: z.string().min(16).max(128),
  iss: z.string().url(),
  aud: z.union([z.string(), z.array(z.string())]),
  iat: z.number().int().nonnegative(),
  exp: z.number().int().positive(),
}).strict();
export type VerifiedIdentityAssertion = z.infer<typeof verifiedIdentityAssertionSchema>;

export async function verifyIdentityToken(token: string, env: Env): Promise<VerifiedIdentityAssertion> {
  const payload = await verify(token, env);
  const assertion = verifiedIdentityAssertionSchema.parse(payload);
  if (assertion.instanceId !== instanceId(env)) throw new Error("Identity instance mismatch");
  return assertion;
}

export async function verifyEventToken(token: string, env: Env): Promise<RepositoryEventV2> {
  const payload = await verify(token, env);
  if (payload.typ !== "gardener-event") throw new Error("Invalid event token");
  const event = repositoryEventV2Schema.parse(payload.event);
  if (event.instanceId !== instanceId(env)) throw new Error("Event instance mismatch");
  return event;
}

export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1] ?? null;
}
