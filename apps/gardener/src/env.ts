import type { TaskRunnerSession } from "./task-runtime/session";

/** Bindings for the single public Gardener runtime Worker. */
export interface Env {
  DB: D1Database;
  AI: Ai;
  AI_MODEL: string;
  RUNNER_SESSIONS: DurableObjectNamespace<TaskRunnerSession>;
}
