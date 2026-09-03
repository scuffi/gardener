import {
  connectEventSchema,
  workflowCapabilityMetadataSchema,
  workflowConditionCapabilitySpecifications,
  workflowConditionSchema,
  type ConnectEvent,
  type WorkflowCapabilityId,
  type WorkflowCapabilityMetadata,
  type WorkflowCondition,
  type WorkflowConditionExpectedValue,
  type WorkflowConditionOperator,
  type WorkflowEventKind,
  type WorkflowIdentityValue,
  type WorkflowPredicate,
} from "@gardener/contracts";

const specificationById = new Map(workflowConditionCapabilitySpecifications.map((capability) => [capability.id, capability]));

type CapabilityPresentation = Pick<WorkflowCapabilityMetadata, "label" | "description" | "category" | "provenance" | "trust"> &
  Pick<WorkflowCapabilityMetadata, "requiredGitHubPermission">;

const presentations: Record<WorkflowCapabilityId, CapabilityPresentation> = {
  "github.repository.id@v1": { label: "Repository", description: "Immutable numeric GitHub repository identity.", category: "repository", provenance: "connect-attested-scope", trust: "scope", requiredGitHubPermission: undefined },
  "github.event.kind@v1": { label: "Event resource type", description: "Normalized GitHub issue or pull-request event kind.", category: "event", provenance: "connect-attested-scope", trust: "scope", requiredGitHubPermission: undefined },
  "github.event.action@v1": { label: "Event action", description: "Verified GitHub webhook action normalized by Connect.", category: "event", provenance: "connect-attested-scope", trust: "scope", requiredGitHubPermission: undefined },
  "github.event.actor.identity@v1": { label: "Person or App that caused this event", description: "Stable numeric identity and account type from the GitHub webhook sender.", category: "event_actor", provenance: "connect-attested-identity", trust: "identity", requiredGitHubPermission: undefined },
  "github.event.actor.login@v1": { label: "Event actor login hint", description: "Mutable display login for the GitHub webhook sender; not a security identifier.", category: "event_actor", provenance: "github-content", trust: "content", requiredGitHubPermission: undefined },
  "github.event.actor.account_type@v1": { label: "Event actor account type", description: "GitHub account type for the webhook sender.", category: "event_actor", provenance: "connect-attested-identity", trust: "identity", requiredGitHubPermission: undefined },
  "github.resource.author.identity@v1": { label: "Original issue or pull request author", description: "Stable numeric identity and account type for the resource author.", category: "resource_author", provenance: "connect-attested-identity", trust: "identity", requiredGitHubPermission: undefined },
  "github.resource.author.login@v1": { label: "Resource author login hint", description: "Mutable display login for the original resource author; not a security identifier.", category: "resource_author", provenance: "github-content", trust: "content", requiredGitHubPermission: undefined },
  "github.resource.author.account_type@v1": { label: "Resource author account type", description: "GitHub account type for the original resource author.", category: "resource_author", provenance: "connect-attested-identity", trust: "identity", requiredGitHubPermission: undefined },
  "github.resource.state@v1": { label: "Resource state", description: "Open or closed state captured in the signed event.", category: "resource", provenance: "connect-resolved-mutable-state", trust: "mutable-state", requiredGitHubPermission: undefined },
  "github.resource.labels@v1": { label: "Resource labels", description: "Label names captured in the signed event.", category: "resource", provenance: "github-content", trust: "content", requiredGitHubPermission: undefined },
  "github.issue.number@v1": { label: "Issue number", description: "Repository-local issue number.", category: "issue", provenance: "connect-attested-scope", trust: "scope", requiredGitHubPermission: undefined },
  "github.pull_request.number@v1": { label: "Pull request number", description: "Repository-local pull request number.", category: "pull_request", provenance: "connect-attested-scope", trust: "scope", requiredGitHubPermission: undefined },
  "github.pull_request.base.ref@v1": { label: "Pull request base branch", description: "Base branch captured in the signed pull-request event.", category: "pull_request", provenance: "connect-resolved-mutable-state", trust: "mutable-state", requiredGitHubPermission: undefined },
  "github.pull_request.head.ref@v1": { label: "Pull request head branch", description: "Head branch captured in the signed pull-request event.", category: "pull_request", provenance: "connect-resolved-mutable-state", trust: "mutable-state", requiredGitHubPermission: undefined },
  "github.pull_request.draft@v1": { label: "Pull request is draft", description: "Draft state captured in the signed pull-request event.", category: "pull_request", provenance: "connect-resolved-mutable-state", trust: "mutable-state", requiredGitHubPermission: undefined },
  "github.pull_request.merged@v1": { label: "Pull request is merged", description: "Merged state captured in the signed pull-request event.", category: "pull_request", provenance: "connect-resolved-mutable-state", trust: "mutable-state", requiredGitHubPermission: undefined },
  "github.pull_request.checks.all_required_passed@v1": { label: "All required checks passed", description: "Planned live check evaluation; unavailable in normalized events today.", category: "pull_request", provenance: "connect-resolved-mutable-state", trust: "mutable-state", requiredGitHubPermission: "checks:read" },
  "github.event.actor.repository_permission@v1": { label: "Event actor repository permission", description: "Planned Connect-resolved repository permission; unavailable today.", category: "authorization", provenance: "connect-resolved-authorization", trust: "authorization", requiredGitHubPermission: "metadata:read" },
  "github.event.actor.organization_role@v1": { label: "Event actor organization role", description: "Planned Connect-resolved organization role; unavailable today.", category: "authorization", provenance: "connect-resolved-authorization", trust: "authorization", requiredGitHubPermission: "members:read" },
  "github.event.actor.team_ids@v1": { label: "Event actor team identities", description: "Planned Connect-resolved team identities; unavailable today.", category: "authorization", provenance: "connect-resolved-authorization", trust: "authorization", requiredGitHubPermission: "members:read" },
  "gardener.time.weekly_window@v1": { label: "Current time is within a weekly window", description: "Planned evaluation using trusted Worker time and an explicit IANA time zone; unavailable today.", category: "time", provenance: "gardener-system-clock", trust: "system", requiredGitHubPermission: undefined },
};

