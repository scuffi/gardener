import { z } from "zod";
import { githubAccountTypeSchema, githubNumericIdSchema } from "./identity";

export const WORKFLOW_CONDITION_MAX_DEPTH = 8;
export const WORKFLOW_CONDITION_MAX_NODES = 100;
export const WORKFLOW_CONDITION_MAX_PREDICATES = 64;

export const workflowConditionOperatorSchema = z.enum([
  "equals", "not_equals", "in", "not_in",
  "greater_than", "at_least", "less_than", "at_most",
  "contains", "not_contains", "contains_any", "contains_all",
  "within_weekly_window",
]);
export type WorkflowConditionOperator = z.infer<typeof workflowConditionOperatorSchema>;

export const workflowCapabilityValueTypeSchema = z.enum(["string", "number", "boolean", "identity", "string_list", "weekly_window"]);
export type WorkflowCapabilityValueType = z.infer<typeof workflowCapabilityValueTypeSchema>;

export const workflowCapabilityAvailabilitySchema = z.enum(["available", "planned"]);
export type WorkflowCapabilityAvailability = z.infer<typeof workflowCapabilityAvailabilitySchema>;

export const workflowCapabilityProvenanceSchema = z.enum([
  "connect-attested-identity",
  "connect-attested-scope",
  "connect-resolved-authorization",
  "connect-resolved-mutable-state",
  "github-content",
  "deterministic-derived-data",
  "model-derived-data",
  "gardener-system-clock",
]);
export type WorkflowCapabilityProvenance = z.infer<typeof workflowCapabilityProvenanceSchema>;

export const workflowCapabilityTrustSchema = z.enum(["identity", "scope", "authorization", "mutable-state", "content", "derived", "model", "system"]);
export type WorkflowCapabilityTrust = z.infer<typeof workflowCapabilityTrustSchema>;

const scalarOperators = ["equals", "not_equals", "in", "not_in"] as const;
const numberOperators = ["equals", "not_equals", "in", "not_in", "greater_than", "at_least", "less_than", "at_most"] as const;
const booleanOperators = ["equals", "not_equals"] as const;
const identityOperators = ["equals", "not_equals"] as const;
const listOperators = ["contains", "not_contains", "contains_any", "contains_all"] as const;
const weeklyWindowOperators = ["within_weekly_window"] as const;

export const workflowConditionCapabilitySpecifications = [
  { id: "github.repository.id@v1", valueType: "string", scalarType: "github_id", operators: scalarOperators, eventKinds: ["github.issue", "github.pull_request"], availability: "available" },
  { id: "github.event.kind@v1", valueType: "string", scalarType: "event_kind", operators: scalarOperators, eventKinds: ["github.issue", "github.pull_request"], availability: "available" },
  { id: "github.event.action@v1", valueType: "string", scalarType: "event_action", operators: scalarOperators, eventKinds: ["github.issue", "github.pull_request"], availability: "available" },
  { id: "github.event.actor.identity@v1", valueType: "identity", scalarType: "identity", operators: identityOperators, eventKinds: ["github.issue", "github.pull_request"], availability: "planned" },
  { id: "github.event.actor.login@v1", valueType: "string", scalarType: "string", operators: scalarOperators, eventKinds: ["github.issue", "github.pull_request"], availability: "planned" },
  { id: "github.event.actor.account_type@v1", valueType: "string", scalarType: "account_type", operators: scalarOperators, eventKinds: ["github.issue", "github.pull_request"], availability: "planned" },
  { id: "github.resource.author.identity@v1", valueType: "identity", scalarType: "identity", operators: identityOperators, eventKinds: ["github.issue", "github.pull_request"], availability: "planned" },
  { id: "github.resource.author.login@v1", valueType: "string", scalarType: "string", operators: scalarOperators, eventKinds: ["github.issue", "github.pull_request"], availability: "available" },
  { id: "github.resource.author.account_type@v1", valueType: "string", scalarType: "account_type", operators: scalarOperators, eventKinds: ["github.issue", "github.pull_request"], availability: "planned" },
  { id: "github.resource.state@v1", valueType: "string", scalarType: "resource_state", operators: scalarOperators, eventKinds: ["github.issue", "github.pull_request"], availability: "available" },
  { id: "github.resource.labels@v1", valueType: "string_list", scalarType: "string", operators: listOperators, eventKinds: ["github.issue", "github.pull_request"], availability: "available" },
  { id: "github.issue.number@v1", valueType: "number", scalarType: "number", operators: numberOperators, eventKinds: ["github.issue"], availability: "available" },
  { id: "github.pull_request.number@v1", valueType: "number", scalarType: "number", operators: numberOperators, eventKinds: ["github.pull_request"], availability: "available" },
  { id: "github.pull_request.base.ref@v1", valueType: "string", scalarType: "string", operators: scalarOperators, eventKinds: ["github.pull_request"], availability: "available" },
  { id: "github.pull_request.head.ref@v1", valueType: "string", scalarType: "string", operators: scalarOperators, eventKinds: ["github.pull_request"], availability: "available" },
  { id: "github.pull_request.draft@v1", valueType: "boolean", scalarType: "boolean", operators: booleanOperators, eventKinds: ["github.pull_request"], availability: "available" },
  { id: "github.pull_request.merged@v1", valueType: "boolean", scalarType: "boolean", operators: booleanOperators, eventKinds: ["github.pull_request"], availability: "available" },
  { id: "github.pull_request.checks.all_required_passed@v1", valueType: "boolean", scalarType: "boolean", operators: booleanOperators, eventKinds: ["github.pull_request"], availability: "planned" },
  { id: "github.event.actor.repository_permission@v1", valueType: "string", scalarType: "repository_permission", operators: scalarOperators, eventKinds: ["github.issue", "github.pull_request"], availability: "planned" },
  { id: "github.event.actor.organization_role@v1", valueType: "string", scalarType: "organization_role", operators: scalarOperators, eventKinds: ["github.issue", "github.pull_request"], availability: "planned" },
  { id: "github.event.actor.team_ids@v1", valueType: "string_list", scalarType: "github_id", operators: listOperators, eventKinds: ["github.issue", "github.pull_request"], availability: "planned" },
  { id: "gardener.time.weekly_window@v1", valueType: "weekly_window", scalarType: "weekly_window", operators: weeklyWindowOperators, eventKinds: ["github.issue", "github.pull_request"], availability: "planned" },
] as const;
for (const capability of workflowConditionCapabilitySpecifications) {
  Object.freeze(capability.operators);
  Object.freeze(capability.eventKinds);
  Object.freeze(capability);
}
Object.freeze(workflowConditionCapabilitySpecifications);

