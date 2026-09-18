interface Env {
  GARDENER: { fetch(request: Request): Promise<Response> };
}

const SESSION_PATH = /^\/session\/[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") {
      return Response.json({ ok: true, service: "gardener-runner-ingress" });
    }
    if (!SESSION_PATH.test(url.pathname)) return new Response("Not found", { status: 404 });
    return env.GARDENER.fetch(request);
  },
} satisfies ExportedHandler<Env>;
