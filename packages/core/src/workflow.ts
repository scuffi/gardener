import {
  SYSTEM_PROMPT_TEMPLATE_VERSION,
  compiledPlanSchema,
  compiledWorkflowPlanV2Schema,
  policySchema,
  validateSystemPromptTemplate,
  workflowDefinitionSchema,
  workflowDefinitionV2Schema,
  workflowSpecV2Schema,
  type CompiledPlan,
  type CompiledWorkflowPlanV2,
  type Policy,
  type WorkflowDefinition,
  type WorkflowDefinitionV2,
  type WorkflowSpecV2,
} from "@gardener/contracts";
import { validateWorkflowCondition } from "./conditions";
import { canonicalSha256, stableHash } from "./stable";

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export interface CompileWorkflowOptions {
  now?: () => Date;
}

/** Validates, snapshots, and freezes everything a run needs. Source objects are never retained. */
export function compileWorkflow(
  source: WorkflowDefinition | unknown,
  policySource: Policy | unknown,
  options: CompileWorkflowOptions = {},
): Readonly<CompiledPlan> {
  const definition = workflowDefinitionSchema.parse(source);
  const policy = policySchema.parse(policySource);
  const duplicates = definition.allowedOperations.filter((kind, index, all) => all.indexOf(kind) !== index);
  if (duplicates.length) throw new Error(`duplicate allowed operation: ${duplicates[0]}`);

  const snapshot = { definition, policy };
  const plan: CompiledPlan = compiledPlanSchema.parse({
    schemaVersion: "v1",
    planId: `plan_${stableHash(snapshot)}`,
    sourceWorkflowId: definition.id,
    sourceRevision: definition.revision,
    compiledAt: (options.now?.() ?? new Date()).toISOString(),
    ...snapshot,
  });
  return deepFreeze(plan);
}

export const compilePlan = compileWorkflow;

export const issueGardenerRuntimeCapabilities = Object.freeze({
  eventKind: "github.issue" as const,
  actions: Object.freeze(["opened", "edited", "reopened", "closed", "labeled", "unlabeled"] as const),
  reads: Object.freeze(["issue"] as const),
  operations: Object.freeze(["issue.label.add", "issue.comment.create"] as const),
  maxOutputTokens: 8_192,
});

export interface CompileWorkflowV2Options {
  workflowId: string;
  revision: number;
  resolvedModel: string;
  now?: () => Date;
}

export interface CompiledWorkflowV2 {
  definition: Readonly<WorkflowDefinitionV2>;
  plan: Readonly<CompiledWorkflowPlanV2>;
}

/** Compiles server-owned v2 metadata and resolves deployment capabilities without embedding operation policy. */
export async function compileWorkflowV2(source: WorkflowSpecV2 | unknown, options: CompileWorkflowV2Options): Promise<CompiledWorkflowV2> {
  const spec = workflowSpecV2Schema.parse(source);
  const eventTriggers = spec.triggers.filter((trigger) => trigger.kind === "github.issue" || trigger.kind === "github.pull_request");
  if (eventTriggers.length !== spec.triggers.length) throw new Error("manual and schedule triggers are not available");
  if (spec.runtime.kind !== "workers-ai.issue-gardener") throw new Error(`runtime is not available: ${spec.runtime.kind}`);
  if (eventTriggers.some((trigger) => trigger.kind !== issueGardenerRuntimeCapabilities.eventKind)) throw new Error("the issue gardener runtime only supports GitHub issue events");
  const supportedActions = new Set<string>(issueGardenerRuntimeCapabilities.actions);
  if (eventTriggers.some((trigger) => trigger.actions.some((action) => !supportedActions.has(action)))) throw new Error("the issue gardener runtime does not support one or more trigger actions");
  const supportedOperations = new Set<string>(issueGardenerRuntimeCapabilities.operations);
  if (spec.capabilities.propose.some((operation) => !supportedOperations.has(operation))) throw new Error("the issue gardener runtime supports only label-add and comment-create proposals");
  const supportedReads = new Set<string>(issueGardenerRuntimeCapabilities.reads);
  if (spec.capabilities.read.some((capability) => !supportedReads.has(capability))) throw new Error("the issue gardener runtime supports only issue reads");
  if (spec.limits.outputTokens > issueGardenerRuntimeCapabilities.maxOutputTokens) throw new Error("the issue gardener output-token limit exceeds the runtime maximum");
  if (spec.workspace.enabled) throw new Error("workspace execution is not available");
  const promptTemplateIssues = validateSystemPromptTemplate(spec.runtime.instructions);
  if (promptTemplateIssues.length) throw new Error(`system prompt template is invalid: ${promptTemplateIssues.map((issue) => issue.message).join("; ")}`);

  const eventKinds = [...new Set(eventTriggers.map((trigger) => trigger.kind))];
  const conditionValidation = validateWorkflowCondition(spec.condition, eventKinds, { mode: "activation" });
  if (!conditionValidation.valid) throw new Error(`workflow condition cannot activate: ${conditionValidation.issues.map((issue) => issue.code).join(", ")}`);

  const contentHash = await canonicalSha256(spec);
  const definition = workflowDefinitionV2Schema.parse({
    schemaVersion: "v2",
    workflowId: options.workflowId,
    revision: options.revision,
    contentHash,
    spec,
  });
  const triggers = eventTriggers.flatMap((trigger) => trigger.actions.map((action) => `${trigger.kind}.${action}`));
  const planContent = {
    workflowId: definition.workflowId,
    revision: definition.revision,
    contentHash,
    triggers,
    repositoryIds: spec.repositoryIds,
    condition: spec.condition,
    conditionResolver: { id: "signed-event-facts" as const, version: 1 as const, catalogVersion: "2026-09-03.1" as const },
    requiredGitHubPermissions: spec.capabilities.propose.length ? ["issues:write"] : [],
    runtime: { kind: spec.runtime.kind, resolvedModel: options.resolvedModel, instructions: spec.runtime.instructions, promptTemplateVersion: SYSTEM_PROMPT_TEMPLATE_VERSION },
    capabilities: spec.capabilities,
    workspace: spec.workspace,
    limits: spec.limits,
  };
  const planId = `plan_${await canonicalSha256(planContent)}`;
  const plan = compiledWorkflowPlanV2Schema.parse({
    schemaVersion: "v2",
    planId,
    compiledAt: (options.now?.() ?? new Date()).toISOString(),
    ...planContent,
  });
  return { definition: deepFreeze(definition), plan: deepFreeze(plan) };
}
