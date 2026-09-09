import {
  observationCapabilitySchema,
  operationKindSchema,
  workspaceCapabilitySchema,
  type InstancePolicyV1,
  type PolicyMode,
} from "@gardener/contracts";

export async function getSetting(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

export async function setSetting(db: D1Database, key: string, value: string): Promise<void> {
  await db.prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP",
  ).bind(key, value).run();
}

export function repositoryPauseSetting(repositoryId: string): string {
  return `repository_paused:${repositoryId}`;
}

export type PauseScope = "global" | "repository";
export async function pauseScope(db: D1Database, repositoryId: string): Promise<PauseScope | null> {
  if ((await getSetting(db, "global_paused")) !== "false") return "global";
  return (await getSetting(db, repositoryPauseSetting(repositoryId))) === "true" ? "repository" : null;
}

export async function policySnapshot(db: D1Database): Promise<Record<string, PolicyMode>> {
  const { results } = await db.prepare(
    "SELECT operation_kind, mode FROM operation_policies ORDER BY operation_kind",
  ).all<{ operation_kind: string; mode: PolicyMode }>();
  return Object.fromEntries(results.map((row) => [row.operation_kind, row.mode]));
}

/** Construct the complete, versioned instance policy used for compilation/simulation snapshots. */
export async function instancePolicySnapshot(db: D1Database): Promise<InstancePolicyV1> {
  const [operationRows, capabilityRows] = await Promise.all([
    db.prepare("SELECT operation_kind, mode FROM operation_policies ORDER BY operation_kind")
      .all<{ operation_kind: string; mode: PolicyMode }>(),
    db.prepare("SELECT capability_kind, mode FROM instance_capability_policies ORDER BY capability_kind")
      .all<{ capability_kind: string; mode: PolicyMode }>(),
  ]);
  const operationModes = Object.fromEntries(operationKindSchema.options.map((kind) => [kind, "disabled"])) as Record<(typeof operationKindSchema.options)[number], PolicyMode>;
  for (const row of operationRows.results) {
    if (operationKindSchema.safeParse(row.operation_kind).success) operationModes[row.operation_kind as keyof typeof operationModes] = row.mode;
  }
  const allowedObservations: InstancePolicyV1["allowedObservations"] = [];
  const workspaceModes: InstancePolicyV1["workspaceModes"] = {};
  for (const row of capabilityRows.results) {
    const observation = observationCapabilitySchema.safeParse(row.capability_kind);
    if (observation.success && row.mode !== "disabled") allowedObservations.push(observation.data);
    const workspace = workspaceCapabilitySchema.safeParse(row.capability_kind);
    if (workspace.success) workspaceModes[workspace.data] = row.mode;
  }
  return {
    schemaVersion: "v1",
    id: "instance-policy:default",
    version: 1,
    operationModes,
    allowedObservations,
    workspaceModes,
    allowedMergeMethods: ["squash"],
    requiredChecks: [],
    maxCommentLength: 10_000,
    maxChangedFiles: 25,
    deniedPathPrefixes: [".github/workflows", ".github/dependabot.yml"],
  };
}

export async function audit(
  db: D1Database,
  actor: string,
  action: string,
  resourceType: string,
  resourceId: string,
  detail?: unknown,
): Promise<void> {
  await db.prepare(
    "INSERT INTO audit_records (actor, action, resource_type, resource_id, detail_json) VALUES (?, ?, ?, ?, ?)",
  ).bind(actor, action, resourceType, resourceId, detail === undefined ? null : JSON.stringify(detail)).run();
}
