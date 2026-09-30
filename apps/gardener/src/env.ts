import type { TaskRunnerSession } from "./task-runtime/session";

/** Bindings for the single public Gardener runtime Worker. */
export interface Env {
  DB: D1Database;
  AI: Ai;
  RUNNER_SESSIONS: DurableObjectNamespace<TaskRunnerSession>;
  /**
   * The task workflow ref of the Gardener release this Worker was deployed
   * from. A sync from that release's workflow is accepted even before the
   * repository's enrollment has moved to it.
   */
  GARDENER_RELEASE_WORKFLOW_REF?: string;
  /**
   * An external AI Gateway for non-Workers-AI models, set by `gardener deploy`.
   * The token is a Worker secret; the rest are plain vars. Without them every
   * model goes through the `AI` binding.
   */
  GARDENER_AI_GATEWAY_ACCOUNT_ID?: string;
  GARDENER_AI_GATEWAY_ID?: string;
  GARDENER_AI_GATEWAY_PROJECT?: string;
  GARDENER_AI_GATEWAY_TOKEN?: string;
}
