/// <reference types="node" />
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { instrumentD1 } from "../src/task-runtime/d1-diagnostics";
import { d1Database } from "./sqlite";

function database() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("CREATE TABLE t (id TEXT PRIMARY KEY, secret TEXT) STRICT;");
  return { sqlite, db: instrumentD1(d1Database(sqlite), "TestScope") };
}

describe("instrumented D1", () => {
  afterEach(() => vi.restoreAllMocks());

  it("passes successful queries, bound statements and batches through unchanged", async () => {
    const { sqlite, db } = database();
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await db.prepare("INSERT INTO t (id,secret) VALUES (?,?)").bind("a", "s1").run();
      await db.batch([
        db.prepare("INSERT INTO t (id,secret) VALUES (?,?)").bind("b", "s2"),
        db.prepare("INSERT INTO t (id,secret) VALUES (?,?)").bind("c", "s3"),
      ]);
      expect(await db.prepare("SELECT secret FROM t WHERE id=?").bind("c").first<{ secret: string }>()).toEqual({ secret: "s3" });
      expect(logged).not.toHaveBeenCalled();
    } finally { sqlite.close(); }
  });

  it("logs the scope, SQL and call site of a failed query, never bound values, and rethrows", async () => {
    const { sqlite, db } = database();
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await db.prepare("INSERT INTO t (id,secret) VALUES (?,?)").bind("a", "s1").run();
      async function namedCaller() {
        return db.prepare("INSERT INTO t (id,secret) VALUES (?,?)").bind("a", "do-not-log-me").run();
      }
      await expect(namedCaller()).rejects.toThrow();
      expect(logged).toHaveBeenCalledTimes(1);
      const [message, detail] = logged.mock.calls[0]!;
      expect(message).toBe("gardener d1 query failed");
      expect(detail).toMatchObject({ scope: "TestScope", operation: "run", sql: "INSERT INTO t (id,secret) VALUES (?,?)" });
      expect((detail as { site: string }).site).toContain("namedCaller");
      expect(JSON.stringify(detail)).not.toContain("do-not-log-me");
    } finally { sqlite.close(); }
  });

  it("logs a failed batch", async () => {
    const { sqlite, db } = database();
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(db.batch([
        db.prepare("INSERT INTO t (id,secret) VALUES (?,?)").bind("x", "1"),
        db.prepare("INSERT INTO t (id,secret) VALUES (?,?)").bind("x", "2"),
      ])).rejects.toThrow();
      expect(logged.mock.calls[0]?.[1]).toMatchObject({ scope: "TestScope", operation: "batch", sql: "? ; ?" });
    } finally { sqlite.close(); }
  });

  it("logs each statement's SQL when a workerd-shaped batch fails", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const statement = (sql: string) => ({ statement: sql, bind() { return this; } });
    const fake = {
      prepare: (sql: string) => statement(sql),
      batch: async () => { throw new Error("D1_ERROR: Subrequest depth limit exceeded"); },
    } as unknown as D1Database;
    const db = instrumentD1(fake, "TestScope");
    await expect(db.batch([db.prepare("UPDATE a SET x=?").bind(1), db.prepare("INSERT INTO b VALUES (?)").bind(2)]))
      .rejects.toThrow(/Subrequest depth/);
    expect(logged.mock.calls[0]?.[1]).toMatchObject({
      operation: "batch",
      sql: "UPDATE a SET x=? ; INSERT INTO b VALUES (?)",
      error: "D1_ERROR: Subrequest depth limit exceeded",
    });
  });
});
