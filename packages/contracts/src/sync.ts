import { z } from "zod";

/** A reusable workflow pinned to a full commit: `owner/repo/.github/workflows/file.yml@<sha>`. */
export const pinnedWorkflowRefPattern = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/\.github\/workflows\/[A-Za-z0-9_.\/-]+\.ya?ml@([0-9a-f]{40})$/;

/**
 * What the pinned sync bridge sends the runtime after a push to the default
 * branch: every task compiled from that commit, and the release its lock
 * pins. The bridge has already checked the committed lock and workflows match
 * that compile; the runtime re-validates each bundle and computes its hash.
 */
export const syncRequestV1Schema = z.strictObject({
  schemaVersion: z.literal("gardener.sync-request/v1"),
  /** The repository's default branch, from the event GitHub wrote for the run. */
  defaultBranch: z.string().min(1).max(255),
  /** The lock's `release.workflowRef`: the task workflow the tasks were generated for. */
  workflowRef: z.string().regex(pinnedWorkflowRefPattern),
  tasks: z.array(z.strictObject({
    taskId: z.string().min(1).max(160),
    /** The TASK.md path relative to `.gardener/`, as in the lock. */
    source: z.string().max(1024).regex(/^tasks\/(?!\.\.?\/)[A-Za-z0-9_.-]+\/TASK\.md$/),
    bundle: z.unknown(),
  })).max(100),
});
export type SyncRequestV1 = z.infer<typeof syncRequestV1Schema>;

/** The sync workflow that ships beside a pinned task workflow, at the same commit. */
export function syncWorkflowRefFor(taskWorkflowRef: string): string | null {
  const match = pinnedWorkflowRefPattern.exec(taskWorkflowRef);
  return match ? `${match[1]}/.github/workflows/gardener-sync.yml@${match[2]}` : null;
}

/** The task workflow that ships beside a pinned sync workflow, at the same commit. */
export function taskWorkflowRefFor(syncWorkflowRef: string): string | null {
  const match = pinnedWorkflowRefPattern.exec(syncWorkflowRef);
  return match ? `${match[1]}/.github/workflows/gardener-task.yml@${match[2]}` : null;
}
