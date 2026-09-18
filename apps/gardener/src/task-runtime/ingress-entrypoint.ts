import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "../env";
import { ensureDatabase } from "../database";
import { handleRunnerSessionRequest } from "./runner-route";

/** Service-binding-only bridge from the narrow public ingress Worker. */
export class GardenerRunnerIngressEntrypoint extends WorkerEntrypoint<Env> {
  async openRunnerSession(request: Request): Promise<Response> {
    await ensureDatabase(this.env.DB);
    return handleRunnerSessionRequest(request, this.env);
  }
}