function freezeCapability(capability: WorkflowCapabilityMetadata): WorkflowCapabilityMetadata {
  Object.freeze(capability.operators);
  Object.freeze(capability.eventKinds);
  return Object.freeze(capability);
}

export const workflowCapabilityRegistry: readonly WorkflowCapabilityMetadata[] = Object.freeze(
  workflowConditionCapabilitySpecifications.map((specification) => freezeCapability(workflowCapabilityMetadataSchema.parse({
    ...presentations[specification.id],
    id: specification.id,
    valueType: specification.valueType,
    operators: [...specification.operators],
    eventKinds: [...specification.eventKinds],
    availability: specification.availability,
  }))),
);

export const availableWorkflowCapabilities = Object.freeze(workflowCapabilityRegistry.filter((capability) => capability.availability === "available"));
export const plannedWorkflowCapabilities = Object.freeze(workflowCapabilityRegistry.filter((capability) => capability.availability === "planned"));
const metadataById = new Map(workflowCapabilityRegistry.map((capability) => [capability.id, capability]));

export function workflowCapability(capabilityId: WorkflowCapabilityId): WorkflowCapabilityMetadata {
  return metadataById.get(capabilityId)!;
}

export type WorkflowConditionValidationCode = "capability_unavailable" | "event_incompatible";
export interface WorkflowConditionValidationIssue {
  code: WorkflowConditionValidationCode;
  path: string;
  capabilityId: WorkflowCapabilityId;
}

