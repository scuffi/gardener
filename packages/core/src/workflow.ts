import {
  compiledPlanSchema,
  policySchema,
  workflowDefinitionSchema,
  type CompiledPlan,
  type Policy,
  type WorkflowDefinition,
} from "@gardener/contracts";
import { stableHash } from "./stable";

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
