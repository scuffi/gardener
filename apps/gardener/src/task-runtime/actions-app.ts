import type { Env } from "../env";
import { handleRunnerSessionRequest } from "./runner-route";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true, service: "gardener-runtime" });
    }
    if (url.pathname.startsWith("/session/")) return handleRunnerSessionRequest(request, env);
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
