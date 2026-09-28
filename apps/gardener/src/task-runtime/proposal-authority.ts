import {
  DEFAULT_WRITE_BRANCHES,
  bundleBranchPatterns,
  branchWriteFields,
  branchWriteRefusal,
  commitBaseRefusal,
  isBranchWriteKind,
  taskCheckoutSha,
  type TaskEffectProposalV1,
  type TaskRunRequestV1,
} from "@gardener/contracts";

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
): string | undefined {
  if (!(request.bundle.effects as readonly string[]).includes(proposal.kind)) {
    return `Task did not declare the ${proposal.kind} effect`;
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
  if (proposal.kind === "commit.create") {
    // The capture is taken from the checked-out commit.
    return commitBaseRefusal(proposal, earlier, taskCheckoutSha(request.bundle, request.event));
  }
  return undefined;
}
