/// <reference types="node" />
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { beforeAll, describe, expect, it, vi } from "vitest";

let ensureDatabase: typeof import("../src/database").ensureDatabase;

beforeAll(async () => {
  vi.doMock("../migrations/0001_initial.sql", () => ({
    default: readFileSync(new URL("../migrations/0001_initial.sql", import.meta.url), "utf8"),
  }));
  vi.doMock("../migrations/0002_maintainer_policies.sql", () => ({
    default: readFileSync(new URL("../migrations/0002_maintainer_policies.sql", import.meta.url), "utf8"),
  }));
  vi.doMock("../migrations/0003_workflow_revisions.sql", () => ({
    default: readFileSync(new URL("../migrations/0003_workflow_revisions.sql", import.meta.url), "utf8"),
  }));
  ({ ensureDatabase } = await import("../src/database"));
});

interface SqlitePrepared {
  bind(...values: unknown[]): SqlitePrepared;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<{ success: true; meta: { changes: number } }>;
}

function d1Database(sqlite: DatabaseSync): D1Database {
  const prepare = (sql: string, values: unknown[] = []): SqlitePrepared => ({
    bind: (...bound) => prepare(sql, bound),
    first: async <T>() => {
      const statement = sqlite.prepare(sql) as any;
      return (statement.get(...values) as T | undefined) ?? null;
    },
    all: async <T>() => {
      const statement = sqlite.prepare(sql) as any;
      return { results: statement.all(...values) as T[] };
    },
    run: async () => {
      const statement = sqlite.prepare(sql) as any;
      const result = statement.run(...values) as { changes: number | bigint };
      return { success: true, meta: { changes: Number(result.changes) } };
    },
  });

  return {
    prepare: (sql: string) => prepare(sql) as unknown as D1PreparedStatement,
    batch: async (prepared: D1PreparedStatement[]) => {
      sqlite.exec("BEGIN");
      try {
        const results = [];
        for (const statement of prepared) results.push(await statement.run());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;
}

function createLegacyDatabase(sqlite: DatabaseSync): void {
  sqlite.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO settings VALUES ('global_paused', 'false');
    CREATE TABLE operation_policies (
      operation_kind TEXT PRIMARY KEY,
      mode TEXT NOT NULL CHECK (mode IN ('disabled', 'approval', 'automatic'))
    );
    INSERT INTO operation_policies VALUES ('issue.label.add', 'automatic');
    CREATE TABLE workflows (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
      trigger_kind TEXT NOT NULL,
      instructions TEXT NOT NULL,
      compiled_plan TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO workflows
      (id, name, version, enabled, trigger_kind, instructions, compiled_plan, created_at, updated_at)
    VALUES
      ('custom', 'Existing workflow', 7, 1, 'github.issue', 'Do not replace me',
       '{"schemaVersion":"v1","triggers":["github.issue.opened"]}',
       '2026-01-02 03:04:05', '2026-02-03 04:05:06');
  `);
}

function workflowColumns(sqlite: DatabaseSync): Array<{ name: string }> {
  return sqlite.prepare("PRAGMA table_info(workflows)").all() as Array<{ name: string }>;
}

describe("workflow revision storage compatibility", () => {
  it("applies the full numbered migration chain to a fresh database", () => {
    const sqlite = new DatabaseSync(":memory:");
    try {
      for (const migration of ["0001_initial.sql", "0002_maintainer_policies.sql", "0003_workflow_revisions.sql"]) {
        sqlite.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), "utf8"));
      }

      const columns = new Set(workflowColumns(sqlite).map((column) => column.name));
      expect(columns).toContain("active_revision");
      expect(columns).toContain("revision_counter");
      expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workflow_revisions'").get()).toEqual({ name: "workflow_revisions" });
      expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_workflow_revisions_created_at'").get()).toEqual({ name: "idx_workflow_revisions_created_at" });
    } finally {
      sqlite.close();
    }
  });

  it("bootstraps the fresh schema with revision storage and additive policies", async () => {
    const sqlite = new DatabaseSync(":memory:");
    try {
      await ensureDatabase(d1Database(sqlite));

      const columns = new Set(workflowColumns(sqlite).map((column) => column.name));
      expect(columns).toContain("active_revision");
      expect(columns).toContain("revision_counter");
      expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workflow_revisions'").get()).toEqual({ name: "workflow_revisions" });
      expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_workflow_revisions_created_at'").get()).toEqual({ name: "idx_workflow_revisions_created_at" });
      expect(sqlite.prepare("SELECT active_revision, revision_counter FROM workflows WHERE id = 'issue-gardener'").get()).toEqual({ active_revision: null, revision_counter: 0 });
      expect(sqlite.prepare("SELECT COUNT(*) AS count FROM operation_policies").get()).toEqual({ count: 12 });
    } finally {
      sqlite.close();
    }
  });

  it("upgrades a legacy workflows table repeatedly without overwriting workflow values", async () => {
    const sqlite = new DatabaseSync(":memory:");
    try {
      createLegacyDatabase(sqlite);
      const firstAdapter = d1Database(sqlite);
      await ensureDatabase(firstAdapter);
      await ensureDatabase(firstAdapter);
      await ensureDatabase(d1Database(sqlite));

      const columns = workflowColumns(sqlite).map((column) => column.name);
      expect(columns.filter((name) => name === "active_revision")).toHaveLength(1);
      expect(columns.filter((name) => name === "revision_counter")).toHaveLength(1);
      expect(sqlite.prepare("SELECT * FROM workflow_revisions").all()).toEqual([]);
      expect(sqlite.prepare(`
        SELECT id, name, version, enabled, trigger_kind, instructions, compiled_plan,
          active_revision, revision_counter, created_at, updated_at
        FROM workflows WHERE id = 'custom'
      `).get()).toEqual({
        id: "custom",
        name: "Existing workflow",
        version: 7,
        enabled: 1,
        trigger_kind: "github.issue",
        instructions: "Do not replace me",
        compiled_plan: '{"schemaVersion":"v1","triggers":["github.issue.opened"]}',
        active_revision: null,
        revision_counter: 0,
        created_at: "2026-01-02 03:04:05",
        updated_at: "2026-02-03 04:05:06",
      });
      expect(sqlite.prepare("SELECT mode FROM operation_policies WHERE operation_kind = 'issue.label.add'").get()).toEqual({ mode: "automatic" });
      expect(sqlite.prepare("SELECT mode FROM operation_policies WHERE operation_kind = 'pull_request.merge'").get()).toEqual({ mode: "disabled" });
    } finally {
      sqlite.close();
    }
  });

  it("enforces immutable revision and content-hash uniqueness", async () => {
    const sqlite = new DatabaseSync(":memory:");
    try {
      await ensureDatabase(d1Database(sqlite));
      const insert = sqlite.prepare(`
        INSERT INTO workflow_revisions
          (workflow_id, revision, definition_json, compiled_plan_json, content_hash,
           validator_version, validation_json, source_kind, created_by, source_metadata_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const values = ["issue-gardener", 1, "{}", "{}", "hash-1", "storage-v1", "{}", "dashboard", "user-1", "{}"] as const;
      insert.run(...values);

      expect(() => insert.run(...values.slice(0, 4), "hash-2", ...values.slice(5))).toThrow(/UNIQUE constraint failed: workflow_revisions\.workflow_id, workflow_revisions\.revision/);
      expect(() => insert.run("issue-gardener", 2, "{}", "{}", "hash-1", "storage-v1", "{}", "agent", "agent-1", "{}")).toThrow(/UNIQUE constraint failed: workflow_revisions\.workflow_id, workflow_revisions\.content_hash/);
      expect(sqlite.prepare("SELECT workflow_id, revision, content_hash, source_kind, created_by FROM workflow_revisions").all()).toEqual([
        { workflow_id: "issue-gardener", revision: 1, content_hash: "hash-1", source_kind: "dashboard", created_by: "user-1" },
      ]);
    } finally {
      sqlite.close();
    }
  });
});
