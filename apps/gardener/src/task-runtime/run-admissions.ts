import { parseRunLimit, type RunLimitV1, type TaskLimitsV1 } from "@gardener/contracts";

/**
 * Runs one untrusted starter may cause per task when the bundle sets no
 * `runs-per-author`. The Worker owns the default rather than `generate`, so
 * existing installs are protected as soon as the runtime deploys and no
 * bundle hash changes.
 */
export const DEFAULT_RUNS_PER_AUTHOR = "3/day";
/**
 * Runs of a task, by anyone, when the bundle sets no `runs`. None for now: a
 * default would also cap maintainers, and that is still to be decided.
 */
export const DEFAULT_RUNS: string | undefined = undefined;
/**
 * How long admissions are kept. Longer than the longest window (a month is 30
 * days), so pruning never forgets a run a limit still counts.
 */
export const ADMISSION_RETENTION_MS = 31 * 86_400_000;

export interface RunAdmissionInput {
  readonly runId: string;
  readonly repositoryId: string;
  readonly taskId: string;
  /** The OIDC `actor_id`. */
  readonly authorId: string;
  /** Trusted starters are not counted against `runs-per-author`. */
  readonly trusted: boolean;
  readonly limits: Pick<TaskLimitsV1, "runs" | "runsPerAuthor">;
  readonly now: Date;
}

export type RunAdmission = { readonly admitted: true } | { readonly admitted: false; readonly summary: string };

/** One untrusted starter's runs of a task since a time. Trusted runs carry no per-author budget. */
const AUTHOR_COUNT = "SELECT COUNT(*) AS n FROM actions_task_run_admissions WHERE repository_id=? AND task_id=? AND author_id=? AND trusted=0 AND admitted_at>?";
/** Every run of a task since a time, whoever started it. */
const TASK_COUNT = "SELECT COUNT(*) AS n FROM actions_task_run_admissions WHERE repository_id=? AND task_id=? AND admitted_at>?";

interface Limit extends RunLimitV1 {
  /** The limit as the reader would say it: `3 runs per day`. */
  readonly wording: string;
}

function limitOf(value: string | undefined, field: "runs" | "runsPerAuthor"): Limit | undefined {
  if (value === undefined) return undefined;
  const parsed = parseRunLimit(value, field);
  if (parsed === "unlimited") return undefined;
  const window = value.slice(value.indexOf("/") + 1);
  return { ...parsed, wording: `${parsed.count} run${parsed.count === 1 ? "" : "s"} per ${window}` };
}

/**
 * Admits this run against the task's run limits, or says why not.
 *
 * Two steps, both race-free. A run that already has a row was admitted
 * earlier and is reconnecting, so it continues without counting again; only
 * this run ever writes its own row. Otherwise one atomic INSERT…SELECT writes
 * the row only while every applicable count in its window is below its limit,
 * so two runs racing for the last slot cannot both get it. `runs` counts every
 * run of the task; `runs-per-author` counts and limits only untrusted starters.
 * Rows past the retention window are pruned on the same path.
 */
export async function admitRun(db: D1Database, input: RunAdmissionInput): Promise<RunAdmission> {
  const now = input.now.getTime();
  await db.prepare("DELETE FROM actions_task_run_admissions WHERE repository_id=? AND admitted_at<?")
    .bind(input.repositoryId, now - ADMISSION_RETENTION_MS).run();
  if (await admittedEarlier(db, input.runId)) return { admitted: true };

  const perAuthor = input.trusted ? undefined : limitOf(input.limits.runsPerAuthor ?? DEFAULT_RUNS_PER_AUTHOR, "runsPerAuthor");
  const total = limitOf(input.limits.runs ?? DEFAULT_RUNS, "runs");
  const conditions: string[] = [];
  const values: unknown[] = [input.runId, input.repositoryId, input.taskId, input.authorId, input.trusted ? 1 : 0, now];
  if (perAuthor !== undefined) {
    conditions.push(`(${AUTHOR_COUNT})<?`);
    values.push(input.repositoryId, input.taskId, input.authorId, now - perAuthor.windowSeconds * 1_000, perAuthor.count);
  }
  if (total !== undefined) {
    conditions.push(`(${TASK_COUNT})<?`);
    values.push(input.repositoryId, input.taskId, now - total.windowSeconds * 1_000, total.count);
  }
  // OR IGNORE: a reconnect racing this one may have written the row first,
  // which the re-read below tells apart from a run over its limit.
  const inserted = await db.prepare(
    "INSERT OR IGNORE INTO actions_task_run_admissions (run_id,repository_id,task_id,author_id,trusted,admitted_at) SELECT ?,?,?,?,?,?"
    + (conditions.length === 0 ? "" : ` WHERE ${conditions.join(" AND ")}`),
  ).bind(...values).run();
  if ((inserted.meta.changes ?? 0) === 1 || await admittedEarlier(db, input.runId)) return { admitted: true };

  // Over a limit. Name the per-author one when it is the one reached, since
  // that is the one an outsider meets; otherwise it was the task's total.
  const reached = perAuthor !== undefined && await count(
    db,
    AUTHOR_COUNT,
    input.repositoryId, input.taskId, input.authorId, now - perAuthor.windowSeconds * 1_000,
  ) >= perAuthor.count;
  return {
    admitted: false,
    summary: reached
      ? `Rate limit reached: ${perAuthor!.wording} per author for this task; nothing to do`
      : `Rate limit reached: ${total?.wording ?? "the task's run limit"} for this task; nothing to do`,
  };
}

async function admittedEarlier(db: D1Database, runId: string): Promise<boolean> {
  return (await db.prepare("SELECT 1 AS present FROM actions_task_run_admissions WHERE run_id=?").bind(runId).first()) !== null;
}

async function count(db: D1Database, sql: string, ...values: unknown[]): Promise<number> {
  return (await db.prepare(sql).bind(...values).first<{ n: number }>())?.n ?? 0;
}
