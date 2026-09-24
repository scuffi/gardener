import {
  operationCatalog,
  operationKindValues,
  taskBundleV1Schema,
  taskToolV1Schema,
  taskTriggerKindValues,
  triggerKindOrder,
  type TaskBundleV1,
  type TaskEffectKindV1,
  type TaskTriggerKindV1,
  type TaskTriggerV1,
} from "@gardener/contracts";
import { canonicalJson, canonicalSha256 } from "@gardener/core";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const safeLabel = z.string().trim().min(1).max(100).regex(
  /^[A-Za-z0-9][A-Za-z0-9._ -]{0,99}$/,
  "labels may contain only letters, numbers, spaces, dots, underscores, and hyphens",
);

const OPERATION_FAMILY_BY_KIND = new Map(operationCatalog.map((entry) => [entry.kind, entry.family]));
const OPERATION_FAMILY_VALUES = [...new Set(operationCatalog.map((entry) => entry.family))].sort();

/** Authoring shorthand that expands to every exact operation kind in one family. */
export const effectFamilyGlobValues = OPERATION_FAMILY_VALUES.map((family) => `${family}.*`) as [string, ...string[]];

const effectSelectorSchema = z.union([
  z.enum(operationKindValues),
  z.enum(effectFamilyGlobValues),
]);

const PUSH_TRIGGER = "github.push";
const SCHEDULE_TRIGGER = "github.schedule";
const DISPATCH_TRIGGER = "github.workflow_dispatch";

const triggerAuthoringSchema = z.strictObject({
  event: z.enum(taskTriggerKindValues),
  "labels-all": z.array(safeLabel).max(20).optional(),
  branches: z.array(z.string().trim().min(1).max(255)).min(1).max(20).optional(),
  cron: z.string().trim().min(1).max(100).optional(),
}).superRefine((trigger, context) => {
  const reject = (key: "labels-all" | "branches" | "cron") => {
    if (trigger[key] !== undefined) {
      context.addIssue({ code: "custom", path: [key], message: `${key} is not supported by ${trigger.event}` });
    }
  };
  const require = (key: "branches" | "cron") => {
    if (trigger[key] === undefined) {
      context.addIssue({ code: "custom", path: [key], message: `${key} is required by ${trigger.event}` });
    }
  };
  if (trigger.event === PUSH_TRIGGER) {
    require("branches");
    reject("labels-all");
    reject("cron");
    return;
  }
  if (trigger.event === SCHEDULE_TRIGGER) {
    require("cron");
    reject("labels-all");
    reject("branches");
    return;
  }
  if (trigger.event === DISPATCH_TRIGGER) {
    reject("labels-all");
    reject("branches");
    reject("cron");
    return;
  }
  reject("branches");
  reject("cron");
});

const authoringSchema = z.strictObject({
  schema: z.literal("gardener.task/v1"),
  id: z.string().regex(/^[a-z0-9](?:[a-z0-9._-]{0,158}[a-z0-9])?$/),
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().min(1).max(1_000),
  trigger: triggerAuthoringSchema.optional(),
  triggers: z.array(triggerAuthoringSchema).min(1).max(taskTriggerKindValues.length).optional(),
  draft: z.boolean().optional(),
  tools: z.array(taskToolV1Schema).min(1).max(taskToolV1Schema.options.length),
  effects: z.array(effectSelectorSchema).max(operationKindValues.length + effectFamilyGlobValues.length).default([]),
  network: z.strictObject({
    default: z.enum(["deny", "allow"]),
    allow: z.array(z.string()),
    deny: z.array(z.string()),
  }),
  limits: z.strictObject({
    "runtime-seconds": z.number().int().positive().max(3_600),
    "max-turns": z.number().int().positive().max(32),
    "max-tool-calls": z.number().int().positive().max(256),
    "input-tokens": z.number().int().positive().max(1_000_000),
    "output-tokens": z.number().int().positive().max(250_000),
    "max-effect-operations": z.number().int().positive().max(1_000).optional(),
    "max-effect-bytes": z.number().int().min(1_024).max(50_000_000).optional(),
  }),
}).superRefine((authoring, context) => {
  if ((authoring.trigger === undefined) === (authoring.triggers === undefined)) {
    context.addIssue({
      code: "custom",
      path: ["triggers"],
      message: "declare exactly one of trigger or triggers",
    });
  }
  if (new Set(authoring.tools).size !== authoring.tools.length) {
    context.addIssue({ code: "custom", path: ["tools"], message: "tools must be unique" });
  }
  if (new Set(authoring.effects).size !== authoring.effects.length) {
    context.addIssue({ code: "custom", path: ["effects"], message: "effect selectors must be unique" });
  }
});

