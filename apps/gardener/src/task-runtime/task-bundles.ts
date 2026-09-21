import { taskBundleV1Schema, type TaskBundleV1 } from "@gardener/contracts";
import { canonicalSha256 } from "@gardener/core";

export async function loadEnabledTaskBundle(
  db: D1Database,
  repositoryId: string,
  requestedHash: string,
): Promise<{ bundle: TaskBundleV1; bundleHash: string }> {
  const row = await db.prepare(
    "SELECT b.task_id,b.bundle_json FROM actions_task_bundles b " +
    "JOIN actions_repository_tasks rt ON rt.bundle_hash=b.bundle_hash " +
    "WHERE rt.repository_id=? AND rt.bundle_hash=? AND rt.enabled=1",
  ).bind(repositoryId, requestedHash).first<{ task_id: string; bundle_json: string }>();
  if (!row) throw new Error("Task bundle is not enabled for the authenticated repository");

  const bundle = taskBundleV1Schema.parse(JSON.parse(row.bundle_json));
  if (bundle.taskId !== row.task_id) throw new Error("Stored task bundle identity is inconsistent");
  const bundleHash = await canonicalSha256(bundle);
  if (requestedHash !== bundleHash) {
    throw new Error("Stored task bundle hash does not match canonical bundle bytes");
  }
  return { bundle, bundleHash };
}
