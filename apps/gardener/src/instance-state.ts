import {
  agentRunSnapshotV1Schema,
  instancePolicyV1Schema,
  isInstallationBackedRepository,
  observationCapabilitySchema,
  operationKindSchema,
  policyModeSchema,
  workspaceCapabilitySchema,
  type AgentRunSnapshotV1,
  type InstancePolicyV1,
  type Operation,
  type PolicyMode,
} from "@gardener/contracts";
import {
  agentRunSnapshotHashContent,
  calculateAssignmentConfigHash,
  calculateRepositoryPolicyHash,
  calculateWorkspacePolicyHash,
  canonicalSha256,
  resolveEffectiveMode,
} from "@gardener/core";
import type { Env } from "./env";
import { getAssignment, getRun } from "./persistence";
import { getRepositoryPolicy } from "./repository-policy";

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

export type WorkspacePolicyErrorCode =
  | "policy_version_invalid"
  | "workspace_operation_policy_invalid"
  | "workspace_capability_policy_invalid";

/** Stable fail-closed classification for malformed persisted workspace policy. */
export class WorkspacePolicyReadError extends Error {
  readonly name = "WorkspacePolicyReadError";

  constructor(readonly code: WorkspacePolicyErrorCode) {
    super(code);
  }
}

export async function policySnapshot(db: D1Database): Promise<Record<string, PolicyMode>> {
  const { results } = await db.prepare(
    "SELECT operation_kind, mode FROM operation_policies ORDER BY operation_kind",
  ).all<{ operation_kind: string; mode: PolicyMode }>();
  return Object.fromEntries(results.map((row) => [row.operation_kind, row.mode]));
}

/** Construct and attest the complete workspace authority/constraint layer. */
export async function instancePolicySnapshot(db: D1Database): Promise<InstancePolicyV1> {
  const [versionValue, operationRows, capabilityRows] = await Promise.all([
    getSetting(db, "policy_version"),
    db.prepare("SELECT operation_kind, mode FROM operation_policies ORDER BY operation_kind")
      .all<{ operation_kind: string; mode: string }>(),
    db.prepare("SELECT capability_kind, mode FROM instance_capability_policies ORDER BY capability_kind")
      .all<{ capability_kind: string; mode: string }>(),
  ]);
  const version = Number(versionValue);
  if (versionValue === null || versionValue.trim() === "" || !Number.isSafeInteger(version) || version < 1) {
    throw new WorkspacePolicyReadError("policy_version_invalid");
  }

  const operationModes = Object.fromEntries(operationKindSchema.options.map((kind) => [kind, "disabled"])) as InstancePolicyV1["operationModes"];
  for (const row of operationRows.results) {
    const kind = operationKindSchema.safeParse(row.operation_kind);
    const mode = policyModeSchema.safeParse(row.mode);
    if (!kind.success || !mode.success) throw new WorkspacePolicyReadError("workspace_operation_policy_invalid");
    operationModes[kind.data] = mode.data;
  }
  const allowedObservations: InstancePolicyV1["allowedObservations"] = [];
  const workspaceModes: InstancePolicyV1["workspaceModes"] = {};
  for (const row of capabilityRows.results) {
    const mode = policyModeSchema.safeParse(row.mode);
    const observation = observationCapabilitySchema.safeParse(row.capability_kind);
    const workspace = workspaceCapabilitySchema.safeParse(row.capability_kind);
    // Unknown persisted rows are corruption, not forward-compatible authority:
    // this runtime cannot safely interpret them and therefore fails closed.
    if (!mode.success || (!observation.success && !workspace.success)) {
      throw new WorkspacePolicyReadError("workspace_capability_policy_invalid");
    }
    if (observation.success && mode.data !== "disabled") allowedObservations.push(observation.data);
    if (workspace.success) workspaceModes[workspace.data] = mode.data;
  }
  allowedObservations.sort();
  const draft = instancePolicyV1Schema.parse({
    schemaVersion: "v1",
    id: "instance-policy:default",
    version,
    policyHash: "0".repeat(64),
    operationModes,
    allowedObservations,
    workspaceModes,
    allowedMergeMethods: ["squash"],
    requiredChecks: [],
    maxCommentLength: 10_000,
    maxChangedFiles: 25,
    deniedPathPrefixes: [".github/workflows", ".github/dependabot.yml"],
  });
  return instancePolicyV1Schema.parse({ ...draft, policyHash: await calculateWorkspacePolicyHash(draft) });
}

export class LiveAuthorityReadError extends Error {
  readonly name = "LiveAuthorityReadError";
  readonly code = "live_authority_read_failed";
  readonly cause: unknown;

  constructor(cause: unknown) {
    super("Live assignment or policy could not be read");
    this.cause = cause;
  }
}

