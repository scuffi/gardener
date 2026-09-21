import { taskBundleV1Schema, type TaskBundleV1 } from "@gardener/contracts";
import { canonicalSha256 } from "@gardener/core";

export async function loadEnabledTaskBundle(
  db: D1Database,
  repositoryId: string,
  requestedHash: string,
): Promise<{ bundle: TaskBundleV1; bundleHash: string; sourcePath: string }> {
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

  const bundle = taskBundleV1Schema.parse(JSON.parse(row.bundle_json));
  if (bundle.taskId !== row.task_id || bundle.taskId !== row.repository_task_id) {
    throw new Error("Stored task bundle identity is inconsistent");
  }
  const bundleHash = await canonicalSha256(bundle);
  if (requestedHash !== bundleHash) {
    throw new Error("Stored task bundle hash does not match canonical bundle bytes");
  }
  return { bundle, bundleHash, sourcePath: row.source_path };
}
