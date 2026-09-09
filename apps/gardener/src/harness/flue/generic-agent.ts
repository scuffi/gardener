"use agent";

import {
  useInitialData,
  useInstruction,
  useModel,
  useResponseFinish,
  useTool,
} from "@flue/runtime";
import { extend, type CloudflareAgentLike } from "@flue/runtime/cloudflare";
import * as v from "valibot";
import { NarrowedHarnessToolFacade } from "../adapter";
import type { HarnessRequest, HarnessToolFacade, JsonValue } from "../types";
import { assertHarnessRequest, expectedHarnessBinding } from "../validation";

export interface GardenerFlueInitialData {
  request: HarnessRequest;
}

export interface GardenerFlueEnv {
  /** Trusted RPC binding; it exposes only the tools narrowed for this run. */
  GARDENER_HARNESS_TOOLS: HarnessToolFacade;
}

let toolFacade: HarnessToolFacade | undefined;

/** Installed by the generated Flue Durable Object extension, never by agent source. */
export function installGardenerFlueToolFacade(facade: HarnessToolFacade): void {
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
  const narrowed = new NarrowedHarnessToolFacade(request, requireToolFacade());

  useModel(toFlueCloudflareModel(request.model.id), { compaction: false });
  useInstruction(renderContext(request));
  useResponseFinish(({ response }) => ({
    gardenerHarnessUsage: {
      inputTokens: response.usage.input,
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
      "Do not claim a persistent effect occurred. Return proposals only as data for Gardener to validate.",
      "Your final response must be one JSON object with either:",
      '{"status":"completed","result":{"kind":"result|abstain","summary":"...","data":null}}, or',
      '{"status":"interrupted","interruption":{"kind":"capability|human-input","reason":"..."}}.',
    ].join("\n"),
  );

  for (const descriptor of request.tools) {
    useTool({
      name: descriptor.name,
      description: descriptor.description,
      input: v.objectWithRest({}, v.unknown()),
      async run({ data, toolCallId }) {
        const output = await narrowed.invoke({
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

/**
 * Flue's Vite transform consumes this named extension and emits one static
 * Durable Object class. The environment binding remains outside model input.
 */
export const cloudflare = extend<CloudflareAgentLike, GardenerFlueEnv>({
  base(Base) {
    return class GardenerFlueBase extends Base {
      constructor(ctx: DurableObjectState, env: GardenerFlueEnv) {
        super(ctx, env);
        installGardenerFlueToolFacade(env.GARDENER_HARNESS_TOOLS);
      }
    };
  },
});

function requireToolFacade(): HarnessToolFacade {
  if (!toolFacade) {
    throw new Error(
      "Gardener Flue tool facade is unavailable; build this module with @flue/vite and bind GARDENER_HARNESS_TOOLS",
    );
  }
  return toolFacade;
}

function toFlueCloudflareModel(model: string): string {
  return model.startsWith("cloudflare/") ? model : `cloudflare/${model}`;
}

function renderContext(request: HarnessRequest): string {
  if (!request.context?.length) return "No additional context was supplied.";
  return request.context.map((item) => `<context name=${JSON.stringify(item.name)}>\n${item.content}\n</context>`).join("\n\n");
}

function normalizeJson(value: unknown): JsonValue {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
