import {
  branchPatternsSchema,
  branchWriteKinds,
  authoredTriggerSubject,
  defaultTriggerAuthors,
  taskFilterLoginV1Schema,
  type TaskAuthorsFilterV1,
  githubHandleV1Schema,
  isAuthoredTriggerKind,
  MESSAGE_SEND_KIND,
  operationCatalog,
  runLimitIssue,
  taskBundleV1Schema,
  taskEffectKindValues,
  taskModelIdSchema,
  taskToolV1Schema,
  taskTriggerKindValues,
  triggerKindOrder,
  type TaskBundleV1,
  type TaskEffectKindV1,
  type TaskTriggerKindV1,
  type TaskTriggerV1,
  TASK_RUNTIME_SECONDS_MAX,
} from "@gardener/contracts";
import { canonicalJson, canonicalSha256 } from "@gardener/core";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const safeLabel = z.string().trim().min(1).max(100).regex(
  /^[A-Za-z0-9][A-Za-z0-9._ -]{0,99}$/,
  "labels may contain only letters, numbers, spaces, dots, underscores, and hyphens",
);

const OPERATION_FAMILY_BY_KIND: ReadonlyMap<string, string> = new Map(operationCatalog.map((entry) => [entry.kind, entry.family]));
const OPERATION_FAMILY_VALUES = [...new Set(operationCatalog.map((entry) => entry.family))].sort();

/**
 * Authoring shorthand that expands to every exact operation kind in one family.
 * `message.send` is not an operation and has no family, so `message.*` is not a
 * glob: it must be named exactly.
 */
export const effectFamilyGlobValues = OPERATION_FAMILY_VALUES.map((family) => `${family}.*`) as [string, ...string[]];

const effectSelectorSchema = z.union([
  z.enum(taskEffectKindValues),
  z.enum(effectFamilyGlobValues),
]);

/** An exact branch-writing kind with the branches it may write to. */
const effectWithOptionsSchema = z.strictObject({
  kind: z.enum(branchWriteKinds as [string, ...string[]]),
  branches: branchPatternsSchema,
});

const effectEntrySchema = z.union([effectSelectorSchema, effectWithOptionsSchema]);
type EffectEntry = z.infer<typeof effectEntrySchema>;

function effectSelector(entry: EffectEntry): string {
  return typeof entry === "string" ? entry : entry.kind;
}

const PUSH_TRIGGER = "github.push";
const SCHEDULE_TRIGGER = "github.schedule";
const DISPATCH_TRIGGER = "github.workflow_dispatch";

const triggerAuthoringSchema = z.strictObject({
  event: z.enum(taskTriggerKindValues),
  "labels-all": z.array(safeLabel).max(20).optional(),
  mentions: z.array(z.string().trim().min(1).max(40)).min(1).max(20).optional(),
  authors: z.union([
    z.enum(["maintainers", "any"]),
    z.array(z.string().trim().min(1).max(60)).min(1).max(20),
  ]).optional(),
  "opened-by": z.array(z.string().trim().min(1).max(60)).min(1).max(20).optional(),
  branches: z.array(z.string().trim().min(1).max(255)).min(1).max(20).optional(),
  cron: z.string().trim().min(1).max(100).optional(),
}).superRefine((trigger, context) => {
  const reject = (key: "labels-all" | "mentions" | "authors" | "opened-by" | "branches" | "cron") => {
    if (trigger[key] !== undefined) {
      context.addIssue({ code: "custom", path: [key], message: `${key} is not supported by ${trigger.event}` });
    }
  };
  const require = (key: "branches" | "cron") => {
    if (trigger[key] === undefined) {
      context.addIssue({ code: "custom", path: [key], message: `${key} is required by ${trigger.event}` });
    }
  };
  if (Array.isArray(trigger.authors)) {
    trigger.authors.forEach((entry, index) => {
      if (entry.toLowerCase() === "any") {
        context.addIssue({ code: "custom", path: ["authors", index], message: "any cannot be combined with other authors; write authors: any" });
      } else if (entry.toLowerCase() !== "maintainers" && !taskFilterLoginV1Schema.safeParse(entry.toLowerCase()).success) {
        context.addIssue({ code: "custom", path: ["authors", index], message: `${entry} is not maintainers or a GitHub login` });
      }
    });
  }
  trigger["opened-by"]?.forEach((entry, index) => {
    if (!taskFilterLoginV1Schema.safeParse(entry.toLowerCase()).success) {
      context.addIssue({ code: "custom", path: ["opened-by", index], message: `${entry} is not a GitHub login` });
    }
  });
  if (trigger["opened-by"] !== undefined && isAuthoredTriggerKind(trigger.event)
    && authoredTriggerSubject[trigger.event] !== "comment" && authoredTriggerSubject[trigger.event] !== "review") {
    // The text that triggers the run is the thread itself, so its author is
    // its opener; two different lists here could never both match.
    context.addIssue({
      code: "custom",
      path: ["opened-by"],
      message: `on ${trigger.event} the opener is the author; use authors`,
    });
  }
  if (trigger.event === PUSH_TRIGGER) {
    require("branches");
    reject("opened-by");
    reject("labels-all");
    reject("mentions");
    reject("authors");
    reject("cron");
    return;
  }
  if (trigger.event === SCHEDULE_TRIGGER) {
    require("cron");
    reject("opened-by");
    reject("labels-all");
    reject("mentions");
    reject("authors");
    reject("branches");
    return;
  }
  if (trigger.event === DISPATCH_TRIGGER) {
    reject("opened-by");
    reject("labels-all");
    reject("mentions");
    reject("authors");
    reject("branches");
    reject("cron");
    return;
  }
  reject("branches");
  reject("cron");
  if (!isAuthoredTriggerKind(trigger.event)) {
    reject("mentions");
    reject("authors");
  }
});

