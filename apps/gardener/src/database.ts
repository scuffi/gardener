import initialSchema from "../migrations/0001_initial.sql";
import maintainerPolicies from "../migrations/0002_maintainer_policies.sql";

const initialization = new WeakMap<object, Promise<void>>();

function statements(sql: string): string[] {
  return sql.split(";").map((statement) => statement.trim()).filter((statement) => statement && !statement.startsWith("PRAGMA"));
}

/**
 * Deploy to Cloudflare provisions D1 but does not run Wrangler migrations.
 * Initialize the idempotent v1 schema on first use so a button deployment
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
    // This additive compatibility migration is safe to reapply and prevents a deployed Worker
    // from silently running with a partial operation-policy catalog.
    await db.batch(statements(maintainerPolicies).map((statement) => db.prepare(statement)));
  })();
  initialization.set(key, pending);
  pending.catch(() => initialization.delete(key));
  return pending;
}
