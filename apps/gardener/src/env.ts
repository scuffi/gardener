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
}
