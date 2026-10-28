import {
  DEFAULT_WRITE_BRANCHES,
  bundleBranchPatterns,
  branchWriteFields,
  branchWriteRefusal,
  commitBaseRefusal,
  impliedEffectKinds,
  isBranchWriteKind,
  checksOutPullRequestHead,
  dispatchTargetKinds,
  isPlanFieldEffectKind,
  MESSAGE_SEND_KIND,
  messageFromSendPayload,
  messageSendPayloadV1Schema,
  messageTriggerScopeRefusal,
  normalizedPullRequest,
  TASK_RUN_KIND,
  TASK_RUN_MAX_DEPTH,
  taskCheckoutSha,
  taskRunPayloadV1Schema,
  taskRunSubjectFromProposal,
  taskRunSubjectRefusal,
  taskEventBindingFromNormalizedEvent,
  triggeringPullRequestRefusal,
  triggerScopeRefusal,
  type OperationKind,
  type TaskBundleV1,
  type TaskEffectProposalV1,
  type TaskEventResourceV1,
  type TaskRunRequestV1,
} from "@gardener/contracts";
import { planCapabilityAdvice, planCarries } from "./workflow-refs";

/** Where a run's steps may act: anywhere the task allows, or only on what triggered it. */
export type RunEffectScope = "trigger" | "repository";

/**
 * The run's effect scope. Trigger scope when the task asks for it, or when
 * the starter is not known to be trusted: a request admitted before starters
 * existed has none, and absent means untrusted, which only narrows.
 */
export function runEffectScope(request: Pick<TaskRunRequestV1, "bundle" | "starter">): RunEffectScope {
  return request.bundle.effectScope === "trigger" || request.starter?.trusted !== true ? "trigger" : "repository";
}

/** Why the run is confined, in words that end a refusal. */
export function triggerScopeReason(request: Pick<TaskRunRequestV1, "bundle" | "starter">): string {
  if (request.bundle.effectScope === "trigger") return "the task sets effect-scope: trigger";
  switch (request.starter?.reason) {
    case "bot": return "a bot started it";
    case "fork_head": return "its pull request head is in another repository";
    case "author_not_maintainer": return "the author who started it is not a maintainer";
    case "actor_not_maintainer": return "whoever started it does not have write access";
    case undefined: return "it was admitted before Gardener recorded who started runs";
    default: return "Gardener could not confirm that whoever started it has write access";
  }
}

/**
 * Why this step may not run under trigger scope, or `undefined`. `earlier`
 * are the plan's steps before it. Every layer (proposal, plan build, plan
 * schema at apply) calls the same pure `triggerScopeRefusal`, so they cannot
 * disagree; this adds only the reason the run is confined.
 */
export function runTriggerScopeRefusal(
  request: Pick<TaskRunRequestV1, "bundle" | "starter">,
  step: Pick<TaskEffectProposalV1, "kind" | "payload" | "references">,
  earlier: readonly Pick<TaskEffectProposalV1, "stepName" | "kind">[],
  resource: TaskEventResourceV1 | null,
): string | undefined {
  if (runEffectScope(request) !== "trigger") return undefined;
  if (step.kind === MESSAGE_SEND_KIND) {
    const parsed = messageSendPayloadV1Schema.safeParse(step.payload);
    // The proposal contract has already refused a malformed payload.
    if (!parsed.success) return "message.send payload is not a valid message";
    const refusal = messageTriggerScopeRefusal(messageFromSendPayload(parsed.data).subject, resource);
    return refusal === undefined ? undefined : `${refusal} (confined because ${triggerScopeReason(request)})`;
  }
  const kinds = new Map(operationSteps(earlier).map((candidate) => [candidate.stepName, candidate.kind as OperationKind] as const));
  const refusal = triggerScopeRefusal(step.kind, step.payload, step.references, resource, kinds);
  return refusal === undefined ? undefined : `${refusal} (confined because ${triggerScopeReason(request)})`;
}

/** The steps that become operations: a message or task run is never an earlier step anything can reference. */
export function operationSteps<Step extends Pick<TaskEffectProposalV1, "kind">>(steps: readonly Step[]): Step[] {
  return steps.filter((step) => !isPlanFieldEffectKind(step.kind));
}

/**
 * Why this run may not start this task, or `undefined`, from what the request
 * alone decides. The target must be one the task declared and not the task
 * itself; one per run; not from a run already at the deepest a chain may go;
 * on this run's own subject or a pull request this plan opens; and only on a
 * task workflow whose apply step can dispatch, since an older one would refuse
 * the whole plan. Whether the target is an enabled task of this repository
 * that takes the subject is `taskRunTargetRefusal`, which needs its bundle.
 */