/** The model a task uses when its TASK.md names none. Written into the bundle. */
export const DEFAULT_TASK_MODEL = "@cf/zai-org/glm-5.3";

/**
 * Model id prefixes Flue's Cloudflare provider has a native request format
 * for. Any other id is sent as OpenAI-compatible chat completions, which may
 * not support the tool calls every task depends on.
 */
const NATIVE_MODEL_PREFIXES = ["@cf/", "anthropic/", "openai/"] as const;

/** A build warning for a model Gardener cannot vouch for, or undefined. */
export function modelWarning(model: string): string | undefined {
  if (NATIVE_MODEL_PREFIXES.some((prefix) => model.startsWith(prefix))) return undefined;
  return `uses model ${model}, which is sent to AI Gateway as OpenAI-compatible chat completions. `
    + "Gardener has only verified @cf/, anthropic/ and openai/ models; this one may fail if it cannot call tools.";
}

/** A run limit as written in TASK.md, checked with the contract's message under the authored name. */
function authoredRunLimit(field: "runs" | "runsPerAuthor", label: string) {
  return z.string().superRefine((value, context) => {
    const issue = runLimitIssue(value, field, label);
    if (issue !== undefined) context.addIssue({ code: "custom", message: issue });
  });
}

/**
 * Whether anyone but a maintainer can start this task, judged the way the
 * runtime judges who started a run. Only schedules and manual runs (both need
 * write access) and authored triggers limited to `authors: maintainers` keep
 * everyone else out. Everything else admits them: a push can be a bot's
 * (Dependabot's commits carry upstream release notes), a named login needn't
 * be a maintainer, a reopened issue can be its author's doing, triage can
 * label but reads as `read`, and a bot can move a pull request's head.
 */
export function admitsNonMaintainers(bundle: Pick<TaskBundleV1, "triggers">): boolean {
  return bundle.triggers.some((trigger) => {
    if (trigger.kind === SCHEDULE_TRIGGER || trigger.kind === DISPATCH_TRIGGER) return false;
    if (!("authors" in trigger)) return true;
    // Named logins needn't be maintainers, so only `maintainers` keeps outsiders out.
    return trigger.authors !== "maintainers";
  });
}

/**
 * A build warning for a task that outsiders can start and that declares a
 * high-impact effect, or undefined. Trigger scope confines where such a run
 * acts, not what it does: it can still merge or approve the outsider's own
 * pull request if the model is persuaded to.
 */
export function highImpactWarning(bundle: Pick<TaskBundleV1, "triggers" | "effects">): string | undefined {
  if (!admitsNonMaintainers(bundle)) return undefined;
  const kinds = bundle.effects.filter((kind) => operationCatalog.some((entry) => entry.kind === kind && entry.highImpact));
  if (kinds.length === 0) return undefined;
  return `declares ${kinds.join(", ")} and can be started by people who are not maintainers. `
    + "Their runs are confined to what triggered them, but the model can still be talked into these effects there: "
    + "an outsider's own pull request could be approved or merged, and a release reaches every user. "
    + "Restrict the triggers with authors: maintainers, or remove these effects.";
}

/**
 * Build warnings for a task that declares `message.send`: where the
 * destination comes from, what posting discloses, and, when outsiders can
 * start it, that they can cause posts. Empty for other tasks.
 */