/** Re-read every mutable authority layer immediately before a bounded effect. */
export async function assertLiveAutomaticAuthority(env: Env, runId: string, operation: Operation): Promise<void> {
  let run: Awaited<ReturnType<typeof getRun>>;
  try {
    run = await getRun(env.DB, runId);
  } catch (cause) {
    throw new LiveAuthorityReadError(cause);
  }
  if (!run || !run.repositoryEventId || run.status !== "running") throw new Error("Run is not active");
  if (run.cancelRequestedAt) throw new Error("Run cancellation denies effect execution");
  const snapshot = agentRunSnapshotV1Schema.parse(run.runSnapshot);
  const frozenWorkspace = instancePolicyV1Schema.parse(run.policySnapshot);
  const [snapshotHash, workspaceHash] = await Promise.all([
    canonicalSha256(agentRunSnapshotHashContent(snapshot)),
    calculateWorkspacePolicyHash(frozenWorkspace),
  ]);
  if (
    snapshotHash !== snapshot.snapshotHash || snapshot.snapshotHash !== run.runSnapshotHash
    || workspaceHash !== frozenWorkspace.policyHash || frozenWorkspace.policyHash !== run.policySnapshotHash
    || snapshot.workspace.policyHash !== frozenWorkspace.policyHash || snapshot.workspace.policyVersion !== frozenWorkspace.version
    || !run.repositoryId || !run.assignmentId || run.assignmentVersion === null || !run.assignmentConfigHash
    || !run.repositoryPolicyHash || run.repositoryPolicyVersion === null
    || snapshot.repository.id !== run.repositoryId || snapshot.assignment.id !== run.assignmentId
    || snapshot.assignment.version !== run.assignmentVersion || snapshot.assignment.configHash !== run.assignmentConfigHash
    || snapshot.repository.policyHash !== run.repositoryPolicyHash || snapshot.repository.policyVersion !== run.repositoryPolicyVersion
    || operation.repository.id !== run.repositoryId
  ) throw new Error("Run snapshot or live binding integrity is invalid");

  if (operation.kind !== "issue.comment.create") throw new Error("The bounded runtime supports only issue.comment.create");
  const frozenMode = snapshot.effectiveCapabilities.effects.find((item) => item.capability === operation.kind)?.mode;
  if (frozenMode !== "automatic") throw new Error("Run snapshot does not authorize this automatic effect");
  let globalPaused;
  let repositoryPaused;
  try {
    globalPaused = await getSetting(env.DB, "global_paused");
    repositoryPaused = await getSetting(env.DB, repositoryPauseSetting(run.repositoryId));
  } catch (cause) {
    throw new LiveAuthorityReadError(cause);
  }
  if (globalPaused !== "false") throw new Error("Gardener is globally paused");
  if (repositoryPaused === "true") throw new Error("Repository is paused");

  // Operations planned by the Actions target carry no installation identity.
  // This is the installation-backed runtime, so a missing installation must
  // fail loudly instead of binding `undefined` into the authority query and
  // matching whatever row that produces.
  if (!isInstallationBackedRepository(operation.repository)) {
    throw new Error("The installation-backed runtime requires an installation-bound operation");
  }
  const installationId = operation.repository.installationId;

  let live: { active: number; revision_id: string | null } | null;
  try {
    live = await env.DB.prepare(`
      SELECT r.active, aa.revision_id
      FROM repositories r
      LEFT JOIN agent_activations aa ON aa.agent_id = ?
      WHERE r.id = ? AND r.installation_id = ?
    `).bind(run.agentId, run.repositoryId, installationId)
      .first<{ active: number; revision_id: string | null }>();
  } catch (cause) {
    throw new LiveAuthorityReadError(cause);
  }
  if (live?.active !== 1 || live.revision_id !== run.agentRevisionId) {
    throw new Error("Repository or active Agent revision no longer authorizes the effect");
  }

  let assignment;
  let workspacePolicy;
  let repositoryPolicy;
  try {
    [assignment, workspacePolicy, repositoryPolicy] = await Promise.all([
      getAssignment(env.DB, run.assignmentId),
      instancePolicySnapshot(env.DB),
      getRepositoryPolicy(env.DB, run.repositoryId),
    ]);
  } catch (cause) {
    throw new LiveAuthorityReadError(cause);
  }
  if (!assignment || !assignment.enabled || assignment.removedAt !== null
    || assignment.agentId !== run.agentId || assignment.repositoryId !== run.repositoryId
    || await calculateAssignmentConfigHash(assignment) !== assignment.configHash) {
    throw new Error("The bound assignment is no longer enabled or valid");
  }
  if (!repositoryPolicy?.configured || !repositoryPolicy.repository.active
    || await calculateRepositoryPolicyHash(repositoryPolicy.policy) !== repositoryPolicy.policy.policyHash) {
    throw new Error("Repository policy is not completely configured or valid");
  }
  const liveMode = resolveEffectiveMode(
    workspacePolicy.operationModes[operation.kind],
    repositoryPolicy.policy.operationModes[operation.kind],
    // frozenMode is the already-composed frozen effective mode; placing it in
    // a ceiling slot computes min(frozen, all live layers), so widening cannot upgrade.
    frozenMode,
    assignment.authorityCeiling,
  );
  if (liveMode !== "automatic") throw new Error("Live authority has narrowed below automatic execution");
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
