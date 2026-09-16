"use agent";

import type { ToolStep } from "@flue/runtime";
import {
  useAgentFinish,
  useAgentStart,
  useInitialData,
  useInstruction,
  useModel,
  useResponseFinish,
  useTool,
} from "@flue/runtime";
import { extend, type CloudflareAgentLike } from "@flue/runtime/cloudflare";
import type { CloudflareAIBinding } from "@flue/runtime/cloudflare/workers-ai";
import * as v from "valibot";
import { NarrowedHarnessToolFacade } from "../adapter";
import type { HarnessRequest, HarnessToolFacade, JsonValue } from "../types";
import { assertHarnessRequest, expectedHarnessBinding } from "../validation";
import { boundedCloudflareModel, installBoundedCloudflareProvider } from "./bounded-cloudflare-provider";
import { settleRunNonterminalEffects, submitGardenerOutput, validateNativeBinding } from "./terminal-tool";
import { emptyRunBudgetUsage } from "@gardener/core";
import { claimNativeTerminalInvocation, finalizeNativeRun, getRun, updateRunState } from "../../persistence";
import type { Env } from "../../env";
import {
  FLUE_NATIVE_DRIVER,
  FLUE_NATIVE_DURABILITY_TIMEOUT_MS,
  FLUE_NATIVE_TERMINAL_TOOL,
} from "../../flue-native-protocol";

export interface GardenerFlueInitialData {
  request: HarnessRequest;
}

export type GardenerFlueEnv = Omit<Env, "AI"> & {
  AI: CloudflareAIBinding;
  /** Trusted RPC binding; required only when a run has narrowed tools. */
  GARDENER_HARNESS_TOOLS?: HarnessToolFacade;
};

let toolFacade: HarnessToolFacade | undefined;
let gardenerEnv: GardenerFlueEnv | undefined;

/** Installed by the generated Flue Durable Object extension, never by agent source. */
export function installGardenerFlueToolFacade(facade: HarnessToolFacade | undefined): void {
  toolFacade = facade;
}

/**
 * The only Flue agent function Gardener deploys. User Agents are immutable
 * data delivered through initialData; they never generate another class.
 */
export function GardenerFlueAgent(): string {
  const initial = useInitialData<GardenerFlueInitialData>();
  assertHarnessRequest(initial?.request, expectedHarnessBinding("flue"));
  const request = initial.request;
  const narrowed = request.tools.length > 0
    ? new NarrowedHarnessToolFacade(request, requireToolFacade())
    : null;

  useModel(boundedCloudflareModel(request.model.id, request.budget), { compaction: false });
  useInstruction(renderContext(request));
  useAgentStart(async () => {
    const env = requireGardenerEnv();
    await validateNativeBinding(env as unknown as Env, request);
    const run = await getRun(env.DB, request.runId);
    if (!run || run.runtimeDriver !== FLUE_NATIVE_DRIVER || run.cancelRequestedAt) throw new Error("Native run cannot start");
    if (run.status === "queued" || run.status === "admitted") {
      await updateRunState(env.DB, { runId: run.id, expectedStatus: run.status, status: "running", usage: emptyRunBudgetUsage(), error: null });
    } else if (run.status !== "running" && run.status !== "completed" && run.status !== "completed_with_errors") {
      throw new Error(`Native run cannot start from ${run.status}`);
    }
  });
  useResponseFinish(({ response }) => ({
    gardenerHarnessUsage: {
      uncachedInputTokens: response.usage.input,
      cacheReadTokens: response.usage.cacheRead,
      cacheWriteTokens: response.usage.cacheWrite,
      outputTokens: response.usage.output,
      totalTokens: response.usage.totalTokens,
      turns: 1,
      toolCalls: response.toolCalls.length,
      model: request.model.id,
    },
  }));
  useInstruction(
    [
      "You have no authority to approve policy or directly mutate a provider.",
      "The listed tools are the complete workspace/observation capability set for this run.",
      "Do not claim a persistent effect occurred.",
      "This profile has exactly one model turn and no assistant-text completion protocol.",
      `Call ${FLUE_NATIVE_TERMINAL_TOOL} exactly once to abstain or propose the bounded issue comment.`,
    ].join("\n"),
  );

  useTool({
    name: FLUE_NATIVE_TERMINAL_TOOL,
    description: "Submit the one terminal Gardener output. This trusted host tool derives all authority and effect identifiers. Required fields: outcome and summary; issue_comment also requires proposal with kind, body, and rationale.",
    // Parse inside run so malformed model arguments terminate this one-turn
    // profile instead of becoming a Flue tool error that starts another turn.
    input: v.objectWithRest({}, v.unknown()),
    output: v.objectWithRest({}, v.unknown()),
    durable: true,
    async run({ data, step, toolCallId }) {
      return executeNativeTerminalInvocation(
        requireGardenerEnv() as unknown as Env,
        request,
        data,
        step,
        toolCallId,
      );
    },
  });
  useAgentFinish(async ({ response }) => {
    const terminal = response.toolCalls.filter((call) => call.tool === FLUE_NATIVE_TERMINAL_TOOL && !call.isError);
    if (terminal.length !== 1) throw new Error("flue_completed_without_terminal_output");
    assertNativeUsage(response.usage, response.toolCalls.length, request);
    const env = requireGardenerEnv();
    await settleRunNonterminalEffects(env as unknown as Env, request.runId, request.budget.deadlineAt);
    const run = await getRun(env.DB, request.runId);
    if (!run?.result) throw new Error("flue_completed_without_terminal_output");
    const effect = await env.DB.prepare("SELECT status FROM effects WHERE run_id=? ORDER BY created_at DESC LIMIT 1")
      .bind(run.id).first<{ status: string }>();
    const hasErrors = effect !== null && effect.status !== "executed";
    await finalizeNativeRun(env.DB, { runId: run.id, status: hasErrors ? "completed_with_errors" : "completed",
      usage: nativeUsage(response.usage, request.model.id, response.toolCalls.length),
      error: hasErrors ? { code: "effect_not_executed", message: "The exact effect did not execute successfully" } : null });
  });

  for (const descriptor of request.tools) {
    useTool({
      name: descriptor.name,
      description: descriptor.description,
      input: v.objectWithRest({}, v.unknown()),
      async run({ data, toolCallId }) {
        const output = await narrowed!.invoke({
          runId: request.runId,
          requestId: request.requestId,
          toolCallId,
          toolName: descriptor.name,
          input: normalizeJson(data),
        });
        return { output };
      },
    });
  }

  return request.prompt;
}