export type WorkflowConditionCapabilitySpecification = (typeof workflowConditionCapabilitySpecifications)[number];
export type WorkflowCapabilityId = WorkflowConditionCapabilitySpecification["id"];
export type WorkflowEventKind = WorkflowConditionCapabilitySpecification["eventKinds"][number];

export const workflowCapabilityIdSchema = z.enum(workflowConditionCapabilitySpecifications.map((capability) => capability.id));

export const workflowIdentityValueSchema = z.object({
  id: githubNumericIdSchema,
  accountType: githubAccountTypeSchema,
}).strict();
export type WorkflowIdentityValue = z.infer<typeof workflowIdentityValueSchema>;

export const workflowWeeklyWindowSchema = z.object({
  timezone: z.string().trim().min(1).max(100),
  weekdays: z.array(z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"])).min(1).max(7),
  startMinute: z.number().int().min(0).max(1_439),
  endMinute: z.number().int().min(0).max(1_439),
}).strict().superRefine((window, context) => {
  if (new Set(window.weekdays).size !== window.weekdays.length) context.addIssue({ code: "custom", path: ["weekdays"], message: "weekdays must be unique" });
});
export type WorkflowWeeklyWindow = z.infer<typeof workflowWeeklyWindowSchema>;

const conditionStringSchema = z.string().min(1).max(255);
const conditionNumberSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const conditionStringListSchema = z.array(conditionStringSchema).min(1).max(50).superRefine((values, context) => {
  if (new Set(values).size !== values.length) context.addIssue({ code: "custom", message: "condition values must be unique" });
});
const conditionExpectedValueSchema = z.union([
  conditionStringSchema,
  conditionNumberSchema,
  z.boolean(),
  workflowIdentityValueSchema,
  workflowWeeklyWindowSchema,
  conditionStringListSchema,
  z.array(conditionNumberSchema).min(1).max(50),
]);
export type WorkflowConditionExpectedValue = z.infer<typeof conditionExpectedValueSchema>;

const specificationById = new Map<WorkflowCapabilityId, WorkflowConditionCapabilitySpecification>(
  workflowConditionCapabilitySpecifications.map((specification) => [specification.id, specification]),
);

function scalarExpectedSchema(specification: WorkflowConditionCapabilitySpecification): z.ZodType {
  switch (specification.scalarType) {
    case "identity": return workflowIdentityValueSchema;
    case "github_id": return githubNumericIdSchema;
    case "number": return conditionNumberSchema;
    case "boolean": return z.boolean();
    case "event_kind": return z.enum(["github.issue", "github.pull_request"]);
    case "event_action": return z.enum([
      "opened", "edited", "reopened", "closed", "labeled", "unlabeled", "assigned", "unassigned",
      "synchronize", "ready_for_review", "converted_to_draft", "review_requested", "review_request_removed",
    ]);
    case "account_type": return githubAccountTypeSchema;
    case "resource_state": return z.enum(["open", "closed"]);
    case "repository_permission": return z.enum(["read", "triage", "write", "maintain", "admin"]);
    case "organization_role": return z.enum(["member", "owner"]);
    case "weekly_window": return workflowWeeklyWindowSchema;
    default: return conditionStringSchema;
  }
}

function expectedSchema(specification: WorkflowConditionCapabilitySpecification, operator: WorkflowConditionOperator): z.ZodType {
  const scalar = scalarExpectedSchema(specification);
  if (operator === "in" || operator === "not_in") return z.array(scalar).min(1).max(50);
  if (operator === "contains_any" || operator === "contains_all") return z.array(scalar).min(1).max(50);
  return scalar;
}

export const workflowPredicateSchema = z.object({
  kind: z.literal("predicate"),
  capabilityId: workflowCapabilityIdSchema,
  operator: workflowConditionOperatorSchema,
  expected: conditionExpectedValueSchema,
}).strict().superRefine((predicate, context) => {
  const specification = specificationById.get(predicate.capabilityId);
  if (!specification || !(specification.operators as readonly string[]).includes(predicate.operator)) {
    context.addIssue({ code: "custom", path: ["operator"], message: "operator is not supported by this capability" });
    return;
  }
  const parsed = expectedSchema(specification, predicate.operator).safeParse(predicate.expected);
  if (!parsed.success) context.addIssue({ code: "custom", path: ["expected"], message: "expected value is incompatible with this capability and operator" });
});
export type WorkflowPredicate = z.infer<typeof workflowPredicateSchema>;

export type WorkflowCondition =
  | { kind: "all"; conditions: WorkflowCondition[] }
  | { kind: "any"; conditions: WorkflowCondition[] }
  | { kind: "not"; condition: WorkflowCondition }
  | WorkflowPredicate;

const workflowConditionStructureSchema: z.ZodType<WorkflowCondition> = z.lazy(() => z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("all"), conditions: z.array(workflowConditionStructureSchema).min(1).max(WORKFLOW_CONDITION_MAX_NODES) }).strict(),
  z.object({ kind: z.literal("any"), conditions: z.array(workflowConditionStructureSchema).min(1).max(WORKFLOW_CONDITION_MAX_NODES) }).strict(),
  z.object({ kind: z.literal("not"), condition: workflowConditionStructureSchema }).strict(),
  workflowPredicateSchema,
]));

