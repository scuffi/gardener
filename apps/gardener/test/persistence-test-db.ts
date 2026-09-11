/// <reference types="node" />
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

type SqlValue = null | string | number | bigint | Uint8Array;

interface SqlitePrepared {
  bind(...values: SqlValue[]): SqlitePrepared;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<{ success: true; meta: { changes: number } }>;
}

export function d1Database(sqlite: DatabaseSync): D1Database {
  const prepare = (sql: string, values: SqlValue[] = []): SqlitePrepared => ({
    bind: (...bound) => prepare(sql, bound),
    first: async <T>() => {
      const statement = sqlite.prepare(sql);
      return (statement.get(...values) as T | undefined) ?? null;
    },
    all: async <T>() => {
      const statement = sqlite.prepare(sql);
      return { results: statement.all(...values) as T[] };
    },
    run: async () => {
      const statement = sqlite.prepare(sql);
      const result = statement.run(...values);
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

export function migration(name = "0001_initial.sql"): string {
  return readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8");
}

export function newAgentDatabase(): { sqlite: DatabaseSync; db: D1Database } {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(migration());
  sqlite.exec(migration("0005_agent_runtime_admission.sql"));
  sqlite.exec(migration("0006_flue_harness_requests.sql"));
  return { sqlite, db: d1Database(sqlite) };
}

export function hash(seed: string): string {
  return seed.padEnd(64, seed[0] ?? "0").slice(0, 64);
}
