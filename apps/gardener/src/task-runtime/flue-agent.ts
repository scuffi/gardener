"use agent";

import {
  normalizedEventV1Schema,
  taskObservationV1Schema,
  taskOutcomeV1Schema,
  type TaskOutcomeV1,
} from "@gardener/contracts";
import { canonicalSha256 } from "@gardener/core";
import {
  useAgentFinish,
  useInitialData,
  useInstruction,
  useModel,
  usePersistentState,
  useResponseFinish,
  useTool,
} from "@flue/runtime";
import { extend, type CloudflareAgentLike } from "@flue/runtime/cloudflare";
import type { CloudflareAIBinding } from "@flue/runtime/cloudflare/workers-ai";
import * as v from "valibot";
import type { Env } from "../env";
import { NarrowedHarnessToolFacade } from "../harness/adapter";
import type { HarnessRequest, HarnessToolFacade, JsonValue } from "../harness/types";
import { assertHarnessRequest, expectedHarnessBinding } from "../harness/validation";
import { boundedCloudflareModel, installBoundedCloudflareProvider } from "../harness/flue/bounded-cloudflare-provider";
import { RunnerSessionToolFacade } from "./runner-tool-facade";

const TASK_TERMINAL_TOOL = "submit_task_outcome_v1";
const inspectOnlyTerminalSchema = v.strictObject({
  summary: v.pipe(v.string(), v.minLength(1), v.maxLength(32_000)),
  observations: v.pipe(v.array(v.strictObject({
    kind: v.picklist(["repository", "event", "test", "diagnostic"]),
    summary: v.pipe(v.string(), v.minLength(1), v.maxLength(8_000)),
    paths: v.pipe(v.array(v.string()), v.maxLength(100)),
  })), v.maxLength(200)),
  comment: v.strictObject({
    body: v.pipe(v.string(), v.minLength(1), v.maxLength(65_536)),
    rationale: v.pipe(v.string(), v.minLength(1), v.maxLength(5_000)),
  }),
});

export interface GardenerTaskFlueInitialData {
  request: HarnessRequest;
}

type TaskFlueEnv = Omit<Env, "AI"> & {
  AI: CloudflareAIBinding;
  GARDENER_HARNESS_TOOLS?: HarnessToolFacade;
};

let taskDatabase: D1Database | undefined;
let taskToolFacade: HarnessToolFacade | undefined;

/** Installed by the generated Flue Durable Object extension, never by task source or model input. */
export function installGardenerTaskToolFacade(facade: HarnessToolFacade | undefined): void {
  taskToolFacade = facade;
}

export function installGardenerTaskDatabase(database: D1Database | undefined): void {
  taskDatabase = database;
}

/**
 * Canonical inspect-only Flue harness. It is a separate durable identity from
 * the historical effectful agent and cannot represent a provider mutation.
 */
