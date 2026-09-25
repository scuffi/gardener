"use agent";

import {
  captureDeferredPointers,
  taskEffectKindValues,
  taskObservationV1Schema,
  taskOutcomeV1Schema,
  type TaskEffectProposalV1,
  type TaskOutcomeV1,
} from "@gardener/contracts";
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
import { taskToolInputSchema } from "./tool-input-schemas";
import type { Env } from "../env";
import type { HarnessRequest, JsonValue } from "../harness/types";
import { assertHarnessRequest, expectedHarnessBinding } from "../harness/validation";
import { boundedCloudflareModel, installBoundedCloudflareProvider } from "../harness/flue/bounded-cloudflare-provider";
import { RunnerSessionToolFacade, type TaskRuntimeFacade } from "./runner-tool-facade";

const TASK_TERMINAL_TOOL = "finish_task";
const TASK_PROPOSE_TOOL = "propose_effect";

/**
 * Flat, all-scalar proposal input.
 *
 * Twenty-nine operation kinds cannot be expressed as a discriminated union in
 * a tool schema that every provider renders faithfully: a 29-arm `oneOf` is
 * where small models stop emitting valid tool calls at all. `kind` is a flat
 * enumeration of the same 29 values, which renders as a plain string with an
 * `enum` list and costs the model nothing, while the payload crosses as a
 * JSON *string* that trusted host code parses and the session validates
 * against the real contract. The wire shape stays flat and every server-side
 * check is unchanged: the enum narrows typos, it does not grant authority.
 */
const proposeEffectSchema = v.strictObject({
  stepName: v.pipe(v.string(), v.minLength(1), v.maxLength(63)),
  kind: v.picklist(taskEffectKindValues),
  payloadJson: v.pipe(v.string(), v.minLength(2), v.maxLength(1_024 * 1_024)),
  referencesJson: v.optional(v.pipe(v.string(), v.maxLength(16 * 1_024))),
  rationale: v.pipe(v.string(), v.minLength(1), v.maxLength(5_000)),
});

/**
 * Terminal input. Proposals are already durable in the session by the time
 * this runs, so the terminal carries none of them: a model that re-listed its
 * own steps here could contradict what it actually proposed.
 */
const finishTaskSchema = v.strictObject({
  summary: v.pipe(v.string(), v.minLength(1), v.maxLength(32_000)),
  observationsJson: v.optional(v.pipe(v.string(), v.maxLength(256 * 1_024))),
});

const taskToolOutputSchema = v.strictObject({
  content: v.string(),
});

export interface GardenerTaskFlueInitialData {
  request: HarnessRequest;
}

type TaskFlueEnv = Omit<Env, "AI"> & {
  AI: CloudflareAIBinding;
  GARDENER_HARNESS_TOOLS?: TaskRuntimeFacade;
};

let taskToolFacade: TaskRuntimeFacade | undefined;

/** Installed by the generated Flue Durable Object extension, never by task source or model input. */
export function installGardenerTaskToolFacade(facade: TaskRuntimeFacade | undefined): void {
  taskToolFacade = facade;
}

/**
 * Canonical planning Flue harness.
 *
 * It proposes an ordered plan and can apply nothing: every proposal is
 * recorded durably in the session, re-checked against the admitted bundle's
 * effect allowlist, and handed to a separate trusted job that holds the only
 * write-capable token.
 */
