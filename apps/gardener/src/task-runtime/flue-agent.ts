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
  useDataWriter,
  useInitialData,
  useInstruction,
  useModel,
  useResponseFinish,
  useTool,
} from "@flue/runtime";
import { extend, type CloudflareAgentLike } from "@flue/runtime/cloudflare";
import type { CloudflareAIBinding } from "@flue/runtime/cloudflare/workers-ai";
import * as v from "valibot";
import { NarrowedHarnessToolFacade } from "../harness/adapter";
import type { Env } from "../env";
import type { HarnessRequest, HarnessToolFacade, JsonValue } from "../harness/types";
import { assertHarnessRequest, expectedHarnessBinding } from "../harness/validation";
import { boundedCloudflareModel, installBoundedCloudflareProvider } from "../harness/flue/bounded-cloudflare-provider";
import { RunnerSessionToolFacade } from "./runner-tool-facade";

const TASK_TERMINAL_TOOL = "finish_task";
const inspectOnlyTerminalSchema = v.strictObject({
  inspectionComplete: v.literal(true),
  summary: v.pipe(v.string(), v.minLength(1), v.maxLength(32_000)),
  commentBody: v.pipe(v.string(), v.minLength(1), v.maxLength(65_536)),
});
const taskToolInputSchema = v.objectWithRest({
  path: v.optional(v.string()),
  maxEntries: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(2_000))),
  command: v.optional(v.string()),
  cwd: v.optional(v.string()),
  timeoutMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  maxOutputBytes: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
}, v.unknown());
const taskToolOutputSchema = v.strictObject({
  content: v.string(),
});

export interface GardenerTaskFlueInitialData {
  request: HarnessRequest;
}

type TaskFlueEnv = Omit<Env, "AI"> & {
  AI: CloudflareAIBinding;
  GARDENER_HARNESS_TOOLS?: HarnessToolFacade;
};

let taskToolFacade: HarnessToolFacade | undefined;

