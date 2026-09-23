import { effectiveCapabilitySetSchema, instancePolicyV1Schema, operationSchema, type EffectiveCapabilitySet, type InstancePolicyV1, type Operation, type PolicyDecision } from "@gardener/contracts";

export interface CurrentResourceState {
  repositoryId?: string;
  issueState?: "open" | "closed"; issueUpdatedAt?: string;
  pullState?: "open" | "closed"; pullUpdatedAt?: string; headSha?: string; baseRef?: string; baseSha?: string; draft?: boolean;
  discussionState?: "open" | "closed"; discussionUpdatedAt?: string; answerCommentId?: string | null;
  commentUpdatedAt?: string;
  branchAbsent?: boolean; sourceCommitExists?: boolean; sourceCommitSha?: string; targetCommitExists?: boolean; targetCommitSha?: string;
  checkStatus?: string; checkConclusion?: string | null;
  releaseTagName?: string; releaseTargetCommitSha?: string; releaseDraft?: boolean; releasePrerelease?: boolean; releasePublished?: boolean; releaseUpdatedAt?: string; tagAbsent?: boolean;
  successfulChecks?: readonly string[]; branchProtectionAllowsMerge?: boolean; branchProtectionHash?: string;
}
export interface PolicyEvaluationContext { effectiveCapabilities: EffectiveCapabilitySet; globallyPaused?: boolean; current?: CurrentResourceState }

function commentBody(operation: Operation): string | undefined {
  return "body" in operation && typeof operation.body === "string" && (operation.kind.includes("comment") || operation.kind === "pull_request.review.submit") ? operation.body : undefined;
}
function changedFilePathDenied(path: string, prefixes: readonly string[]): boolean { return prefixes.some((prefix) => path === prefix || path.startsWith(prefix)); }
function requireFacts(current: CurrentResourceState | undefined, fields: readonly (keyof CurrentResourceState)[], reasons: string[]): void {
  for (const field of fields) if (current?.[field] === undefined) reasons.push(`required live precondition is unavailable: ${field}`);
}

