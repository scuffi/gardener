/// <reference types="node" />
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  ADMISSION_RETENTION_MS,
  admitRun,
  DEFAULT_RUNS,
  DEFAULT_RUNS_PER_AUTHOR,
  type RunAdmissionInput,
} from "../src/task-runtime/run-admissions";
import { d1Database } from "./sqlite";

const NOW = new Date("2026-10-20T12:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function database() {
  const sqlite = new DatabaseSync(":memory:");
  const directory = new URL("../migrations/", import.meta.url);
  for (const name of readdirSync(directory).filter((file) => file.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(new URL(name, directory), "utf8"));
  }
  return { sqlite, db: d1Database(sqlite) };
}

let sequence = 0;
function run(overrides: Partial<RunAdmissionInput> = {}): RunAdmissionInput {
  sequence += 1;
  return {
    runId: `run:${sequence}`,
    repositoryId: "100",
    taskId: "triage",
    authorId: "2",
    trusted: false,
    limits: {},
    now: NOW,
    ...overrides,
  };
}

const rows = (sqlite: DatabaseSync) =>
  (sqlite.prepare("SELECT COUNT(*) AS n FROM actions_task_run_admissions").get() as { n: number }).n;

describe("run admissions", () => {
  it("admits an untrusted starter up to the limit and skips the run after it", async () => {
    const { db, sqlite } = database();
    const limits = { runsPerAuthor: "2/hour" };
    await expect(admitRun(db, run({ limits }))).resolves.toEqual({ admitted: true });
    await expect(admitRun(db, run({ limits }))).resolves.toEqual({ admitted: true });
    await expect(admitRun(db, run({ limits }))).resolves.toEqual({
      admitted: false,
      summary: "Rate limit reached: 2 runs per hour per author for this task; nothing to do",
    });
    // An over-limit run writes nothing, so it never counts.
    expect(rows(sqlite)).toBe(2);
    // Another author, another task, and another repository each have their own count.
    await expect(admitRun(db, run({ limits, authorId: "3" }))).resolves.toEqual({ admitted: true });
    await expect(admitRun(db, run({ limits, taskId: "other" }))).resolves.toEqual({ admitted: true });
    await expect(admitRun(db, run({ limits, repositoryId: "101" }))).resolves.toEqual({ admitted: true });
  });

  it("counts only runs inside the window", async () => {
    const { db } = database();
    const limits = { runsPerAuthor: "1/hour" };
    await expect(admitRun(db, run({ limits, now: new Date(NOW.getTime() - HOUR) }))).resolves.toEqual({ admitted: true });
    // Exactly one window later, the earlier run has left it.
    await expect(admitRun(db, run({ limits }))).resolves.toEqual({ admitted: true });
    await expect(admitRun(db, run({ limits, now: new Date(NOW.getTime() + HOUR - 1) }))).resolves.toMatchObject({ admitted: false });
  });

  it("lets a reconnecting run continue without counting it again", async () => {
    const { db, sqlite } = database();
    const limits = { runsPerAuthor: "1/day" };
    const first = run({ limits });
    await expect(admitRun(db, first)).resolves.toEqual({ admitted: true });
    // At the limit now, yet the same run reconnecting is still admitted.
    await expect(admitRun(db, { ...first, now: new Date(NOW.getTime() + HOUR) })).resolves.toEqual({ admitted: true });
    expect(rows(sqlite)).toBe(1);
    await expect(admitRun(db, run({ limits }))).resolves.toMatchObject({ admitted: false });
    // It finds its own row first and never attempts to count or insert again.
    const statements: string[] = [];
    const watched = { ...db, prepare: (sql: string) => (statements.push(sql), db.prepare(sql)) } as D1Database;
    await expect(admitRun(watched, { ...first, now: new Date(NOW.getTime() + 2 * HOUR) })).resolves.toEqual({ admitted: true });
    expect(statements.filter((sql) => sql.startsWith("INSERT") || sql.startsWith("DELETE"))).toEqual([]);
  });

  it("treats its own row written just before the insert as admitted, not as over the limit", async () => {
    const { db, sqlite } = database();
    const racing = run();
    // Writes the run's row as the insert is prepared, as a racing connect of
    // the same run would; the Durable Object makes this unreachable today.
    const raced = {
      ...db,
      prepare: (sql: string) => {
        if (sql.startsWith("INSERT")) {
          sqlite.prepare("INSERT INTO actions_task_run_admissions (run_id,repository_id,task_id,author_id,trusted,admitted_at) VALUES (?,?,?,?,0,?)")
            .run(racing.runId, racing.repositoryId, racing.taskId, racing.authorId, NOW.getTime());
        }
        return db.prepare(sql);
      },
    } as D1Database;
    await expect(admitRun(raced, racing)).resolves.toEqual({ admitted: true });
    expect(rows(sqlite)).toBe(1);
  });

  it("keeps refusing a run that was over the limit when it reconnects", async () => {
    const { db, sqlite } = database();
    const limits = { runsPerAuthor: "1/day" };
    await admitRun(db, run({ limits }));
    const refused = run({ limits });
    await expect(admitRun(db, refused)).resolves.toMatchObject({ admitted: false });
    await expect(admitRun(db, { ...refused, now: new Date(NOW.getTime() + HOUR) })).resolves.toMatchObject({ admitted: false });
    expect(rows(sqlite)).toBe(1);
  });

  it("exempts trusted starters from the per-author limit, and does not count them toward it", async () => {
    const { db } = database();
    const limits = { runsPerAuthor: "1/day" };
    for (let index = 0; index < 5; index += 1) {
      await expect(admitRun(db, run({ limits, trusted: true }))).resolves.toEqual({ admitted: true });
    }
    // The same person's untrusted run (a maintainer's comment on an outsider's
    // pull request, say) finds their trusted runs did not use up its budget.
    await expect(admitRun(db, run({ limits, trusted: false }))).resolves.toEqual({ admitted: true });
    await expect(admitRun(db, run({ limits, trusted: false }))).resolves.toMatchObject({ admitted: false });
    // And once their untrusted budget is spent, their trusted runs still go ahead.
    await expect(admitRun(db, run({ limits, trusted: true }))).resolves.toEqual({ admitted: true });
  });

  it("limits every run of the task with runs, maintainers included", async () => {
    const { db } = database();
    const limits = { runs: "3/day", runsPerAuthor: "unlimited" };
    await expect(admitRun(db, run({ limits, trusted: true, authorId: "1" }))).resolves.toEqual({ admitted: true });
    await expect(admitRun(db, run({ limits, trusted: false, authorId: "2" }))).resolves.toEqual({ admitted: true });
    await expect(admitRun(db, run({ limits, trusted: false, authorId: "3" }))).resolves.toEqual({ admitted: true });
    await expect(admitRun(db, run({ limits, trusted: true, authorId: "1" }))).resolves.toEqual({
      admitted: false,
      summary: "Rate limit reached: 3 runs per day for this task; nothing to do",
    });
    await expect(admitRun(db, run({ limits, trusted: false, authorId: "4" }))).resolves.toMatchObject({ admitted: false });
  });

  it("names whichever limit was reached when both apply", async () => {
    const { db } = database();
    const limits = { runs: "2/week", runsPerAuthor: "1/day" };
    await admitRun(db, run({ limits, authorId: "2" }));
    await expect(admitRun(db, run({ limits, authorId: "2" }))).resolves.toEqual({
      admitted: false, summary: "Rate limit reached: 1 run per day per author for this task; nothing to do",
    });
    await admitRun(db, run({ limits, authorId: "3" }));
    await expect(admitRun(db, run({ limits, authorId: "4" }))).resolves.toEqual({
      admitted: false, summary: "Rate limit reached: 2 runs per week for this task; nothing to do",
    });
  });

  it("applies the Worker's defaults when the bundle sets no limit: 3 a day per author, no task total", async () => {
    expect(DEFAULT_RUNS_PER_AUTHOR).toBe("3/day");
    expect(DEFAULT_RUNS).toBeUndefined();
    const { db } = database();
    for (let index = 0; index < 3; index += 1) {
      await expect(admitRun(db, run({ now: new Date(NOW.getTime() + index * HOUR) }))).resolves.toEqual({ admitted: true });
    }
    await expect(admitRun(db, run({ now: new Date(NOW.getTime() + 4 * HOUR) }))).resolves.toEqual({
      admitted: false, summary: "Rate limit reached: 3 runs per day per author for this task; nothing to do",
    });
    await expect(admitRun(db, run({ now: new Date(NOW.getTime() + DAY) }))).resolves.toEqual({ admitted: true });
    // No task total by default: many authors, or a maintainer, are not capped.
    for (let index = 0; index < 20; index += 1) {
      await expect(admitRun(db, run({ authorId: `author-${index}` }))).resolves.toEqual({ admitted: true });
      await expect(admitRun(db, run({ trusted: true, authorId: "1" }))).resolves.toEqual({ admitted: true });
    }
    // `unlimited` turns the per-author default off.
    for (let index = 0; index < 5; index += 1) {
      await expect(admitRun(db, run({ limits: { runsPerAuthor: "unlimited" }, authorId: "7" }))).resolves.toEqual({ admitted: true });
    }
  });

  it("prunes this repository's rows older than 31 days on the same path", async () => {
    const { db, sqlite } = database();
    const insert = sqlite.prepare("INSERT INTO actions_task_run_admissions (run_id,repository_id,task_id,author_id,trusted,admitted_at) VALUES (?,?,?,?,0,?)");
    insert.run("old", "100", "triage", "2", NOW.getTime() - ADMISSION_RETENTION_MS - 1);
    insert.run("kept", "100", "triage", "2", NOW.getTime() - ADMISSION_RETENTION_MS + 1);
    insert.run("elsewhere", "101", "triage", "2", NOW.getTime() - ADMISSION_RETENTION_MS - 1);
    await admitRun(db, run({ limits: { runsPerAuthor: "unlimited" } }));
    const left = (sqlite.prepare("SELECT run_id FROM actions_task_run_admissions ORDER BY run_id").all() as { run_id: string }[])
      .map((row) => row.run_id);
    expect(left).toEqual(["elsewhere", "kept", `run:${sequence}`]);
    // Retention outlasts the longest window, so a monthly limit still sees every run it counts.
    expect(ADMISSION_RETENTION_MS).toBeGreaterThan(30 * DAY);
  });

  it("migrates to a table with the two window indexes", () => {
    const { sqlite } = database();
    const indexes = (sqlite.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='actions_task_run_admissions' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[])
      .map((row) => row.name);
    expect(indexes).toEqual(["idx_actions_task_run_admissions_author", "idx_actions_task_run_admissions_task"]);
  });
});