GardenerFlueAgent.agentName = "gardener-harness";
GardenerFlueAgent.initialData = v.object({ request: v.unknown() });
// Flue owns a small explicit recovery ceiling. Frozen model/tool limits remain host-enforced.
GardenerFlueAgent.durability = { maxAttempts: 3, timeoutMs: FLUE_NATIVE_DURABILITY_TIMEOUT_MS };

/**
 * Flue's Vite transform consumes this named extension and emits one static
 * Durable Object class. The environment binding remains outside model input.
 */
export const cloudflare = extend<CloudflareAgentLike, GardenerFlueEnv>({
  base(Base) {
    return class GardenerFlueBase extends Base {
      constructor(ctx: DurableObjectState, env: GardenerFlueEnv) {
        super(ctx, env);
        gardenerEnv = env;
        installBoundedCloudflareProvider(env.AI);
        installGardenerFlueToolFacade(env.GARDENER_HARNESS_TOOLS);
      }
    };
  },
});

export async function executeNativeTerminalInvocation(
  env: Env,
  request: HarnessRequest,
  data: unknown,
  step: ToolStep,
  toolCallId: string,
) {
  try {
    if (!await claimNativeTerminalInvocation(env.DB, request.runId, toolCallId)) {
      return {
        output: { committed: false, error: "terminal_invocation_already_claimed" },
        terminate: true,
      };
    }
    return await submitGardenerOutput(env, request, data, step);
  } catch {
    // D1 may have committed an effect before Flue recorded the durable step.
    // Best-effort repair here; Agent-finish or Cron repeats it before settling.
    try {
      await settleRunNonterminalEffects(env, request.runId, request.budget.deadlineAt);
    } catch { /* retain the terminating one-turn contract; reconciliation repairs */ }
    // Never expose D1, provider, event, or model content.
    return { output: { committed: false, error: "terminal_output_not_committed" }, terminate: true };
  }
}

function requireGardenerEnv(): GardenerFlueEnv {
  if (!gardenerEnv) throw new Error("Gardener Flue environment is unavailable");
  return gardenerEnv;
}

function nativeUsage(usage: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number }, model: string, toolCalls: number) {
  return { turns: 1, toolCalls, tasksCreated: 0, activeParallelTasks: 0,
    inputTokens: usage.input + usage.cacheRead + usage.cacheWrite, outputTokens: usage.output,
    costUsd: 0, operations: 0, artifactBytes: 0, runtimeSeconds: 0, model };
}

function assertNativeUsage(
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number },
  toolCalls: number,
  request: HarnessRequest,
): void {
  const input = usage.input + usage.cacheRead + usage.cacheWrite;
  if (input > request.budget.maxInputTokens || usage.output > request.budget.maxOutputTokens) {
    throw new Error("Gardener native model token budget was exceeded");
  }
  if (toolCalls > request.budget.maxToolCalls) {
    throw new Error("Gardener native tool-call budget was exceeded");
  }
}

function requireToolFacade(): HarnessToolFacade {
  if (!toolFacade) {
    throw new Error(
      "Gardener Flue tool facade is unavailable; build this module with @flue/vite and bind GARDENER_HARNESS_TOOLS",
    );
  }
  return toolFacade;
}

function renderContext(request: HarnessRequest): string {
  if (!request.context?.length) return "No additional context was supplied.";
  return request.context.map((item) => `<context name=${JSON.stringify(item.name)}>\n${item.content}\n</context>`).join("\n\n");
}

function normalizeJson(value: unknown): JsonValue {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