export function GardenerTaskFlueAgent(): string {
  const initial = useInitialData<GardenerTaskFlueInitialData>();
  assertHarnessRequest(initial?.request, expectedHarnessBinding("flue"));
  const request = initial.request;
  if (!request.snapshot.agentRevisionId.startsWith("task:")) throw new Error("Task harness received a non-task request");
  const taskId = request.snapshot.agentRevisionId.slice("task:".length);
  if (!taskId) throw new Error("Task harness task identity is missing");
  const facade = requireTaskToolFacade();
  const narrowed = request.tools.length > 0 ? new NarrowedHarnessToolFacade(request, facade) : null;
  const writeTaskOutcome = useDataWriter("taskOutcome");
  // Flue 2.0.3 configures pi-agent-core for parallel tool execution and does
  // not expose pi's per-tool executionMode. Queue every Gardener tool here so
  // model-emitted parallel calls execute in transcript order. The session's
  // durable capture barrier remains the authoritative cross-replay control.
  let toolExecutionTail: Promise<void> = Promise.resolve();
  const sequentialTool = <T>(run: () => Promise<T>): Promise<T> => {
    const next = toolExecutionTail.then(run, run);
    toolExecutionTail = next.then(() => undefined, () => undefined);
    return next;
  };

  useModel(boundedCloudflareModel(request.model.id, request.budget), { compaction: false });
  useInstruction(renderContext(request));
  useInstruction([
    "Execute the immutable task instructions using only the listed tools.",
    "Gather evidence first. Tool results are canonical durable context for later turns.",
    `Then call ${TASK_PROPOSE_TOOL} once per change you want made, in the order you want them applied.`,
    "Propose nothing you cannot justify from evidence. Proposing zero effects is a valid, normal outcome.",
    "A proposal is only a request. A separate trusted job applies the plan exactly as ordered; you never apply anything.",
    `Finally call ${TASK_TERMINAL_TOOL} exactly once with a concise summary.`,
    "Call tools one at a time. Never issue parallel tool calls.",
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
    name: TASK_PROPOSE_TOOL,
    description: [
      "Propose one change, appended to the end of the ordered plan. Call it once per change; calling it does not finish the task.",
      "kind: one of the declared effect kinds listed in your instructions. Any other kind is refused.",
      "payloadJson: a JSON object string with that kind's fields only. Never include schemaVersion, id, kind, or repository; Gardener binds those.",
      "For commit.create, omit files: Gardener commits the exact working tree you changed on the runner, and a files value is refused.",
      "referencesJson: optional JSON object keyed by payload JSON pointer, for values an earlier step will produce.",
      "To fill a whole field, map its pointer to {\"step\":\"earlier-step\",\"output\":\"name\"}.",
      "To put such values inside text you write, such as a comment body, write {{name}} in the text and map its pointer to {\"placeholders\":{\"name\":{\"step\":\"earlier-step\",\"output\":\"name\"}}}; every {{name}} is replaced when the step runs.",
      "stepName: short lowercase name, unique in this plan, used to reference this step later.",
    ].join(" "),
    input: proposeEffectSchema,
    output: v.strictObject({
      accepted: v.boolean(),
      stepName: v.string(),
      position: v.number(),
      totalProposed: v.number(),
      alreadyProposed: v.boolean(),
    }),
    // Durable so a replayed turn is served from the journal. The session is
    // still idempotent by content digest, so a retry that does re-run the
    // handler appends nothing.
    durable: true,
    async run({ data, toolCallId }) {
      return sequentialTool(async () => {
        const acknowledgement = await (async () => {
          try {
            return await facade.proposeEffect({
              runId: request.runId,
              requestId: request.requestId,
              toolCallId,
              proposal: {
                stepName: data.stepName,
                kind: data.kind,
                payload: parseJsonObject(data.payloadJson, "payloadJson"),
                references: data.referencesJson === undefined || data.referencesJson.trim() === ""
                  ? {}
                  : parseJsonObject(data.referencesJson, "referencesJson"),
                rationale: data.rationale,
              },
            });
          } catch (error) {
            // Do not log payloadJson (it is model-authored and may contain issue
            // or repository content). The validator message and field paths are
            // enough to diagnose a rejected proposal during live qualification.
            console.warn("gardener task effect rejected", {
              taskId,
              stepName: data.stepName,
              kind: data.kind,
              error: (error instanceof Error ? error.message : String(error)).slice(0, 4_000),
            });
            throw error;
          }
        })();
        console.log("gardener task effect proposed", { taskId, stepName: acknowledgement.stepName, kind: data.kind });
        return {
          output: {
            accepted: true,
            stepName: acknowledgement.stepName,
            position: acknowledgement.index + 1,
            totalProposed: acknowledgement.totalProposed,
            alreadyProposed: acknowledgement.duplicate,
          },
        };
      });
    },
  });

  useTool({
    name: TASK_TERMINAL_TOOL,
    description: [
      "Required final step. Call it exactly once, after every propose_effect call you intend to make.",
      "summary: concise prose describing what you found and what you proposed.",
      "observationsJson: optional JSON array of {kind,summary,paths?} where kind is repository, event, test, or diagnostic.",
    ].join(" "),
    input: finishTaskSchema,
    output: v.strictObject({ accepted: v.boolean(), proposedEffects: v.number(), capturedFiles: v.number() }),
    async run({ data, toolCallId }) {
      return sequentialTool(async () => {
      // Read back from the durable session rather than from anything the
      // model repeated here, so the outcome carries exactly the steps that
      // passed the allowlist, ordering, and budget checks.
      let proposedEffects = await facade.listProposals(request.runId);
      // The capture is taken here, from the durable ledger, and nowhere else.
      //
      // It is not a tool: a model that could call it would choose *when* the
      // photograph of the working tree is taken, and could take one and then
      // keep editing. Deriving the need from proposals that are already
      // durable means the decision is made by trusted code after the model's
      // last turn, and this handler terminates immediately afterwards, so no
      // further shell command can run between the capture and the commit it
      // fills.
      const capture = capturedSteps(proposedEffects).length > 0
        ? await facade.captureRepository({ runId: request.runId, requestId: request.requestId, toolCallId })
        : undefined;
      if (capture !== undefined) {
        // Capture admission commits the durable barrier before taking its own
        // ledger snapshot. Read that now-stable ledger again so this terminal
        // cannot omit a proposal admitted by another replay just before the
        // barrier won the transaction race.
        proposedEffects = await facade.listProposals(request.runId);
      }
      const outcome = taskOutcomeV1Schema.parse({
        schemaVersion: "gardener.task-outcome/v1",
        runId: request.runId,
        taskId,
        bundleHash: request.snapshot.agentRevisionHash,
        status: "completed",
        summary: data.summary,
        observations: parseObservations(data.observationsJson),
        proposedEffects,
      }) as TaskOutcomeV1;
      console.log("gardener task terminal accepted", {
        taskId,
        proposedEffects: proposedEffects.length,
        ...(capture === undefined ? {} : { captureId: capture.captureId, capturedFiles: capture.fileCount }),
      });
      writeTaskOutcome(outcome);
      return {
        output: { accepted: true, proposedEffects: proposedEffects.length, capturedFiles: capture?.fileCount ?? 0 },
        terminate: true,
      };
      });
    },
  });

  for (const descriptor of request.tools) {
    useTool({
      name: descriptor.name,
      description: descriptor.description,
      input: taskToolInputSchema(descriptor.name),
      output: taskToolOutputSchema,
      durable: true,
      async run({ data, toolCallId }) {
        return sequentialTool(async () => {
          try {
            const output = await narrowed!.invoke({
              runId: request.runId,
              requestId: request.requestId,
              toolCallId,
              toolName: descriptor.name,
              input: normalizeJson(data),
            });
            const modelOutput = taskToolModelOutput(output);
            console.log("gardener task repository tool completed", { taskId, tool: descriptor.name });
            return { output: modelOutput };
          } catch (error) {
            // The model sees this as a failed tool call and may retry, spending
            // turns. Log it so a run that runs out of turns can be explained.
            // Inputs are never logged; the message is truncated.
            console.warn("gardener task repository tool failed", {
              taskId,
              tool: descriptor.name,
              error: error instanceof Error ? error.message.slice(0, 300) : "non-error rejection",
            });
            throw error;
          }
        });
      },
    });
  }

  useAgentFinish(({ response }) => {
    const inputTokens = response.usage.input + response.usage.cacheRead + response.usage.cacheWrite;
    const terminal = response.toolCalls.filter((call) => call.tool === TASK_TERMINAL_TOOL && !call.isError);
    console.log("gardener task finish evaluation", {
      taskId,
      tools: response.toolCalls.map((call) => ({ tool: call.tool, isError: call.isError })),
      terminalCalls: terminal.length,
      inputTokens,
      outputTokens: response.usage.output,
      budget: {
        maxToolCalls: request.budget.maxToolCalls,
        maxInputTokens: request.budget.maxInputTokens,
        maxOutputTokens: request.budget.maxOutputTokens,
      },
    });
    const refuse: (reason: string) => never = (reason) => {
      console.warn("gardener task finish refused", { taskId, reason });
      throw new Error(reason);
    };
    // There is deliberately no required-evidence check here. A task may
    // declare only `provider.api.read`, or no tools at all, and a run that
    // legitimately proposes nothing is a normal outcome, so demanding a
    // particular repository call would fail correct tasks.
    if (terminal.length === 0) refuse("task_completed_without_terminal_outcome");
    if (terminal.length !== 1) refuse("task_has_multiple_terminal_outcomes");
    if (response.toolCalls.length > request.budget.maxToolCalls) refuse("task_tool_budget_exceeded");
    // `input-tokens` bounds each request's context, which the bounded provider
    // enforces before every call; summing it across turns would count the
    // resent conversation again on every turn. `output-tokens` is a whole-run
    // budget, also enforced by the provider; this is the backstop.
    if (response.usage.output > request.budget.maxOutputTokens) refuse("task_model_token_budget_exceeded");
  });

  return [
    request.prompt,
    "",
    "Execution protocol:",
    "1. Use the listed tools to gather the exact evidence the task needs.",
    `2. Call ${TASK_PROPOSE_TOOL} once per intended change, in application order. Propose none if none is warranted.`,
    `3. Your final action MUST be ${TASK_TERMINAL_TOOL} with a summary.`,
    "Never return the final response as assistant text.",
  ].join("\n");
}

