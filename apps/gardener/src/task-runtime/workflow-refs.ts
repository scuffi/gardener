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
