export interface Env {
  DB: D1Database;
  RUN_QUEUE: Queue;
  AI: Ai;
  ASSETS: Fetcher;
  AI_MODEL: string;
  CONNECT_ISSUER: string;
  CONNECT_URL: string;
  CONNECT_PUBLIC_KEY?: string;
  GARDENER_INSTANCE_TOKEN: string;
  LOCAL_DEV_BYPASS?: string;
  CONNECT_JWT_ALG?: string;
}

/** The bootstrap token carries its non-secret instance id, keeping deployment to one copied secret. */
export function instanceId(env: Pick<Env, "GARDENER_INSTANCE_TOKEN">): string {
  const match = /^gdn_([A-Za-z0-9_-]{3,100})\.[A-Za-z0-9_-]{20,}$/.exec(env.GARDENER_INSTANCE_TOKEN);
  if (!match?.[1]) throw new Error("Invalid Gardener instance token");
  return match[1];
}