export function GardenerTaskFlueAgent(): string {
  const initial = useInitialData<GardenerTaskFlueInitialData>();
  assertHarnessRequest(initial?.request, expectedHarnessBinding("flue"));
  const request = initial.request;
  if (!request.snapshot.agentRevisionId.startsWith("task:")) throw new Error("Task harness received a non-task request");
  const taskId = request.snapshot.agentRevisionId.slice("task:".length);
  if (!taskId) throw new Error("Task harness task identity is missing");
  const narrowed = request.tools.length > 0
    ? new NarrowedHarnessToolFacade(request, requireTaskToolFacade())
    : null;
  const [completedRunnerTools, setCompletedRunnerTools] = usePersistentState("completedRunnerTools", 0);

  useModel(boundedCloudflareModel(request.model.id, request.budget), { compaction: false });
  useInstruction(renderContext(request));
  useInstruction([
    "This task triages one opened issue and proposes one comment.",
    "Repository inspection has already been performed by trusted host code through the runner and is supplied as repository-inspection-v1 context.",
    "The listed tools are the complete remaining capability set.",
    "The comment is only a proposal; a separate trusted effects job posts it exactly.",
    `Call ${TASK_TERMINAL_TOOL} exactly once with summary, observations, and comment.`,
    "Do not return the outcome as assistant text.",
  ].join("\n"));
  useResponseFinish(({ response }) => ({
    gardenerTaskUsage: {
      inputTokens: response.usage.input + response.usage.cacheRead + response.usage.cacheWrite,
      outputTokens: response.usage.output,
      totalTokens: response.usage.totalTokens,
      turns: 1,
      toolCalls: response.toolCalls.length,
      model: request.model.id,
    },
  }));

  useTool({
    name: TASK_TERMINAL_TOOL,
    description: "Submit the triage summary, repository observations, and one proposed issue comment.",
    input: inspectOnlyTerminalSchema,
    output: v.object({ accepted: v.boolean() }),
    async run({ data }) {
      const trustedInspection = request.context?.some((item) => item.name === "repository-inspection-v1");
      if (completedRunnerTools < 1 && !trustedInspection) throw new Error("Issue triage requires evidence from a completed runner tool");
      const eventItem = request.context?.find((item) => item.name === "normalized-event-v1");
      const event = normalizedEventV1Schema.parse(JSON.parse(eventItem?.content ?? "null"));
      if (event.kind !== "github.issue.opened") throw new Error("Issue triage requires an opened issue event");
      const observations = data.observations.map((observation) => taskObservationV1Schema.parse(observation));
      const operationId = `op_${await canonicalSha256({ runId: request.runId, kind: "issue.comment.create", issueNumber: event.issue.number, body: data.comment.body })}`;
      const outcome = taskOutcomeV1Schema.parse({
        schemaVersion: "gardener.task-outcome/v1",
        runId: request.runId,
        taskId,
        bundleHash: request.snapshot.agentRevisionHash,
        status: "completed",
        summary: data.summary,
        observations,
        proposedEffects: [{
          operationId,
          kind: "issue.comment.create",
          issueNumber: event.issue.number,
          body: data.comment.body,
          rationale: data.comment.rationale,
        }],
      }) as TaskOutcomeV1;
      await requireTaskEnv().DB.prepare(
        "UPDATE actions_task_runs SET outcome_json=?,status='completed',updated_at=CURRENT_TIMESTAMP WHERE id=?",
      ).bind(JSON.stringify(outcome), request.runId).run();
      return { output: { accepted: true }, terminate: true };
    },
  });

  for (const descriptor of request.tools) {
    useTool({
      name: descriptor.name,
      description: descriptor.description,
      input: v.objectWithRest({}, v.unknown()),
      output: v.objectWithRest({}, v.unknown()),
      durable: true,
      async run({ data, toolCallId, step }) {
        const output = await step.do("runner-operation-v1", () => narrowed!.invoke({
          runId: request.runId,
          requestId: request.requestId,
          toolCallId,
          toolName: descriptor.name,
          input: normalizeJson(data),
        }));
        setCompletedRunnerTools((count) => count + 1);
        return { output };
      },
    });
  }

  useAgentFinish(({ response }) => {
    const terminal = response.toolCalls.filter((call) => call.tool === TASK_TERMINAL_TOOL && !call.isError);
    if (terminal.length !== 1) throw new Error("task_completed_without_terminal_outcome");
    if (response.toolCalls.length > request.budget.maxToolCalls) throw new Error("task_tool_budget_exceeded");
    const inputTokens = response.usage.input + response.usage.cacheRead + response.usage.cacheWrite;
    if (inputTokens > request.budget.maxInputTokens || response.usage.output > request.budget.maxOutputTokens) {
      throw new Error("task_model_token_budget_exceeded");
    }
  });

  return request.prompt;
}

GardenerTaskFlueAgent.agentName = "gardener-task-harness";
GardenerTaskFlueAgent.initialData = v.object({ request: v.unknown() });
GardenerTaskFlueAgent.durability = { maxAttempts: 3, timeoutMs: 300_000 };

export const cloudflare = extend<CloudflareAgentLike, TaskFlueEnv>({
  base(Base) {
    return class GardenerTaskFlueBase extends Base {
      constructor(ctx: DurableObjectState, env: TaskFlueEnv) {
        super(ctx, env);
        taskDatabase = env.DB;
        taskToolFacade = env.GARDENER_HARNESS_TOOLS ?? new RunnerSessionToolFacade(env.RUNNER_SESSIONS);
        installBoundedCloudflareProvider(env.AI);
      }
    };
  },
});

function requireTaskEnv(): Pick<TaskFlueEnv, "DB"> {
  if (!taskDatabase) throw new Error("Task Flue environment is unavailable");
  return { DB: taskDatabase };
}

function requireTaskToolFacade(): HarnessToolFacade {
  if (!taskToolFacade) throw new Error("Task runner tool facade is unavailable");
  return taskToolFacade;
}

function renderContext(request: HarnessRequest): string {
  if (!request.context?.length) return "No untrusted event context was supplied.";
  return request.context.map((item) => `<untrusted-context name=${JSON.stringify(item.name)}>\n${item.content}\n</untrusted-context>`).join("\n\n");
}

function normalizeJson(value: unknown): JsonValue {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
