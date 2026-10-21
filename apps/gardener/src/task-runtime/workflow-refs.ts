import { pinnedWorkflowRefPattern, taskWorkflowRefFor } from "@gardener/contracts";

/**
 * The task workflows a repository's runs may come from: the release it is
 * enrolled on, and the release this Worker was deployed from. Accepting the
 * Worker's own release closes the window between an upgrade merging and its
 * sync landing, when the new workflows already run but the enrollment still
 * names the old ones. Both must be the same repository's workflows, so an
 * enrollment pinned elsewhere never gains the release, and nothing older than
 * the enrollment is ever accepted.
 *
 * This anchors on the enrolled ref's repository; `/v1/sync` anchors on the
 * release's. Either way a ref from another repository is never promoted, and
 * `connect` refuses locks pinned elsewhere, so only a legacy enrollment could
 * tell them apart. Don't relax either.
 */
export function trustedTaskWorkflowRefs(enrolled: string | null, release: string | undefined): string[] {
  if (!enrolled) return [];
  const refs = [enrolled];
  const enrolledRepository = pinnedWorkflowRefPattern.exec(enrolled)?.[1];
  const releaseMatch = release ? pinnedWorkflowRefPattern.exec(release) : null;
  const releaseTask = release ? taskWorkflowRefFor(release) : null;
  if (enrolledRepository && releaseMatch && releaseMatch[1] === enrolledRepository && releaseTask && releaseTask !== enrolled) {
    refs.push(releaseTask);
  }
  return refs;
}

/**
 * Advice for a workflow or payload this runtime does not accept. The usual
 * cause is a repository and runtime on different releases, so name both and
 * the one command that realigns them: `gardener upgrade` redeploys the runtime
 * and then moves the repository, both to the CLI's own release. Older runtimes
 * keep whatever wording they shipped with, which is why this lives here.
 */
export function releaseMismatchAdvice(runtimeRelease: string | undefined, workflowRef?: string): string {
  const runtimeCommit = runtimeRelease === undefined ? undefined : releaseCommit(runtimeRelease);
  const runtime = runtimeRelease === undefined
    ? "This runtime has no release pin"
    : runtimeCommit
      ? `This runtime is on Gardener release ${runtimeCommit}`
      : "This runtime's release pin is malformed";
  const workflowCommit = workflowRef ? releaseCommit(workflowRef) : undefined;
  const workflow = workflowCommit ? ` and this workflow is on ${workflowCommit}` : "";
  // Reaching here usually means the repository moved first: the runtime keeps
  // trusting the older enrolled release, so a runtime ahead of it never errors.
  const cli = workflowCommit ? `this workflow's release (${workflowCommit})` : "the release this repository is pinned to";
  return `${runtime}${workflow}. Usually the repository was upgraded first: run gardener upgrade --workspace <name> with the Gardener CLI from ${cli}, which redeploys the runtime and then moves the repository to it, then rerun.`;
}

function releaseCommit(ref: string): string | undefined {
  return /@([a-f0-9]{40})$/.exec(ref)?.[1]?.slice(0, 12);
}

/**
 * The task workflow commits of releases whose apply bridge predates a plan
 * field, keyed by the field. Those bridges parse plans strictly, so a plan
 * carrying the field would fail every run of these releases; the Worker leaves
 * it out for them and still enforces what it guards when it proposes and builds
 * the plan. Keyed by commit, as the CLI's lists are, so a release's workflow is
 * recognised wherever it is pinned from.
 *
 * Each set is frozen once the release that adds its field ships: a release that
 * supports the field is absent, which means "carries it". Capabilities are only
 * ever added, so a later set contains every earlier one. Release-blocking:
 * scripts/check-release-pins.mjs reads each released tag's contracts and checks
 * every tag's workflow is listed exactly for the fields it lacks, and that the
 * current release's workflow is in no set.
 */
export const TASK_WORKFLOWS_WITHOUT: Readonly<Record<PlanCapability, ReadonlySet<string>>> = (() => {
  // 0.1.0–0.1.16: no `effectScope`.
  const beforeEffectScope = [
    "ec7eded3ffeae332f745200e270f3601d8b35aa8", // 0.1.0–0.1.2
    "aad5c2bb2560f5a2f9830f9ff4d9456dd48985a4", // 0.1.3
    "ce457eb2b4ec4ea85f2e6e5dd9ce794d196da711", // 0.1.4–0.1.6
    "3a0bc85d1f5cffccb50fba787b18334e4c21ba72", // 0.1.7
    "aae337cf4d2ad0c5fa33771c37cc811eccf39ff0", // 0.1.8
    "de534dff93a56527b45db8f46aedac72c8911da0", // 0.1.9
    "f3aca211a4ee2559f3df05cac12836090127812a", // 0.1.10
    "8e5fa4f844bfe26ff1d152757caf4ac0110ff6ef", // 0.1.11
    "868542c32a2a0684ded8cc1be3d6b2cfa1b0d62d", // 0.1.12
    "8aa3054967ee696be08ff61936c72e199c750ba7", // 0.1.13–0.1.14
    "4007bf661f62730882de20dd2df36b30c3e4a593", // 0.1.15
    "242825edd810a0219e008e3d68081c5cde6dc1ee", // 0.1.16
  ];
  // 0.1.0–0.1.17: no `messages`.
  const beforeMessages = [
    ...beforeEffectScope,
    "5c9c136ffd6b2e545f398dc413a60e04b66da406", // 0.1.17
  ];
  return {
    effectScope: new Set(beforeEffectScope),
    messages: new Set(beforeMessages),
  };
})();

/** The optional plan fields an older release's apply bridge may not accept. */
export type PlanCapability = "effectScope" | "messages";

/** Whether a plan for a run of this task workflow may carry the capability's field. */
export function planCarries(capability: PlanCapability, jobWorkflowRef: string): boolean {
  return !TASK_WORKFLOWS_WITHOUT[capability].has(jobWorkflowRef.slice(jobWorkflowRef.lastIndexOf("@") + 1));
}

/**
 * Advice for a proposal this run's task workflow cannot carry: its apply step
 * predates the plan field, so the repository must move to a newer release.
 * The opposite direction to `releaseMismatchAdvice`, which is why it is its own.
 */
export function planCapabilityAdvice(effect: string, jobWorkflowRef: string): string {
  const commit = releaseCommit(jobWorkflowRef);
  const release = commit === undefined ? "this run's task workflow" : `this run's task workflow (release ${commit})`;
  return `${effect} is not supported by ${release}, whose apply step predates it. Run gardener upgrade --workspace <name> with the current Gardener CLI to move the repository to a release that supports it, then rerun.`;
}
