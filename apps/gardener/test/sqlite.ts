/// <reference types="node" />
import { DatabaseSync } from "node:sqlite";

interface SqlitePrepared {
  bind(...values: unknown[]): SqlitePrepared;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<{ success: true; meta: { changes: number; last_row_id: number } }>;
}

export function d1Database(sqlite: DatabaseSync): D1Database {
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
      const result = statement.run(...values) as { changes: number | bigint; lastInsertRowid: number | bigint };
      return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
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