export function validateWorkflowCondition(
  condition: unknown,
  eventKinds: readonly WorkflowEventKind[],
  options: { mode?: "draft" | "activation" } = {},
): { valid: boolean; issues: WorkflowConditionValidationIssue[] } {
  if (condition === null) return { valid: true, issues: [] };
  const parsed = workflowConditionSchema.parse(condition);
  const issues: WorkflowConditionValidationIssue[] = [];
  visitPredicates(parsed, (predicate, path) => {
    const capability = workflowCapability(predicate.capabilityId);
    if ((options.mode ?? "activation") === "activation" && capability.availability !== "available") {
      issues.push({ code: "capability_unavailable", path, capabilityId: predicate.capabilityId });
    }
    if (eventKinds.some((eventKind) => !capability.eventKinds.includes(eventKind))) {
      issues.push({ code: "event_incompatible", path, capabilityId: predicate.capabilityId });
    }
  });
  return { valid: issues.length === 0, issues };
}

function visitPredicates(condition: WorkflowCondition, visit: (predicate: WorkflowPredicate, path: string) => void, path = "$condition"): void {
  if (condition.kind === "predicate") return visit(condition, path);
  if (condition.kind === "not") return visitPredicates(condition.condition, visit, `${path}.condition`);
  condition.conditions.forEach((child, index) => visitPredicates(child, visit, `${path}.conditions[${index}]`));
}

export type WorkflowConditionTruth = "true" | "false" | "unknown";
export type WorkflowConditionReasonCode =
  | "comparison_true" | "comparison_false" | "fact_missing" | "capability_unavailable" | "event_incompatible"
  | "all_true" | "all_false" | "all_unknown" | "any_true" | "any_false" | "any_unknown"
  | "not_true" | "not_false" | "not_unknown";

export interface WorkflowConditionEvidence {
  path: string;
  kind: WorkflowCondition["kind"];
  result: WorkflowConditionTruth;
  reason: WorkflowConditionReasonCode;
  capabilityId?: WorkflowCapabilityId;
}

export interface WorkflowConditionEvaluation {
  result: WorkflowConditionTruth;
  matched: boolean;
  evidence: WorkflowConditionEvidence[];
}

export function evaluateWorkflowCondition(condition: unknown, inputEvent: ConnectEvent | unknown): WorkflowConditionEvaluation {
  const event = connectEventSchema.parse(inputEvent);
  if (condition === null) return { result: "true", matched: true, evidence: [] };
  const parsed = workflowConditionSchema.parse(condition);
  const evidence: WorkflowConditionEvidence[] = [];
  const result = evaluateNode(parsed, event, "$condition", evidence);
  return { result, matched: result === "true", evidence };
}

function evaluateNode(condition: WorkflowCondition, event: ConnectEvent, path: string, evidence: WorkflowConditionEvidence[]): WorkflowConditionTruth {
  if (condition.kind === "predicate") {
    const capability = workflowCapability(condition.capabilityId);
    let result: WorkflowConditionTruth;
    let reason: WorkflowConditionReasonCode;
    if (capability.availability !== "available") {
      result = "unknown"; reason = "capability_unavailable";
    } else if (!capability.eventKinds.includes(event.kind)) {
      result = "unknown"; reason = "event_incompatible";
    } else {
      const actual = resolveFact(condition.capabilityId, event);
      if (actual === undefined) {
        result = "unknown"; reason = "fact_missing";
      } else {
        result = compare(actual, condition.operator, condition.expected) ? "true" : "false";
        reason = result === "true" ? "comparison_true" : "comparison_false";
      }
    }
    evidence.push({ path, kind: condition.kind, result, reason, capabilityId: condition.capabilityId });
    return result;
  }

  if (condition.kind === "not") {
    const child = evaluateNode(condition.condition, event, `${path}.condition`, evidence);
    const result = child === "true" ? "false" : child === "false" ? "true" : "unknown";
    evidence.push({ path, kind: condition.kind, result, reason: result === "true" ? "not_true" : result === "false" ? "not_false" : "not_unknown" });
    return result;
  }

  const children = condition.conditions.map((child, index) => evaluateNode(child, event, `${path}.conditions[${index}]`, evidence));
  const result = condition.kind === "all"
    ? children.includes("false") ? "false" : children.includes("unknown") ? "unknown" : "true"
    : children.includes("true") ? "true" : children.includes("unknown") ? "unknown" : "false";
  const reason = `${condition.kind}_${result}` as WorkflowConditionReasonCode;
  evidence.push({ path, kind: condition.kind, result, reason });
  return result;
}