export interface CompiledTask {
  bundle: TaskBundleV1;
  bundleHash: string;
  canonicalBundle: string;
}

/** Deterministic expansion of exact kinds and family globs into the canonical allowlist. */
export function expandEffectSelectors(selectors: readonly string[]): TaskEffectKindV1[] {
  const exact = new Set<string>();
  const families = new Set<string>();
  for (const selector of selectors) {
    if (selector.endsWith(".*")) families.add(selector.slice(0, -".*".length));
    else exact.add(selector);
  }
  return operationKindValues.filter(
    (kind) => exact.has(kind) || families.has(OPERATION_FAMILY_BY_KIND.get(kind)!),
  );
}

type AuthoredTrigger = z.output<typeof triggerAuthoringSchema>;

function toContractTrigger(authored: AuthoredTrigger): TaskTriggerV1 {
  const kind = authored.event as TaskTriggerKindV1;
  if (kind === PUSH_TRIGGER) return { kind, branches: authored.branches! };
  if (kind === SCHEDULE_TRIGGER) return { kind, cron: authored.cron! };
  if (kind === DISPATCH_TRIGGER) return { kind };
  return { kind, labelsAll: authored["labels-all"] ?? [] } as TaskTriggerV1;
}

export async function compileTaskSource(source: string, sourceName = "TASK.md"): Promise<CompiledTask> {
  const normalized = source.replaceAll("\r\n", "\n");
  if (!normalized.startsWith("---\n")) {
    throw new Error(`${sourceName} must begin with YAML frontmatter`);
  }
  const boundary = normalized.indexOf("\n---\n", 4);
  if (boundary < 0) throw new Error(`${sourceName} has no closing YAML frontmatter delimiter`);

  let parsed: unknown;
  try {
    parsed = parseYaml(normalized.slice(4, boundary), { uniqueKeys: true });
  } catch (error) {
    throw new Error(`${sourceName} has invalid YAML: ${error instanceof Error ? error.message : "parse failed"}`);
  }
  const authoring = authoringSchema.parse(parsed);
  const instructions = normalized.slice(boundary + 5).trim();
  if (!instructions) throw new Error(`${sourceName} must contain task instructions after frontmatter`);

  // Triggers are emitted in canonical order so the bundle hash and generated
  // workflow do not depend on the order the author happened to list them in.
  // Every task can be run by hand, so the manual trigger is always compiled in.
  const declaredTriggers = authoring.triggers ?? [authoring.trigger!];
  const manual: AuthoredTrigger = { event: DISPATCH_TRIGGER };
  const withManual: AuthoredTrigger[] = declaredTriggers.some((trigger) => trigger.event === DISPATCH_TRIGGER)
    ? declaredTriggers
    : [...declaredTriggers, manual];
  const authoredTriggers = [...withManual].sort(
    (left, right) => triggerKindOrder.get(left.event as TaskTriggerKindV1)!
      - triggerKindOrder.get(right.event as TaskTriggerKindV1)!,
  );
  const bundle = taskBundleV1Schema.parse({
    schemaVersion: "gardener.task-bundle/v1",
    taskId: authoring.id,
    name: authoring.name,
    description: authoring.description,
    instructions,
    triggers: authoredTriggers.map(toContractTrigger),
    tools: authoring.tools,
    effects: expandEffectSelectors(authoring.effects),
    network: authoring.network,
    limits: {
      runtimeSeconds: authoring.limits["runtime-seconds"],
      maxTurns: authoring.limits["max-turns"],
      maxToolCalls: authoring.limits["max-tool-calls"],
      inputTokens: authoring.limits["input-tokens"],
      outputTokens: authoring.limits["output-tokens"],
      maxEffectOperations: authoring.limits["max-effect-operations"],
      maxEffectBytes: authoring.limits["max-effect-bytes"],
    },
    ...(authoring.draft === true ? { draft: true } : {}),
  });
  return {
    bundle,
    bundleHash: await canonicalSha256(bundle),
    canonicalBundle: canonicalJson(bundle),
  };
}
