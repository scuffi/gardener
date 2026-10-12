import {
  DEFAULT_WRITE_BRANCHES,
  bundleBranchPatterns,
  branchWriteFields,
  branchWriteRefusal,
  commitBaseRefusal,
  impliedEffectKinds,
  isBranchWriteKind,
  normalizedPullRequest,
  taskCheckoutSha,
  taskEventBindingFromNormalizedEvent,
  triggeringPullRequestRefusal,
  type TaskEffectProposalV1,
  type TaskRunRequestV1,
} from "@gardener/contracts";

/**
 * What the session knows about the run's working tree when a proposal
 * arrives: the merge `repository.merge_base` wrote, or `undefined` when none
 * was written. Once written, the capture is a merge capture, which only
 * `commit.merge_base` can commit, at the base commit merged.
 */
export interface ProposalWorkspaceState {
  readonly writtenMerge: { readonly baseSha: string } | undefined;
}

/**
 * Why the task may not propose this step, or `undefined` when it may.
 *
 * Checked as each proposal arrives so the model hears about a refused branch
 * or commit base while it can still change course. The plan contract and
 * apply check the same rules again; this is only the earliest of the three.
 */
export function proposalAuthorityRefusal(
  request: Pick<TaskRunRequestV1, "bundle" | "event">,
  proposal: TaskEffectProposalV1,
  earlier: readonly TaskEffectProposalV1[],
  /** Omitted only by callers that check no working-tree state (the plan rechecks it). */
  workspace?: ProposalWorkspaceState,
): string | undefined {
  if (!(request.bundle.effects as readonly string[]).includes(proposal.kind)) {
    return `Task did not declare the ${proposal.kind} effect`;
  }
  const implied = impliedEffectKinds(proposal.kind, proposal.payload, proposal.references)
    .find((kind) => !(request.bundle.effects as readonly string[]).includes(kind));
  if (implied !== undefined) {
    return `Labels on ${proposal.kind} need the ${implied} effect, which the task did not declare`;
  }
  if (isBranchWriteKind(proposal.kind)) {
    const field = branchWriteFields[proposal.kind];
    const branch = (proposal.payload as Record<string, unknown>)[field];
    if (proposal.references[`/${field}`] === undefined && typeof branch === "string") {
      const refusal = branchWriteRefusal(
        proposal.kind,
        branch,
        bundleBranchPatterns(request.bundle)?.[proposal.kind] ?? DEFAULT_WRITE_BRANCHES,
        request.event.repository.defaultBranch,
      );
      if (refusal !== undefined) return refusal;
    }
  }
  const pullRefusal = triggeringPullRequestRefusal(
    proposal.kind,
    proposal.payload,
    proposal.references,
    taskEventBindingFromNormalizedEvent(request.event).resource,
  );
  if (pullRefusal !== undefined) return pullRefusal;
  // One capture serves one commit, and a merge capture can only become a
  // merge commit, so a run merges or makes ordinary commits, never both.
  const other = proposal.kind === "commit.create" ? "commit.merge_base" : proposal.kind === "commit.merge_base" ? "commit.create" : undefined;
  if (other !== undefined && earlier.some((step) => step.kind === other)) {
    return `A run either merges the base branch (commit.merge_base) or makes ordinary commits (commit.create), not both; step ${earlier.find((step) => step.kind === other)!.stepName} already proposed ${other}`;
  }
  // Told now, while the model can still change course, rather than when the
  // capture is admitted after its last turn and the plan can only fail.
  if (workspace !== undefined) {
    const written = workspace.writtenMerge;
    if (proposal.kind === "commit.create" && written !== undefined) {
      return "The working tree holds the merge repository.merge_base wrote, which only commit.merge_base can commit; a run either merges or makes ordinary commits, not both";
    }
    if (proposal.kind === "commit.merge_base") {
      if (written === undefined) {
        return "commit.merge_base commits the merge repository.merge_base writes; call repository.merge_base first, before changing anything";
      }
      const baseSha = (proposal.payload as Record<string, unknown>).baseSha;
      if (proposal.references["/baseSha"] === undefined && (typeof baseSha !== "string" || baseSha.toLowerCase() !== written.baseSha)) {
        return `commit.merge_base baseSha must be ${written.baseSha}, the base commit repository.merge_base merged`;
      }
    }
  }
  if (proposal.kind === "commit.create") {
    // The capture is taken from the checked-out commit.
    return commitBaseRefusal(proposal, earlier, taskCheckoutSha(request.bundle, request.event));
  }
  if (proposal.kind === "commit.merge_base") return mergeBaseProposalRefusal(request, proposal);
  return undefined;
}

/**
 * Why this `commit.merge_base` does not match the pull request the run
 * checked out, or `undefined` when it does. Every value must equal what
 * `repository.merge_base` returned, which came from this same event: the
 * branch and base branch from the pull request, the head from the confirmed
 * checkout. They are compared directly, so none may come by reference. The
 * base commit is checked against the merge capture when the plan is built.
 */
export function mergeBaseProposalRefusal(
  request: Pick<TaskRunRequestV1, "bundle" | "event">,
  proposal: Pick<TaskEffectProposalV1, "payload" | "references">,
): string | undefined {
  const pullRequest = normalizedPullRequest(request.event);
  if (pullRequest === undefined || request.event.checkoutSha === undefined) {
    return "commit.merge_base needs a run on a pull request's checked-out head, and this run is not on one";
  }
  for (const field of ["branch", "expectedHeadSha", "baseBranch", "baseSha"]) {
    if (proposal.references[`/${field}`] !== undefined) return `commit.merge_base ${field} must be written directly, not by reference`;
  }
  const payload = proposal.payload as Record<string, unknown>;
  if (payload.branch !== pullRequest.head.ref) {
    return `commit.merge_base branch must be the pull request's branch ${pullRequest.head.ref}`;
  }
  const checkoutSha = taskCheckoutSha(request.bundle, request.event);
  // taskCheckoutSha prefers checkoutSha for a bundle that checks out the head,
  // which every commit.merge_base bundle does; the second comparison keeps
  // this rule from resting on that.
  if (typeof payload.expectedHeadSha !== "string" || payload.expectedHeadSha.toLowerCase() !== checkoutSha
    || checkoutSha !== request.event.checkoutSha) {
    return `commit.merge_base expectedHeadSha must be the checked-out head ${request.event.checkoutSha}`;
  }
  if (payload.baseBranch !== pullRequest.base.ref) {
    return `commit.merge_base baseBranch must be the pull request's base branch ${pullRequest.base.ref}`;
  }
  return undefined;
}
