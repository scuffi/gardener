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
