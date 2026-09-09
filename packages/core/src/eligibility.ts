import {
  compiledAgentRevisionV1Schema,
  eventEligibilityDecisionSchema,
  repositoryEventTrigger,
  repositoryEventV2Schema,
  type CompiledAgentRevisionV1,
  type EventEligibilityDecision,
  type RepositoryEventV2,
} from "@gardener/contracts";

function eventLabels(event: RepositoryEventV2): readonly string[] | undefined {
  if ("issue" in event) return event.issue.labels;
  if ("pullRequest" in event) return event.pullRequest.labels;
  if ("discussion" in event) return event.discussion.labels;
  return undefined;
}
function pullFacts(event: RepositoryEventV2): { base?: string; draft?: boolean } {
  return "pullRequest" in event ? { base: event.pullRequest.base.ref, draft: event.pullRequest.draft } : {};
}

/** Eligibility uses only bounded, typed event facts and fails closed when a required fact is absent. */
export function evaluateEventEligibility(
  revisionInput: CompiledAgentRevisionV1 | unknown,
  eventInput: RepositoryEventV2 | unknown,
): EventEligibilityDecision {
  const revision = compiledAgentRevisionV1Schema.parse(revisionInput);
  const event = repositoryEventV2Schema.parse(eventInput);
  const reasons: string[] = [];
  const trigger = repositoryEventTrigger(event);
  if (!revision.spec.triggers.includes(trigger)) reasons.push("event trigger is not selected by the agent revision");
  if (!revision.repositories.some((repository) => repository.id === event.repository.id)) reasons.push("repository is outside the immutable agent revision scope");
  const rules = revision.spec.eligibility;
  if (rules.actorIds.length) {
    if (event.kind === "gardener.manual" || event.kind === "gardener.scheduled") reasons.push("event actor is not a GitHub identity");
    else if (!rules.actorIds.includes(event.actor.id)) reasons.push("event actor is not eligible");
  }
  if (rules.resourceAuthorIds.length) {
    if (!event.resourceAuthor) reasons.push("resource author fact is missing");
    else if (!rules.resourceAuthorIds.includes(event.resourceAuthor.id)) reasons.push("resource author is not eligible");
  }
  if (rules.labelsAny.length || rules.labelsAll.length) {
    const labels = eventLabels(event);
    if (!labels) reasons.push("label facts are unavailable for this event kind");
    else {
      if (rules.labelsAny.length && !rules.labelsAny.some((label) => labels.includes(label))) reasons.push("none of the required alternative labels are present");
      if (rules.labelsAll.some((label) => !labels.includes(label))) reasons.push("one or more required labels are absent");
    }
  }
  const pull = pullFacts(event);
  if (rules.baseBranches.length) {
    if (!pull.base) reasons.push("pull request base branch fact is missing");
    else if (!rules.baseBranches.includes(pull.base)) reasons.push("pull request base branch is not eligible");
  }
  if (!rules.includeDraftPullRequests && pull.draft === true) reasons.push("draft pull requests are not eligible");
  return eventEligibilityDecisionSchema.parse({ eligible: reasons.length === 0, reasons, matchedTrigger: revision.spec.triggers.includes(trigger) ? trigger : null });
}