export function taskRunProposalRefusal(
  request: Pick<TaskRunRequestV1, "bundle" | "event" | "lineage">,
  proposal: TaskEffectProposalV1,
  earlier: readonly Pick<TaskEffectProposalV1, "stepName" | "kind">[],
): string | undefined {
  const workflowRef = request.event.workflow.jobWorkflowRef;
  if (!planCarries("taskRuns", workflowRef)) return planCapabilityAdvice("task.run", workflowRef);
  const previous = earlier.find((step) => step.kind === TASK_RUN_KIND);
  if (previous !== undefined) {
    return `A run starts at most one task, and step ${previous.stepName} already starts one`;
  }
  const depth = request.lineage?.depth ?? 0;
  if (depth >= TASK_RUN_MAX_DEPTH) {
    return `task.run is refused: this run was started by another at depth ${depth}, and a chain of started runs may be at most ${TASK_RUN_MAX_DEPTH} deep`;
  }
  const payload = taskRunPayloadV1Schema.safeParse(proposal.payload);
  // The proposal contract has already refused a malformed payload.
  if (!payload.success) return "task.run payload is not a valid task run";
  const { task } = payload.data;
  if (task === request.bundle.taskId) return `task.run may not start task ${task} itself`;
  const declared = request.bundle.effectOptions?.[TASK_RUN_KIND]?.tasks ?? [];
  if (!declared.includes(task)) {
    return `Task did not declare ${task} under task.run; it may start ${declared.length === 0 ? "no task" : declared.join(", ")}`;
  }
  const subject = taskRunSubjectFromProposal(payload.data, proposal.references);
  if (subject === undefined) return "task.run needs exactly one subject";
  const kinds = new Map(operationSteps(earlier).map((step) => [step.stepName, step.kind as OperationKind] as const));
  return taskRunSubjectRefusal(subject, taskEventBindingFromNormalizedEvent(request.event).resource, kinds);
}

/**
 * Why the repository's enabled task `taskId`, whose bundle is `target` (or
 * `undefined` when there is no such enabled task), cannot be started on a
 * subject of this kind. The Worker resolves the target from the enrolled
 * tasks, never from the plan, and its generated workflow must offer the
 * subject as a dispatch input or the started run would refuse it.
 */
export function taskRunTargetRefusal(
  taskId: string,
  target: Pick<TaskBundleV1, "taskId" | "triggers" | "effectOptions" | "checkout" | "effects"> | undefined,
  subjectKind: "issue" | "pull_request",
): string | undefined {
  if (target === undefined || target.taskId !== taskId) {
    return `task.run cannot start ${taskId}: it is not an enabled task of this repository. Commit it under .gardener/tasks and let the sync enrol it`;
  }
  const offered = dispatchTargetKinds(target.triggers, { pullRequestHead: checksOutPullRequestHead(target) });
  if (!offered.includes(subjectKind)) {
    const input = subjectKind === "issue" ? "an issue" : "a pull request";
    return `task.run cannot start ${taskId} on ${input}: its workflow takes no ${subjectKind} input. Give it a trigger on ${subjectKind === "issue" ? "issues" : "pull requests"}, or github.workflow_dispatch with subject: ${subjectKind}`;
  }
  return undefined;
}

/**
 * Why this run may not send this message, or `undefined`. One message per run;
 * it must be about something this run may act on; and the run's task workflow
 * must have an apply step that sends messages, since an older one would
 * refuse the whole plan.
 */
export function messageProposalRefusal(
  request: Pick<TaskRunRequestV1, "bundle" | "event" | "starter">,
  proposal: TaskEffectProposalV1,
  earlier: readonly Pick<TaskEffectProposalV1, "stepName" | "kind">[],
): string | undefined {
  const workflowRef = request.event.workflow.jobWorkflowRef;
  if (!planCarries("messages", workflowRef)) return planCapabilityAdvice("message.send", workflowRef);
  const previous = earlier.find((step) => step.kind === MESSAGE_SEND_KIND);
  if (previous !== undefined) {
    return `A run sends at most one message, and step ${previous.stepName} already sends one`;
  }
  return runTriggerScopeRefusal(request, proposal, earlier, taskEventBindingFromNormalizedEvent(request.event).resource);
}

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
  request: Pick<TaskRunRequestV1, "bundle" | "event" | "starter" | "lineage">,
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
  // A started task runs once everything else applied, and nothing can be
  // proposed after it: a later step that failed would stop the plan with the
  // dispatch already out, and an earlier one that failed must stop it before.
  const taskRun = earlier.find((step) => step.kind === TASK_RUN_KIND);
  if (taskRun !== undefined) {
    return `task.run must be the last step, and step ${taskRun.stepName} already starts a task; add ${proposal.kind} before it`;
  }
  // A message or task run is not an operation: none of the operation rules
  // below apply, and each has its own.
  if (proposal.kind === MESSAGE_SEND_KIND) return messageProposalRefusal(request, proposal, earlier);
  if (proposal.kind === TASK_RUN_KIND) return taskRunProposalRefusal(request, proposal, earlier);
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
  const resource = taskEventBindingFromNormalizedEvent(request.event).resource;
  const pullRefusal = triggeringPullRequestRefusal(proposal.kind, proposal.payload, proposal.references, resource);
  if (pullRefusal !== undefined) return pullRefusal;
  // Beside the check above, never instead of it: both apply, so the stricter wins.
  const scopeRefusal = runTriggerScopeRefusal(request, proposal, earlier, resource);
  if (scopeRefusal !== undefined) return scopeRefusal;
  // One capture serves one commit, and a merge capture can only become a
  // merge commit, so a run merges or makes ordinary commits, never both.
  const other = proposal.kind === "commit.create" ? "commit.merge_base" : proposal.kind === "commit.merge_base" ? "commit.create" : undefined;
  if (other !== undefined && earlier.some((step) => step.kind === other)) {
    return `A run either merges the base branch (commit.merge_base) or makes ordinary commits (commit.create), not both; step ${earlier.find((step) => step.kind === other)!.stepName} already uses ${other}`;
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