function resolveFact(capabilityId: WorkflowCapabilityId, event: ConnectEvent): WorkflowConditionExpectedValue | undefined {
  const resource = event.kind === "github.issue" ? event.issue : event.pullRequest;
  switch (capabilityId) {
    case "github.repository.id@v1": return event.repository.id;
    case "github.event.kind@v1": return event.kind;
    case "github.event.action@v1": return event.action;
    case "github.event.actor.identity@v1": return event.actor ? identityValue(event.actor) : undefined;
    case "github.event.actor.login@v1": return event.actor?.login;
    case "github.event.actor.account_type@v1": return event.actor?.accountType;
    case "github.resource.author.identity@v1": return resource.authorIdentity ? identityValue(resource.authorIdentity) : undefined;
    case "github.resource.author.login@v1": return resource.authorIdentity?.login ?? resource.author;
    case "github.resource.author.account_type@v1": return resource.authorIdentity?.accountType;
    case "github.resource.state@v1": return resource.state;
    case "github.resource.labels@v1": return resource.labels;
    case "github.issue.number@v1": return event.kind === "github.issue" ? event.issue.number : undefined;
    case "github.pull_request.number@v1": return event.kind === "github.pull_request" ? event.pullRequest.number : undefined;
    case "github.pull_request.base.ref@v1": return event.kind === "github.pull_request" ? event.pullRequest.base.ref : undefined;
    case "github.pull_request.head.ref@v1": return event.kind === "github.pull_request" ? event.pullRequest.head.ref : undefined;
    case "github.pull_request.draft@v1": return event.kind === "github.pull_request" ? event.pullRequest.draft : undefined;
    case "github.pull_request.merged@v1": return event.kind === "github.pull_request" ? event.pullRequest.merged : undefined;
    default: return undefined;
  }
}

function identityValue(identity: { id: string; accountType: WorkflowIdentityValue["accountType"] }): WorkflowIdentityValue {
  return { id: identity.id, accountType: identity.accountType };
}

function equal(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(actual) || Array.isArray(expected)) {
    return Array.isArray(actual) && Array.isArray(expected) && actual.length === expected.length && actual.every((value, index) => equal(value, expected[index]));
  }
  if (typeof actual === "object" && actual !== null && typeof expected === "object" && expected !== null) {
    const left = actual as Record<string, unknown>;
    const right = expected as Record<string, unknown>;
    const keys = Object.keys(left).sort();
    return keys.length === Object.keys(right).length && keys.every((key) => Object.hasOwn(right, key) && equal(left[key], right[key]));
  }
  return actual === expected;
}

function compare(actual: WorkflowConditionExpectedValue, operator: WorkflowConditionOperator, expected: WorkflowConditionExpectedValue): boolean {
  switch (operator) {
    case "equals": return equal(actual, expected);
    case "not_equals": return !equal(actual, expected);
    case "in": return Array.isArray(expected) && expected.some((value) => equal(actual, value));
    case "not_in": return Array.isArray(expected) && !expected.some((value) => equal(actual, value));
    case "greater_than": return typeof actual === "number" && typeof expected === "number" && actual > expected;
    case "at_least": return typeof actual === "number" && typeof expected === "number" && actual >= expected;
    case "less_than": return typeof actual === "number" && typeof expected === "number" && actual < expected;
    case "at_most": return typeof actual === "number" && typeof expected === "number" && actual <= expected;
    case "contains": return Array.isArray(actual) && actual.some((value) => equal(value, expected));
    case "not_contains": return Array.isArray(actual) && !actual.some((value) => equal(value, expected));
    case "contains_any": return Array.isArray(actual) && Array.isArray(expected) && expected.some((wanted) => actual.some((value) => equal(value, wanted)));
    case "contains_all": return Array.isArray(actual) && Array.isArray(expected) && expected.every((wanted) => actual.some((value) => equal(value, wanted)));
    // The weekly-window capability remains planned; its future resolver owns trusted-clock evaluation.
    case "within_weekly_window": return false;
  }
}
