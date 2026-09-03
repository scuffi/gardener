import { operationSchema, policySchema, type Operation, type Policy, type PolicyDecision } from "@gardener/contracts";

export interface CurrentResourceState {
  repositoryId?: string;
  issueState?: "open" | "closed";
  headSha?: string;
  baseRef?: string;
  baseSha?: string;
  pullState?: "open" | "closed";
  draft?: boolean;
  successfulChecks?: readonly string[];
  branchProtectionAllowsMerge?: boolean;
}

export interface PolicyEvaluationContext {
  globallyPaused?: boolean;
  current?: CurrentResourceState;
}

/** Policy modes can grant less authority, never bypass hard safety invariants. */
export function evaluatePolicy(
  operationInput: Operation | unknown,
  policyInput: Policy | unknown,
  context: PolicyEvaluationContext = {},
): PolicyDecision {
  const operation = operationSchema.parse(operationInput);
  const policy = policySchema.parse(policyInput);
  const mode = policy.modes[operation.kind];
  const reasons: string[] = [];

  if (context.globallyPaused) reasons.push("Gardener is globally paused");
  if (mode === "disabled") reasons.push("operation is disabled by policy");
  if (context.current?.repositoryId !== undefined && context.current.repositoryId !== operation.repository.id) reasons.push("repository does not match current resource");

  if ("expectedIssueState" in operation && context.current?.issueState !== undefined && operation.expectedIssueState !== context.current.issueState) {
    reasons.push("issue state changed since proposal");
  }
  if ("body" in operation && typeof operation.body === "string" && operation.kind.startsWith("issue.comment") && operation.body.length > policy.maxCommentLength) {
    reasons.push("comment exceeds policy length limit");
  }
  if (operation.kind === "commit.create") {
    if (operation.files.length > policy.maxChangedFiles) reasons.push("change exceeds policy file limit");
    for (const file of operation.files) {
      if (policy.deniedPathPrefixes.some((prefix) => file.path === prefix || file.path.startsWith(prefix))) {
        reasons.push(`path is denied by policy: ${file.path}`);
      }
    }
    if (context.current?.headSha !== undefined && context.current.headSha !== operation.expectedHeadSha) reasons.push("branch head changed since proposal");
  }
  if ("expectedHeadSha" in operation && context.current?.headSha !== undefined && context.current.headSha !== operation.expectedHeadSha) {
    if (!reasons.includes("branch head changed since proposal")) reasons.push("pull request head changed since proposal");
  }
  if ("expectedBaseRef" in operation && context.current?.baseRef !== undefined && context.current.baseRef !== operation.expectedBaseRef) reasons.push("pull request base changed since proposal");
  if ("expectedBaseSha" in operation && context.current?.baseSha !== undefined && context.current.baseSha !== operation.expectedBaseSha) reasons.push("pull request base revision changed since proposal");
  if ("expectedState" in operation && context.current?.pullState !== undefined && context.current.pullState !== operation.expectedState) reasons.push("pull request state changed since proposal");
  if ("expectedDraft" in operation && context.current?.draft !== undefined && context.current.draft !== operation.expectedDraft) reasons.push("pull request draft state changed since proposal");
  if (operation.kind === "pull_request.merge") {
    if (!policy.allowedMergeMethods.includes(operation.method)) reasons.push("merge method is not allowed");
    if (context.current?.draft !== false) reasons.push("pull request must currently be non-draft");
    if (context.current?.branchProtectionAllowsMerge !== true) reasons.push("branch protection does not currently allow merge");
    const successful = new Set(context.current?.successfulChecks ?? []);
    const required = new Set([...policy.requiredChecks, ...operation.requiredChecks.map((check) => check.context)]);
    for (const check of required) if (!successful.has(check)) reasons.push(`required check is not successful: ${check}`);
  }

  if (reasons.length) return { outcome: "denied", operationId: operation.id, mode, reasons };
  if (mode === "approval") return { outcome: "approval_required", operationId: operation.id, mode, reasons: ["human approval is required"] };
  return { outcome: "authorized", operationId: operation.id, mode, reasons: ["policy authorizes automatic execution"] };
}

export const evaluateOperationPolicy = evaluatePolicy;
