import initialSchema from "../migrations/0001_initial.sql";
import agentNativeReset from "../migrations/0004_agent_native_reset.sql";
import agentRuntimeAdmission from "../migrations/0005_agent_runtime_admission.sql?raw";
import flueHarnessRequests from "../migrations/0006_flue_harness_requests.sql?raw";
import teamWorkspaceFoundation from "../migrations/0007_team_workspace_foundation.sql?raw";
import flueNativeRuntime from "../migrations/0008_flue_native_runtime.sql?raw";
import starterAgents from "../migrations/0009_starter_agents.sql?raw";
import actionsTaskRuntime from "../migrations/0010_actions_task_runtime.sql?raw";
import actionsTaskBundles from "../migrations/0011_actions_task_bundles.sql?raw";

export const AGENT_SCHEMA_VERSION = 11;

const initialization = new WeakMap<object, Promise<void>>();

/**
 * D1 accepts one prepared statement at a time. Keep trigger bodies intact while
 * splitting the migration files and ignore PRAGMAs (D1 controls them itself).
 */
export function migrationStatements(sql: string): string[] {
  const result: string[] = [];
  let buffer = "";
  let trigger = false;

  for (const rawLine of sql.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!buffer && (!line || line.startsWith("--") || /^PRAGMA\b/i.test(line))) continue;
    if (!line || line.startsWith("--")) continue;

    buffer += `${rawLine}\n`;
    if (!trigger && /^\s*CREATE\s+TRIGGER\b/i.test(buffer)) trigger = true;

    if (trigger) {
      if (/^\s*END;\s*$/i.test(rawLine)) {
        result.push(buffer.trim().replace(/;\s*$/, ""));
        buffer = "";
        trigger = false;
      }
      continue;
    }

    if (/;\s*$/.test(rawLine)) {
      result.push(buffer.trim().replace(/;\s*$/, ""));
      buffer = "";
    }
  }

  if (buffer.trim()) result.push(buffer.trim().replace(/;\s*$/, ""));
  return result;
}

async function tableExists(db: D1Database, name: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .bind(name)
    .first<{ name: string }>();
  return row !== null;
}

async function installedVersion(db: D1Database): Promise<number | null> {
  if (!(await tableExists(db, "gardener_schema"))) return null;
  const row = await db
    .prepare("SELECT version FROM gardener_schema WHERE singleton = 1")
    .first<{ version: number }>();
  return row?.version ?? null;
}

async function apply(db: D1Database, sql: string): Promise<void> {
  const prepared = migrationStatements(sql).map((statement) => db.prepare(statement));
  if (prepared.length > 0) await db.batch(prepared);
}

async function initialize(db: D1Database): Promise<void> {
  const version = await installedVersion(db);
  if (version === AGENT_SCHEMA_VERSION) return;

  if (version !== null) {
    const migrationsByVersion: Record<number, readonly string[]> = {
      4: [agentRuntimeAdmission, flueHarnessRequests, teamWorkspaceFoundation, flueNativeRuntime, starterAgents, actionsTaskRuntime, actionsTaskBundles],
      5: [flueHarnessRequests, teamWorkspaceFoundation, flueNativeRuntime, starterAgents, actionsTaskRuntime, actionsTaskBundles],
      6: [teamWorkspaceFoundation, flueNativeRuntime, starterAgents, actionsTaskRuntime, actionsTaskBundles],
      7: [flueNativeRuntime, starterAgents, actionsTaskRuntime, actionsTaskBundles],
      8: [starterAgents, actionsTaskRuntime, actionsTaskBundles],
      9: [actionsTaskRuntime, actionsTaskBundles],
      10: [actionsTaskBundles],
    };
    const migrations = migrationsByVersion[version];
    if (!migrations) throw new Error(`Unsupported Gardener database schema version ${version}`);
    for (const migration of migrations) await apply(db, migration);
    if ((await installedVersion(db)) !== AGENT_SCHEMA_VERSION) {
      throw new Error("Gardener Actions task runtime migration did not complete");
    }
    return;
  }

  const legacy = await tableExists(db, "workflows")
    || await tableExists(db, "workflow_revisions")
    || await tableExists(db, "events")
    || await tableExists(db, "runs")
    || await tableExists(db, "proposals")
    || await tableExists(db, "audit_records");

  try {
    await apply(db, legacy ? agentNativeReset : initialSchema);
    if (!legacy) {
      // 0001 intentionally leaves the marker empty. First-use provisioning
      // establishes the historical v4 baseline before applying later migrations.
      await db.prepare("INSERT INTO gardener_schema (singleton, version) VALUES (1, 4)").run();
    }
    for (const migration of [agentRuntimeAdmission, flueHarnessRequests, teamWorkspaceFoundation, flueNativeRuntime, starterAgents, actionsTaskRuntime, actionsTaskBundles]) {
      await apply(db, migration);
    }
  } catch (error) {
    // 0004's first write is a plain unique INSERT in the same atomic batch. A
    // losing initializer aborts before any DROP. Fresh initializers race only
    // on the marker after applying an entirely idempotent schema.
    if ((await installedVersion(db)) !== AGENT_SCHEMA_VERSION) throw error;
  }

  if ((await installedVersion(db)) !== AGENT_SCHEMA_VERSION) {
    throw new Error("Gardener Actions task runtime schema initialization did not complete");
  }
}

/**
 * Deploy to Cloudflare provisions D1 but does not run Wrangler migrations.
 * Fresh databases receive the Agent-native schema. Databases from 0001-0003
 * receive the guarded historical reset. The v6-to-v7 pre-V1 cutover also
 * removes test-only Agent/runtime data while preserving repositories and policy.
 */
export function ensureDatabase(db: D1Database): Promise<void> {
  const key = db as unknown as object;
  const existing = initialization.get(key);
  if (existing) return existing;

  const pending = initialize(db);
  initialization.set(key, pending);
  pending.catch(() => initialization.delete(key));
  return pending;
}
