import { taskBundleV1Schema, type TaskBundleV1, type TaskTriggerKindV1 } from "@gardener/contracts";
import { canonicalSha256 } from "@gardener/core";

export async function loadEnabledTaskBundle(
  db: D1Database,
  repositoryId: string,
  requestedHash: string,
): Promise<{ bundle: TaskBundleV1; bundleHash: string; sourcePath: string; manualOnly: boolean }> {
  const row = await db.prepare(
    "SELECT b.task_id,b.bundle_json,rt.task_id repository_task_id,rt.source_path FROM actions_task_bundles b " +
    "JOIN actions_repository_tasks rt ON rt.bundle_hash=b.bundle_hash " +
    "WHERE rt.repository_id=? AND rt.bundle_hash=? AND rt.enabled=1",
  ).bind(repositoryId, requestedHash).first<{
    task_id: string;
    bundle_json: string;
    repository_task_id: string;
    source_path: string;
  }>();
  if (!row) throw new Error("Task bundle is not enabled for the authenticated repository");

  const parsed = taskBundleV1Schema.safeParse(JSON.parse(row.bundle_json));
  if (!parsed.success) {
    // Enrolled by an older Gardener whose bundle format this runtime no longer reads.
    throw new Error(
      "Stored task bundle predates this Gardener runtime; rerun gardener upgrade for this repository and push the regenerated workflows",
    );
  }
  const bundle = parsed.data;
  if (bundle.taskId !== row.task_id || bundle.taskId !== row.repository_task_id) {
    throw new Error("Stored task bundle identity is inconsistent");
  }
  const bundleHash = await canonicalSha256(bundle);
  if (requestedHash !== bundleHash) {
    throw new Error("Stored task bundle hash does not match canonical bundle bytes");
  }
  return { bundle, bundleHash, sourcePath: row.source_path, manualOnly: bundle.draft === true };
}

/**
 * Draft tasks run only when dispatched by hand, never from a real event. The kind
 * is trusted here because the session has already matched it to the event name
 * GitHub signed into the OIDC claims.
 */
export function assertEnrollmentAdmitsEvent(
  enrollment: { taskId: string; manualOnly: boolean },
  kind: TaskTriggerKindV1,
): void {
  if (enrollment.manualOnly && kind !== "github.workflow_dispatch") {
    throw new Error(`Task ${enrollment.taskId} is a draft, so it runs only by hand and cannot run on ${kind}`);
  }
}
