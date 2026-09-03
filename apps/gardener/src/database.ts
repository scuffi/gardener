import initialSchema from "../migrations/0001_initial.sql";
import maintainerPolicies from "../migrations/0002_maintainer_policies.sql";
import workflowRevisions from "../migrations/0003_workflow_revisions.sql";

const initialization = new WeakMap<object, Promise<void>>();

function statements(sql: string): string[] {
  return sql.split(";").map((statement) => statement.trim()).filter((statement) => statement && !statement.startsWith("PRAGMA"));
}

async function workflowColumns(db: D1Database): Promise<Set<string>> {
  const { results } = await db.prepare("PRAGMA table_info(workflows)").all<{ name: string }>();
  return new Set(results.map((column) => column.name));
}

async function addWorkflowColumn(db: D1Database, columns: Set<string>, name: string, definition: string): Promise<void> {
  if (columns.has(name)) return;
  try {
    await db.prepare(`ALTER TABLE workflows ADD COLUMN ${name} ${definition}`).run();
    columns.add(name);
  } catch (error) {
    // Another isolate may have completed the additive migration after table_info ran.
    if (!(await workflowColumns(db)).has(name)) throw error;
    columns.add(name);
  }
}

async function ensureWorkflowRevisionStorage(db: D1Database): Promise<void> {
  const columns = await workflowColumns(db);
  await addWorkflowColumn(db, columns, "active_revision", "INTEGER CHECK (active_revision IS NULL OR active_revision > 0)");
  await addWorkflowColumn(db, columns, "revision_counter", "INTEGER NOT NULL DEFAULT 0 CHECK (revision_counter >= 0)");

  // ALTER TABLE is handled above because SQLite has no ADD COLUMN IF NOT EXISTS.
  // The remaining CREATE statements are safe to reapply and intentionally do not backfill revisions.
  const schemaObjects = statements(workflowRevisions)
    .map((statement) => statement.replace(/^(?:\s*--[^\n]*(?:\n|$))+/, "").trim())
    .filter((statement) => /^CREATE (?:TABLE|INDEX) IF NOT EXISTS\b/i.test(statement));
  await db.batch(schemaObjects.map((statement) => db.prepare(statement)));
}

/**
 * Deploy to Cloudflare provisions D1 but does not run Wrangler migrations.
 * Initialize the idempotent schema on first use so a button deployment
 * needs no local CLI. Later schema changes still use numbered migrations.
 */
export function ensureDatabase(db: D1Database): Promise<void> {
  const key = db as unknown as object;
  const existing = initialization.get(key);
  if (existing) return existing;

  const pending = (async () => {
    try {
      await db.prepare("SELECT key FROM settings LIMIT 1").first();
    } catch {
      await db.batch(statements(initialSchema).map((statement) => db.prepare(statement)));
    }
    await ensureWorkflowRevisionStorage(db);
    // This additive compatibility migration is safe to reapply and prevents a deployed Worker
    // from silently running with a partial operation-policy catalog.
    await db.batch(statements(maintainerPolicies).map((statement) => db.prepare(statement)));
  })();
  initialization.set(key, pending);
  pending.catch(() => initialization.delete(key));
  return pending;
}
