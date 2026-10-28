import { z } from "zod";

/**
 * The declarable effect that starts another task of the same repository. Like
 * `message.send` it is not an operation: it compiles to the plan's `taskRuns`,
 * never to a step with an operation id, and it writes nothing to the
 * repository. Apply dispatches the target's own Gardener workflow with
 * `actions: write`, which only tasks declaring it are granted.
 *
 * Nothing in it is free text. The model names a declared task and a subject
 * number, and every other part of the dispatch (the workflow file, the ref,
 * the one input) is built by trusted code, because every task workflow's
 * dispatch form also takes a 20,000-character `prompt` that reaches the model.
 */
export const TASK_RUN_KIND = "task.run" as const;
export type TaskRunKind = typeof TASK_RUN_KIND;

/**
 * The deepest a chain of started runs may go. A run started by a person or an
 * event is depth 0; a run at this depth may not propose `task.run`. The
 * Worker reads depth from its own lineage record, never from the dispatch.
 */
export const TASK_RUN_MAX_DEPTH = 3;

/** The most targets one task may declare for `task.run`. */
export const TASK_RUN_MAX_TARGETS = 20;

/** The bundle's task id pattern, so a target names exactly what a task may be called. */
const taskIdPattern = /^[a-z0-9](?:[a-z0-9._-]{0,158}[a-z0-9])?$/;
export const taskRunTargetV1Schema = z.string().regex(taskIdPattern, "expected a task id");

/**
 * The file name stem of a task's generated workflow. One rule for the CLI,
 * which writes the file, and the Worker, which names it in a plan, so the two
 * cannot disagree about which workflow a task is.
 */
export function workflowSlug(taskId: string): string {
  return taskId.replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
}

/** The repository path of a task's generated workflow. */
export function taskWorkflowPath(taskId: string): string {
  return `.github/workflows/gardener-${workflowSlug(taskId)}.yml`;
}

/**
 * Every path a `task.run` may dispatch. Apply checks it again before calling
 * the API, together with the exact path `taskWorkflowPath` gives the plan's
 * task id; the pattern is the shape check that would still hold if a path ever
 * came from somewhere other than that function.
 */
export const TASK_WORKFLOW_PATH_PATTERN = /^\.github\/workflows\/gardener-[a-z0-9][a-z0-9-]*\.ya?ml$/;

const subjectNumber = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

/**
 * The payload the model proposes for `task.run`: the task to start and its
 * subject, which must be this run's own issue or pull request. A pull request
 * this plan opens is named by reference instead (`/pullNumber` from an earlier
 * `pull_request.open`), so the payload then omits `pullNumber`. Strict: no
 * inputs, prompt, ref or anything else, ever.
 */
export const taskRunPayloadV1Schema = z.strictObject({
  task: taskRunTargetV1Schema.describe("The id of a task this task declares under task.run. Never this task itself."),
  issueNumber: subjectNumber.optional().describe("This run's own issue. Give exactly one of issueNumber and pullNumber."),
  pullNumber: subjectNumber.optional().describe(
    "This run's own pull request, or omit it and fill /pullNumber by reference from an earlier pull_request.open step of this plan.",
  ),
});
export type TaskRunPayloadV1 = z.infer<typeof taskRunPayloadV1Schema>;

/** Compact JSON Schema for the `task.run` payload, stated in the trusted prompt. */
export function taskRunPayloadJsonSchema(): string {
  const schema = z.toJSONSchema(taskRunPayloadV1Schema, { unrepresentable: "any" }) as Record<string, unknown>;
  delete schema.$schema;
  return JSON.stringify(schema);
}