/** Instance policy and hard live preconditions are evaluated independently of agent instructions. */
export function evaluateOperationPolicy(operationInput: Operation | unknown, policyInput: InstancePolicyV1 | unknown, context: PolicyEvaluationContext): PolicyDecision {
  const operation = operationSchema.parse(operationInput);
  const policy = instancePolicyV1Schema.parse(policyInput);
  const effectiveCapabilities = effectiveCapabilitySetSchema.parse(context.effectiveCapabilities);
  const effective = effectiveCapabilities.effects.find((item) => item.capability === operation.kind);
  const mode = effective?.mode ?? "disabled";
  const current = context.current;
  const reasons: string[] = [];
  if (context.globallyPaused) reasons.push("Gardener is globally paused");
  if (mode === "disabled") reasons.push("operation is outside effective agent and instance policy authority");
  requireFacts(current, ["repositoryId"], reasons);
  if (operation.kind.startsWith("issue.")) requireFacts(current, ["issueState", "issueUpdatedAt"], reasons);
  if (["issue.comment.update", "pull_request.comment.update", "discussion.comment.update"].includes(operation.kind)) requireFacts(current, ["commentUpdatedAt"], reasons);
  if (operation.kind.startsWith("pull_request.") && operation.kind !== "pull_request.open_draft") requireFacts(current, ["pullState", "pullUpdatedAt", "headSha", "baseRef", "baseSha", "draft"], reasons);
  if (operation.kind === "pull_request.open_draft") requireFacts(current, ["headSha", "baseRef", "baseSha"], reasons);
  if (operation.kind === "branch.create") requireFacts(current, ["branchAbsent", "sourceCommitExists", "sourceCommitSha"], reasons);
  if (operation.kind === "commit.create") requireFacts(current, ["headSha"], reasons);
  if (operation.kind.startsWith("discussion.")) requireFacts(current, ["discussionState", "discussionUpdatedAt"], reasons);
  if (operation.kind === "discussion.answer.mark" || operation.kind === "discussion.answer.unmark") requireFacts(current, ["answerCommentId"], reasons);
  if (operation.kind === "check.rerun") requireFacts(current, ["headSha", "checkStatus", "checkConclusion"], reasons);
  if (operation.kind === "release.create") requireFacts(current, ["tagAbsent", "targetCommitExists", "targetCommitSha"], reasons);
  if (operation.kind.startsWith("release.") && operation.kind !== "release.create") requireFacts(current, ["releaseTagName", "releaseTargetCommitSha", "releaseDraft", "releasePrerelease", "releaseUpdatedAt"], reasons);
  if (operation.kind === "release.publish" || operation.kind === "release.delete") requireFacts(current, ["releasePublished"], reasons);
  if (operation.kind === "pull_request.merge") requireFacts(current, ["successfulChecks", "branchProtectionAllowsMerge", "branchProtectionHash"], reasons);
  if (current?.repositoryId !== undefined && current.repositoryId !== operation.repository.id) reasons.push("repository does not match current resource");

  if ("expectedIssueState" in operation && current?.issueState !== undefined && current.issueState !== operation.expectedIssueState) reasons.push("issue state changed since proposal");
  if ("expectedIssueUpdatedAt" in operation && current?.issueUpdatedAt !== undefined && current.issueUpdatedAt !== operation.expectedIssueUpdatedAt) reasons.push("issue changed since proposal");
  if ("expectedCommentUpdatedAt" in operation && current?.commentUpdatedAt !== undefined && current.commentUpdatedAt !== operation.expectedCommentUpdatedAt) reasons.push("comment changed since proposal");
  if ("expectedHeadSha" in operation && current?.headSha !== undefined && current.headSha !== operation.expectedHeadSha) reasons.push("head revision changed since proposal");
  if ("expectedBaseRef" in operation && current?.baseRef !== undefined && current.baseRef !== operation.expectedBaseRef) reasons.push("pull request base changed since proposal");
  if ("expectedBaseSha" in operation && current?.baseSha !== undefined && current.baseSha !== operation.expectedBaseSha) reasons.push("base revision changed since proposal");
  if ("expectedState" in operation && current?.pullState !== undefined && current.pullState !== operation.expectedState) reasons.push("pull request state changed since proposal");
  if ("expectedDraft" in operation && operation.kind.startsWith("pull_request") && current?.draft !== undefined && current.draft !== operation.expectedDraft) reasons.push("pull request draft state changed since proposal");
  if ("expectedPullUpdatedAt" in operation && current?.pullUpdatedAt !== undefined && current.pullUpdatedAt !== operation.expectedPullUpdatedAt) reasons.push("pull request changed since proposal");
  if ("expectedDiscussionState" in operation && current?.discussionState !== undefined && current.discussionState !== operation.expectedDiscussionState) reasons.push("discussion state changed since proposal");
  if ("expectedDiscussionUpdatedAt" in operation && current?.discussionUpdatedAt !== undefined && current.discussionUpdatedAt !== operation.expectedDiscussionUpdatedAt) reasons.push("discussion changed since proposal");
  if (operation.kind === "pull_request.open_draft" && current?.baseRef !== undefined && current.baseRef !== operation.base) reasons.push("draft pull request base changed since proposal");
  if (operation.kind === "branch.create" && (current?.sourceCommitExists !== true || current.sourceCommitSha !== operation.fromSha)) reasons.push("branch source commit is unavailable or changed");
  if (operation.kind === "release.create" && (current?.targetCommitExists !== true || current.targetCommitSha !== operation.targetCommitSha)) reasons.push("release target commit is unavailable or changed");
  if (operation.kind === "discussion.answer.mark" && current?.answerCommentId !== undefined && current.answerCommentId !== operation.expectedAnswerCommentId) reasons.push("discussion answer changed since proposal");
  if (operation.kind === "discussion.answer.unmark" && current?.answerCommentId !== undefined && current.answerCommentId !== operation.expectedAnswerCommentId) reasons.push("discussion answer changed since proposal");
  if (operation.kind === "branch.create" && current?.branchAbsent !== undefined && current.branchAbsent !== operation.expectedAbsent) reasons.push("branch existence changed since proposal");
  if (operation.kind === "check.rerun") {
    if (current?.checkStatus !== undefined && current.checkStatus !== operation.expectedStatus) reasons.push("check status changed since proposal");
    if (current?.checkConclusion !== undefined && current.checkConclusion !== operation.expectedConclusion) reasons.push("check conclusion changed since proposal");
  }
  if (operation.kind.startsWith("release.")) {
    if ("expectedTagAbsent" in operation && current?.tagAbsent !== undefined && current.tagAbsent !== operation.expectedTagAbsent) reasons.push("release tag now exists");
    if ("expectedTagName" in operation && current?.releaseTagName !== undefined && current.releaseTagName !== operation.expectedTagName) reasons.push("release tag changed since proposal");
    if ("expectedTargetCommitSha" in operation && current?.releaseTargetCommitSha !== undefined && current.releaseTargetCommitSha !== operation.expectedTargetCommitSha) reasons.push("release target changed since proposal");
    if ("expectedDraft" in operation && current?.releaseDraft !== undefined && current.releaseDraft !== operation.expectedDraft) reasons.push("release draft state changed since proposal");
    if ("expectedPrerelease" in operation && current?.releasePrerelease !== undefined && current.releasePrerelease !== operation.expectedPrerelease) reasons.push("release prerelease state changed since proposal");
    if ("expectedPublished" in operation && current?.releasePublished !== undefined && current.releasePublished !== operation.expectedPublished) reasons.push("release publication state changed since proposal");
    if ("expectedReleaseUpdatedAt" in operation && current?.releaseUpdatedAt !== undefined && current.releaseUpdatedAt !== operation.expectedReleaseUpdatedAt) reasons.push("release changed since proposal");
  }

  const body = commentBody(operation);
  if (body !== undefined && body.length > policy.maxCommentLength) reasons.push("comment exceeds policy length limit");
  if (operation.kind === "commit.create") {
    if (operation.files.length > policy.maxChangedFiles) reasons.push("change exceeds policy file limit");
    for (const file of operation.files) if (changedFilePathDenied(file.path, policy.deniedPathPrefixes)) reasons.push(`path is denied by policy: ${file.path}`);
  }
  if (operation.kind === "pull_request.merge") {
    if (!policy.allowedMergeMethods.includes(operation.method)) reasons.push("merge method is not allowed");
    if (current?.branchProtectionAllowsMerge !== true) reasons.push("branch protection does not currently allow merge");
    // `expectedBranchProtectionHash` is optional on the operation because the
    // Actions target cannot read branch protection. This evaluator only runs on
    // installation-backed boundaries, which can, so a merge that arrives here
    // without a digest is denied rather than silently skipping the comparison.
    if (operation.expectedBranchProtectionHash === undefined) reasons.push("merge requires an expected branch protection hash");
    else if (current?.branchProtectionHash !== undefined && current.branchProtectionHash !== operation.expectedBranchProtectionHash) reasons.push("branch protection changed since proposal");
    const successful = new Set(current?.successfulChecks ?? []);
    for (const required of new Set([...policy.requiredChecks, ...operation.requiredChecks.map((check) => check.context)])) if (!successful.has(required)) reasons.push(`required check is not successful: ${required}`);
  }
  if (reasons.length) return { outcome: "denied", operationId: operation.id, mode, reasons };
  if (mode === "approval") return { outcome: "approval_required", operationId: operation.id, mode, reasons: ["human approval is required"] };
  return { outcome: "authorized", operationId: operation.id, mode, reasons: ["instance policy authorizes automatic execution"] };
}
