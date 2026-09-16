import type { Env } from "./env";

export async function authorizeOperator(request: Request, env: Env): Promise<boolean> {
  const header = request.headers.get("authorization");
  const token = header?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token || !env.GATEWAY_OPERATOR_TOKEN) return false;
  const left = new TextEncoder().encode(token);
  const right = new TextEncoder().encode(env.GATEWAY_OPERATOR_TOKEN);
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index++) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}