function inspectConditionBounds(value: unknown, context: z.RefinementCtx): void {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 1 }];
  let nodes = 0;
  let predicates = 0;
  while (stack.length) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > WORKFLOW_CONDITION_MAX_NODES) {
      context.addIssue({ code: "custom", message: `condition exceeds ${WORKFLOW_CONDITION_MAX_NODES} nodes` });
      return;
    }
    if (current.depth > WORKFLOW_CONDITION_MAX_DEPTH) {
      context.addIssue({ code: "custom", message: `condition exceeds depth ${WORKFLOW_CONDITION_MAX_DEPTH}` });
      return;
    }
    if (typeof current.value !== "object" || current.value === null || Array.isArray(current.value)) continue;
    const node = current.value as Record<string, unknown>;
    if (node.kind === "predicate") {
      predicates += 1;
      if (predicates > WORKFLOW_CONDITION_MAX_PREDICATES) {
        context.addIssue({ code: "custom", message: `condition exceeds ${WORKFLOW_CONDITION_MAX_PREDICATES} predicates` });
        return;
      }
    } else if ((node.kind === "all" || node.kind === "any") && Array.isArray(node.conditions)) {
      for (const child of node.conditions) stack.push({ value: child, depth: current.depth + 1 });
    } else if (node.kind === "not") {
      stack.push({ value: node.condition, depth: current.depth + 1 });
    }
  }
}

export const workflowConditionSchema = z.unknown().superRefine(inspectConditionBounds).pipe(workflowConditionStructureSchema);

export const workflowCapabilityMetadataSchema = z.object({
  id: workflowCapabilityIdSchema,
  label: z.string().min(1).max(100),
  description: z.string().min(1).max(500),
  category: z.enum(["repository", "event", "event_actor", "resource_author", "resource", "issue", "pull_request", "authorization", "time"]),
  valueType: workflowCapabilityValueTypeSchema,
  operators: z.array(workflowConditionOperatorSchema).min(1).max(12),
  eventKinds: z.array(z.enum(["github.issue", "github.pull_request"])).min(1).max(2),
  provenance: workflowCapabilityProvenanceSchema,
  trust: workflowCapabilityTrustSchema,
  availability: workflowCapabilityAvailabilitySchema,
  requiredGitHubPermission: z.string().min(1).max(100).optional(),
}).strict();
export type WorkflowCapabilityMetadata = z.infer<typeof workflowCapabilityMetadataSchema>;
