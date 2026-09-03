import {
  compiledPlanSchema,
  compiledWorkflowPlanV2Schema,
  policySchema,
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
  if (eventTriggers.some((trigger) => trigger.kind !== "github.issue")) throw new Error("the issue gardener runtime only supports GitHub issue events");
  if (spec.capabilities.propose.some((operation) => !operation.startsWith("issue."))) throw new Error("the issue gardener runtime only supports issue operations");
  if (spec.workspace.enabled) throw new Error("workspace execution is not available");

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
    runtime: { kind: spec.runtime.kind, resolvedModel: options.resolvedModel, instructions: spec.runtime.instructions },
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
