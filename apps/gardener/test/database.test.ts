/// <reference types="node" />
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";

vi.mock("../migrations/0001_initial.sql", () => ({ default: "CREATE TABLE settings (key TEXT PRIMARY KEY);" }));
vi.mock("../migrations/0002_maintainer_policies.sql", () => ({ default: `INSERT OR IGNORE INTO operation_policies (operation_kind, mode) VALUES
  ('branch.create', 'disabled'), ('commit.create', 'disabled'), ('pull_request.open', 'disabled'),
  ('pull_request.update', 'disabled'), ('pull_request.review.submit', 'disabled'), ('pull_request.merge', 'disabled');` }));
vi.mock("../migrations/0003_workflow_revisions.sql", () => ({ default: `CREATE TABLE IF NOT EXISTS workflow_revisions (
  workflow_id TEXT NOT NULL, revision INTEGER NOT NULL, content_hash TEXT NOT NULL,
  PRIMARY KEY (workflow_id, revision), UNIQUE (workflow_id, content_hash));
CREATE INDEX IF NOT EXISTS idx_workflow_revisions_created_at ON workflow_revisions(workflow_id);` }));

import { ensureDatabase } from "../src/database";

describe("database compatibility migrations", () => {
  it("idempotently installs maintainer policy rows on an existing database", async () => {
    const batch = vi.fn(async (_statements: D1PreparedStatement[]) => []);
    const prepare = vi.fn((sql: string) => ({
      sql,
      first: async () => ({ key: "global_paused" }),
      all: async () => ({ results: [{ name: "active_revision" }, { name: "revision_counter" }] }),
    }));
    const db = { prepare, batch } as unknown as D1Database;

    await ensureDatabase(db);
    await ensureDatabase(db);

    expect(batch).toHaveBeenCalledTimes(2);
    const storageStatements = batch.mock.calls[0]![0] as unknown as Array<{ sql: string }>;
    expect(storageStatements.map((statement) => statement.sql)).toEqual([
      expect.stringContaining("CREATE TABLE IF NOT EXISTS workflow_revisions"),
      expect.stringContaining("CREATE INDEX IF NOT EXISTS idx_workflow_revisions_created_at"),
    ]);
    const migrationStatements = batch.mock.calls[1]![0] as unknown as Array<{ sql: string }>;
    expect(migrationStatements).toHaveLength(1);
    for (const operation of ["branch.create", "commit.create", "pull_request.open", "pull_request.update", "pull_request.review.submit", "pull_request.merge"]) {
      expect(migrationStatements[0]?.sql).toContain(`('${operation}', 'disabled')`);
    }
  });

  it("adds missing policies without overwriting existing modes when reapplied", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("CREATE TABLE operation_policies (operation_kind TEXT PRIMARY KEY, mode TEXT NOT NULL)");
      db.exec(`INSERT INTO operation_policies VALUES
        ('issue.label.add', 'automatic'), ('issue.label.remove', 'approval'),
        ('issue.comment.create', 'approval'), ('issue.comment.update', 'approval'),
        ('issue.close', 'disabled'), ('issue.reopen', 'disabled')`);
      const migration = readFileSync(new URL("../migrations/0002_maintainer_policies.sql", import.meta.url), "utf8");
      db.exec(migration);
      db.prepare("UPDATE operation_policies SET mode = 'approval' WHERE operation_kind = 'pull_request.merge'").run();
      db.exec(migration);

      const rows = db.prepare("SELECT operation_kind, mode FROM operation_policies ORDER BY operation_kind").all() as Array<{ operation_kind: string; mode: string }>;
      expect(rows).toHaveLength(12);
      expect(new Set(rows.map((row) => row.operation_kind)).size).toBe(12);
      expect(rows.find((row) => row.operation_kind === "issue.label.add")?.mode).toBe("automatic");
      expect(rows.find((row) => row.operation_kind === "pull_request.open")?.mode).toBe("disabled");
      expect(rows.find((row) => row.operation_kind === "pull_request.merge")?.mode).toBe("approval");
    } finally {
      db.close();
    }
  });
});