/** Installed by the generated Flue Durable Object extension, never by task source or model input. */
export function installGardenerTaskToolFacade(facade: HarnessToolFacade | undefined): void {
  taskToolFacade = facade;
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
  const maxRepositoryToolCalls = Math.max(1, Math.min(2, request.budget.maxToolCalls - 1));
  const writeTaskOutcome = useDataWriter("taskOutcome");

  useModel(boundedCloudflareModel(request.model.id, request.budget), { compaction: false });
  useInstruction(renderContext(request));
  useInstruction([
    "Execute the immutable task instructions using only the listed repository tools.",
    "Call repository tools when evidence is required; their results are canonical durable context for later turns.",
    `Use exactly ${maxRepositoryToolCalls} successful repository tool calls: list files once, then read one relevant file.`,
    `Immediately after the first successful read, call ${TASK_TERMINAL_TOOL}.`,
    "Call tools one at a time. Never issue parallel or additional repository tool calls.",
    "The listed tools are the complete capability set.",
    "The comment is only a proposal; a separate trusted effects job posts it exactly.",
    `Call ${TASK_TERMINAL_TOOL} exactly once with a concise summary and complete Markdown commentBody.`,
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
    description: "Required final step immediately after one list and one read. Set inspectionComplete to true, then submit a concise summary and complete Markdown issue comment body.",
    input: inspectOnlyTerminalSchema,
    output: v.object({ accepted: v.boolean() }),
    async run({ data }) {
      const eventItem = request.context?.find((item) => item.name === "normalized-event-v1");
      const event = normalizedEventV1Schema.parse(JSON.parse(eventItem?.content ?? "null"));
      if (event.kind !== "github.issue.opened") throw new Error("Issue triage requires an opened issue event");
      const observations = [taskObservationV1Schema.parse({
        kind: "repository",
        summary: "Canonical repository inspection completed before terminal settlement",
        paths: [],
      })];
      const operationId = `op_${await canonicalSha256({ runId: request.runId, kind: "issue.comment.create", issueNumber: event.issue.number, body: data.commentBody })}`;
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
          body: data.commentBody,
          rationale: "Model-proposed comment based on canonical repository tool results.",
        }],
      }) as TaskOutcomeV1;
      console.log("gardener task terminal accepted", { taskId });
      writeTaskOutcome(outcome);
      return { output: { accepted: true }, terminate: true };
    },
  });

  for (const descriptor of request.tools) {
    useTool({
      name: descriptor.name,
      description: descriptor.description,
      input: taskToolInputSchema,
      output: taskToolOutputSchema,
      durable: true,
      async run({ data, toolCallId }) {
        const output = await narrowed!.invoke({
          runId: request.runId,
          requestId: request.requestId,
          toolCallId,
          toolName: descriptor.name,
          input: normalizeJson(data),
        });
        console.log("gardener task repository tool completed", { taskId, tool: descriptor.name });
        return { output: taskToolModelOutput(output) };
      },
    });
  }

  useAgentFinish(({ response }) => {
    console.log("gardener task finish evaluation", {
      taskId,
      tools: response.toolCalls.map((call) => ({ tool: call.tool, isError: call.isError })),
    });
    const successful = response.toolCalls.filter((call) => !call.isError).map((call) => call.tool);
    if (!successful.includes("repository_list_files") || !successful.includes("repository_read_file")) {
      throw new Error("task_completed_without_canonical_repository_evidence");
    }
    const terminal = response.toolCalls.filter((call) => call.tool === TASK_TERMINAL_TOOL && !call.isError);
    if (terminal.length === 0) throw new Error("task_completed_without_terminal_outcome");
    if (terminal.length !== 1) throw new Error("task_has_multiple_terminal_outcomes");
    if (response.toolCalls.length > request.budget.maxToolCalls) throw new Error("task_tool_budget_exceeded");
    const inputTokens = response.usage.input + response.usage.cacheRead + response.usage.cacheWrite;
    if (inputTokens > request.budget.maxInputTokens || response.usage.output > request.budget.maxOutputTokens) {
      throw new Error("task_model_token_budget_exceeded");
    }
  });

  return [
    request.prompt,
    "",
    "Execution protocol:",
    "1. Call repository_list_files once.",
    "2. Call repository_read_file once for the most relevant listed file.",
    `3. Your next and final action MUST be ${TASK_TERMINAL_TOOL} with inspectionComplete=true, summary, and commentBody.`,
    "Never return the final response as assistant text.",
  ].join("\n");
}

GardenerTaskFlueAgent.agentName = "gardener-task-harness";
GardenerTaskFlueAgent.initialData = v.object({ request: v.unknown() });
GardenerTaskFlueAgent.durability = { maxAttempts: 3, timeoutMs: 300_000 };

export const cloudflare = extend<CloudflareAgentLike, TaskFlueEnv>({
  base(Base) {
    return class GardenerTaskFlueBase extends Base {
      constructor(ctx: DurableObjectState, env: TaskFlueEnv) {
        super(ctx, env);
        taskToolFacade = env.GARDENER_HARNESS_TOOLS ?? new RunnerSessionToolFacade(env.RUNNER_SESSIONS);
        installBoundedCloudflareProvider(env.AI);
      }
    };
  },
});

function requireTaskToolFacade(): HarnessToolFacade {
  if (!taskToolFacade) throw new Error("Task runner tool facade is unavailable");
  return taskToolFacade;
}

function renderContext(request: HarnessRequest): string {
  if (!request.context?.length) return "No untrusted event context was supplied.";
  return request.context.map((item) => `<untrusted-context name=${JSON.stringify(item.name)}>\n${item.content}\n</untrusted-context>`).join("\n\n");
}

function taskToolModelOutput(value: unknown): v.InferOutput<typeof taskToolOutputSchema> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Repository tool returned an invalid result");
  }
  const result = value as Record<string, unknown>;
  if (result.status !== "completed" || typeof result.stdout !== "string" || typeof result.stderr !== "string") {
    throw new Error(`Repository tool did not complete: ${String(result.status ?? "unknown")}`);
  }
  return { content: result.stdout || result.stderr || "Repository tool completed with no output." };
}

function normalizeJson(value: unknown): JsonValue {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