GardenerTaskFlueAgent.agentName = "gardener-task-harness";
GardenerTaskFlueAgent.initialData = v.object({ request: v.unknown() });
/**
 * The longest runtime a task bundle may declare (`limits.runtimeSeconds` in
 * the contract). Flue's durability timeout is static per agent, so it is set
 * past the longest possible run; each run's own deadline is enforced by
 * Gardener (the bounded provider, the session's read signal and `runTask`).
 * A shorter value here cut off valid runs: it was once 5 minutes while tasks
 * could run for 8.
 */
export const MAX_TASK_RUNTIME_SECONDS = 3_600;
GardenerTaskFlueAgent.durability = { maxAttempts: 3, timeoutMs: (MAX_TASK_RUNTIME_SECONDS + 60) * 1_000 };

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

function requireTaskToolFacade(): TaskRuntimeFacade {
  if (!taskToolFacade) throw new Error("Task runner tool facade is unavailable");
  return taskToolFacade;
}

/** Proposed steps whose contents the trusted capture owns, never the model. */
function capturedSteps(proposals: readonly TaskEffectProposalV1[]): readonly TaskEffectProposalV1[] {
  return proposals.filter((proposal) => captureDeferredPointers(proposal.kind).length > 0);
}

/**
 * Parses a model-supplied JSON object string.
 *
 * Only a plain object is accepted: the contract's payload and reference
 * schemas are both records, and allowing an array or scalar here would turn a
 * malformed proposal into a confusing schema error two layers down.
 */
function parseJsonObject(value: string, field: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${field} is not valid JSON`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${field} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

/** Parses optional model observations against the canonical bounded contract. */
function parseObservations(value: string | undefined): unknown[] {
  if (value === undefined || value.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("observationsJson is not valid JSON");
  }
  if (!Array.isArray(parsed)) throw new Error("observationsJson must be a JSON array");
  return parsed.map((entry) => taskObservationV1Schema.parse(entry));
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
