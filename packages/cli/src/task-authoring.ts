import {
  taskBundleV1Schema,
  type TaskBundleV1,
} from "@gardener/contracts";
import { canonicalJson, canonicalSha256 } from "@gardener/core";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const safeLabel = z.string().trim().min(1).max(100).regex(
  /^[A-Za-z0-9][A-Za-z0-9._ -]{0,99}$/,
  "labels may contain only letters, numbers, spaces, dots, underscores, and hyphens",
);

const authoringSchema = z.strictObject({
  schema: z.literal("gardener.task/v1"),
  id: z.string().regex(/^[a-z0-9](?:[a-z0-9._-]{0,158}[a-z0-9])?$/),
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().min(1).max(1_000),
  trigger: z.strictObject({
    event: z.literal("github.issue.opened"),
    "labels-all": z.array(safeLabel).max(20).default([]),
  }),
  tools: z.array(z.enum(["repository.read_file", "repository.list_files"]))
    .min(1)
    .max(2)
    .refine((tools) => tools.includes("repository.list_files"), {
      message: "the bounded v1 runtime requires repository.list_files",
    }),
  effects: z.tuple([z.literal("issue.comment.create")]),
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
  }),
});

export interface CompiledTask {
  bundle: TaskBundleV1;
  bundleHash: string;
  canonicalBundle: string;
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

  const bundle = taskBundleV1Schema.parse({
    schemaVersion: "gardener.task-bundle/v1",
    taskId: authoring.id,
    name: authoring.name,
    description: authoring.description,
    instructions,
    triggers: [{
      kind: authoring.trigger.event,
      labelsAll: authoring.trigger["labels-all"],
    }],
    tools: authoring.tools,
    effects: authoring.effects,
    network: authoring.network,
    limits: {
      runtimeSeconds: authoring.limits["runtime-seconds"],
      maxTurns: authoring.limits["max-turns"],
      maxToolCalls: authoring.limits["max-tool-calls"],
      inputTokens: authoring.limits["input-tokens"],
      outputTokens: authoring.limits["output-tokens"],
    },
  });
  return {
    bundle,
    bundleHash: await canonicalSha256(bundle),
    canonicalBundle: canonicalJson(bundle),
  };
}
