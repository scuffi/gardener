interface Env {
  GARDENER: { fetch(request: Request): Promise<Response> };
}

const SESSION_PATH = /^\/session\/[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") {
      try {
        const runtime = await env.GARDENER.fetch(new Request("https://gardener.internal/health"));
        const body = runtime.ok ? await runtime.json() as { ok?: unknown } : null;
        return Response.json({
          ok: body?.ok === true,
          service: "gardener-runner-ingress",
          runtime: body?.ok === true,
        }, { status: body?.ok === true ? 200 : 503 });
      } catch {
        return Response.json({ ok: false, service: "gardener-runner-ingress", runtime: false }, { status: 503 });
      }
    }
    if (!SESSION_PATH.test(url.pathname)) return new Response("Not found", { status: 404 });
    return env.GARDENER.fetch(request);
  },
} satisfies ExportedHandler<Env>;
