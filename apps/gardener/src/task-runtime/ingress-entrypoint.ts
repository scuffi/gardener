import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "../env";
import { ensureDatabase } from "../database";
import { handleRunnerSessionRequest } from "./runner-route";

/** Service-binding-only bridge from the narrow public ingress Worker. */
export class GardenerRunnerIngressEntrypoint extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    await ensureDatabase(this.env.DB);
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true, service: "gardener-actions-runtime" });
    }
    return handleRunnerSessionRequest(request, this.env);
  }
}
