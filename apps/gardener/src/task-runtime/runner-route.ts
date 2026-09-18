import type { Env } from "../env";

const SESSION_PATH = /^\/session\/([A-Za-z0-9][A-Za-z0-9_-]{0,159})$/;

export function matchRunnerSessionPath(pathname: string): string | null {
  return SESSION_PATH.exec(pathname)?.[1] ?? null;
}

export async function handleRunnerSessionRequest(request: Request, env: Env): Promise<Response> {
  const sessionId = matchRunnerSessionPath(new URL(request.url).pathname);
  if (!sessionId) return new Response("Not found", { status: 404 });
  const stub = env.RUNNER_SESSIONS.get(env.RUNNER_SESSIONS.idFromName(sessionId));
  const forwarded = new URL(request.url);
  forwarded.pathname = "/rpc";
  const headers = new Headers(request.headers);
  headers.set("x-gardener-session-id", sessionId);
  const init: RequestInit = { method: request.method, headers };
  if (request.method !== "GET" && request.method !== "HEAD") init.body = request.body;
  return stub.fetch(new Request(forwarded, init));
}