export function messageWarnings(bundle: Pick<TaskBundleV1, "triggers" | "effects">): string[] {
  if (!(bundle.effects as readonly string[]).includes(MESSAGE_SEND_KIND)) return [];
  return [
    "declares message.send. Set the GARDENER_CHAT_WEBHOOK repository secret to a Google Chat or Slack incoming-webhook URL; "
      + "until it is set, runs skip the message and still succeed.",
    "declares message.send. In a private repository, each message shows the subject's title, link and author to everyone in the chat space.",
    ...(admitsNonMaintainers(bundle)
      ? ["declares message.send and can be started by people who are not maintainers, so they can cause posts about their own issues, pull requests or discussions. "
        + "The summary is checked and the link is Gardener's, but the subject's title is theirs. Restrict the triggers with authors: maintainers if that is not wanted."]
      : []),
  ];
}

const authoringSchema = z.strictObject({
  schema: z.literal("gardener.task/v1"),
  id: z.string().regex(/^[a-z0-9](?:[a-z0-9._-]{0,158}[a-z0-9])?$/),
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().min(1).max(1_000),
  trigger: triggerAuthoringSchema.optional(),
  triggers: z.array(triggerAuthoringSchema).min(1).max(taskTriggerKindValues.length).optional(),
  draft: z.boolean().optional(),
  checkout: z.enum(["provider", "pull-request-head"]).optional(),
  reactions: z.boolean().optional(),
  "effect-scope": z.literal("trigger").optional(),
  model: taskModelIdSchema.optional(),
  tools: z.array(taskToolV1Schema).min(1).max(taskToolV1Schema.options.length),
  effects: z.array(effectEntrySchema).max(taskEffectKindValues.length + effectFamilyGlobValues.length).default([]),
  network: z.strictObject({
    default: z.enum(["deny", "allow"]),
    allow: z.array(z.string()),
    deny: z.array(z.string()),
  }),
  limits: z.strictObject({
    "runtime-seconds": z.number().int().positive().max(TASK_RUNTIME_SECONDS_MAX),
    "max-turns": z.number().int().positive(),
    "max-tool-calls": z.number().int().positive(),
    "input-tokens": z.number().int().positive(),
    "output-tokens": z.number().int().positive(),
    "max-effect-operations": z.number().int().positive().max(1_000).optional(),
    "max-effect-bytes": z.number().int().min(1_024).max(50_000_000).optional(),
    runs: authoredRunLimit("runs", "limits.runs").optional(),
    "runs-per-author": authoredRunLimit("runsPerAuthor", "limits.runs-per-author").optional(),
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
  if (new Set(authoring.effects.map(effectSelector)).size !== authoring.effects.length) {
    context.addIssue({ code: "custom", path: ["effects"], message: "effect selectors must be unique" });
  }
});

export interface CompiledTask {
  bundle: TaskBundleV1;
  bundleHash: string;
  canonicalBundle: string;
}

/**
 * Options given on effect entries, as the bundle carries them. Patterns are
 * sorted so listing them in another order does not change the bundle hash.
 */
function effectOptionsOf(entries: readonly EffectEntry[]): { effectOptions?: TaskBundleV1["effectOptions"] } {
  const optioned = entries.flatMap((entry) => typeof entry === "string"
    ? []
    : [[entry.kind, { branches: [...entry.branches].sort() }] as const]);
  return optioned.length === 0 ? {} : { effectOptions: Object.fromEntries(optioned) as TaskBundleV1["effectOptions"] };
}

/** Deterministic expansion of exact kinds and family globs into the canonical allowlist. */
/**
 * Kinds a family glob includes only for tasks that declare a tool. A merge
 * commit needs the tool that prepares it, so `git.*` in a task without that
 * tool expands exactly as it did before the kind existed: same bundle, same
 * hash. Naming the kind exactly still works (and then needs the tool).
 */
const GLOB_KINDS_NEEDING_TOOL: ReadonlyMap<TaskEffectKindV1, string> = new Map([
  ["commit.merge_base", "repository.merge_base"],
]);

export function expandEffectSelectors(selectors: readonly string[], tools: readonly string[] = []): TaskEffectKindV1[] {
  const exact = new Set<string>();
  const families = new Set<string>();
  for (const selector of selectors) {
    if (selector.endsWith(".*")) families.add(selector.slice(0, -".*".length));
    else exact.add(selector);
  }
  // `message.send` has no operation family, so no glob selects it.
  const globbed = (kind: TaskEffectKindV1) => {
    const tool = GLOB_KINDS_NEEDING_TOOL.get(kind);
    const family = OPERATION_FAMILY_BY_KIND.get(kind);
    return family !== undefined && families.has(family) && (tool === undefined || tools.includes(tool));
  };
  return taskEffectKindValues.filter((kind) => exact.has(kind) || globbed(kind));
}

type AuthoredTrigger = z.output<typeof triggerAuthoringSchema>;

/** Options that come from `.gardener/gardener.json` rather than the task. */
export interface TaskCompileOptions {
  /** The project's own GitHub handle, which `mentions: [self]` resolves to. */
  handle?: string;
}

function toContractTrigger(authored: AuthoredTrigger, options: TaskCompileOptions, sourceName: string): TaskTriggerV1 {
  const kind = authored.event as TaskTriggerKindV1;
  if (kind === PUSH_TRIGGER) return { kind, branches: authored.branches! };
  if (kind === SCHEDULE_TRIGGER) return { kind, cron: authored.cron! };
  if (kind === DISPATCH_TRIGGER) return { kind };
  const labelsAll = authored["labels-all"] ?? [];
  const openedBy = authored["opened-by"] === undefined ? {} : { openedBy: normalizedLogins(authored["opened-by"]) };
  if (!isAuthoredTriggerKind(kind)) return { kind, labelsAll, ...openedBy } as TaskTriggerV1;
  const mentions = resolveMentions(authored.mentions ?? [], options, sourceName, kind);
  const authors = authored.authors === undefined ? defaultTriggerAuthors(kind, mentions) : normalizedAuthors(authored.authors);
  return { kind, labelsAll, mentions, authors, ...openedBy } as TaskTriggerV1;
}

/** Lower-cased, unique and sorted, so filters that mean the same hash the same. */
function normalizedLogins(entries: readonly string[]): string[] {
  return [...new Set(entries.map((entry) => entry.toLowerCase()))].sort();
}

/** A list of only `maintainers` is the scalar, so existing bundles are unchanged. */
function normalizedAuthors(authors: "maintainers" | "any" | readonly string[]): TaskAuthorsFilterV1 {
  if (!Array.isArray(authors)) return authors as "maintainers" | "any";
  const entries = normalizedLogins(authors);
  return entries.length === 1 && entries[0] === "maintainers" ? "maintainers" : entries as TaskAuthorsFilterV1;
}

/**
 * Lowercased handles without `@`, in the order written, with `self` replaced by
 * the project handle. A handle the contract would refuse fails the build here,
 * where the author can see which task and trigger it came from.
 */
function resolveMentions(written: readonly string[], options: TaskCompileOptions, sourceName: string, kind: string): string[] {
  const handles: string[] = [];
  for (const entry of written) {
    let handle = entry.startsWith("@") ? entry.slice(1) : entry;
    if (handle === "self") {
      if (options.handle === undefined) {
        throw new Error(`${sourceName} ${kind} mentions self, but .gardener/gardener.json sets no handle`);
      }
      handle = options.handle;
    }
    handle = handle.toLowerCase();
    if (!githubHandleV1Schema.safeParse(handle).success) {
      throw new Error(`${sourceName} ${kind} mentions ${entry}, which is not a GitHub handle`);
    }
    if (!handles.includes(handle)) handles.push(handle);
  }
  return handles;
}

export async function compileTaskSource(
  source: string,
  sourceName = "TASK.md",
  options: TaskCompileOptions = {},
): Promise<CompiledTask> {
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
    triggers: authoredTriggers.map((trigger) => toContractTrigger(trigger, options, sourceName)),
    tools: authoring.tools,
    effects: expandEffectSelectors(authoring.effects.map(effectSelector), authoring.tools),
    ...effectOptionsOf(authoring.effects),
    network: authoring.network,
    limits: {
      runtimeSeconds: authoring.limits["runtime-seconds"],
      maxTurns: authoring.limits["max-turns"],
      maxToolCalls: authoring.limits["max-tool-calls"],
      inputTokens: authoring.limits["input-tokens"],
      outputTokens: authoring.limits["output-tokens"],
      maxEffectOperations: authoring.limits["max-effect-operations"],
      maxEffectBytes: authoring.limits["max-effect-bytes"],
      // Absent stays absent: the Worker applies its defaults, so bundles that
      // set neither hash as before.
      ...(authoring.limits.runs === undefined ? {} : { runs: authoring.limits.runs }),
      ...(authoring.limits["runs-per-author"] === undefined ? {} : { runsPerAuthor: authoring.limits["runs-per-author"] }),
    },
    model: authoring.model ?? DEFAULT_TASK_MODEL,
    ...(authoring.checkout === "pull-request-head" ? { checkout: "pull-request-head" } : {}),
    ...(authoring.draft === true ? { draft: true } : {}),
    ...(authoring.reactions === false ? { reactions: false } : {}),
    ...(authoring["effect-scope"] === "trigger" ? { effectScope: "trigger" } : {}),
  });
  return {
    bundle,
    bundleHash: await canonicalSha256(bundle),
    canonicalBundle: canonicalJson(bundle),
  };
}
