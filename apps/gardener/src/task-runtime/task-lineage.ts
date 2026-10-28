import {
  TASK_RUN_MAX_DEPTH,
  taskRunStarterV1Schema,
  type NormalizedEventV1,
  type TaskRunRequestV1,
  type TaskRunStarterV1,
} from "@gardener/contracts";
import { ADMISSION_RETENTION_MS } from "./run-admissions";

/**
 * How long after its parent's apply reported the dispatch a started run may
 * still claim its lineage record. Generous on purpose: the record must outlive
 * GitHub queueing the run, a runner starting, checkout and setup, and the
 * plan bridge connecting, and a run that misses it is refused with nothing to
 * recover. Nothing about safety rests on it being short: uniqueness comes from
 * one-shot consumption and scope from the record's own decision. Six hours is
 * a GitHub-hosted job's own limit.
 */
export const LINEAGE_WINDOW_MS = 6 * 3_600_000;

/** What a parent run's apply left for the run it started. */
export interface LineageRecordInput {
  readonly repositoryId: string;
  readonly parentRunId: string;
  readonly taskId: string;
  readonly subject: { readonly kind: "issue" | "pull_request"; readonly number: number };
  /** The started run's depth: the parent's plus one. */
  readonly depth: number;
  /** The chain's root starter decision, which the started run inherits. */
  readonly root: TaskRunStarterV1;
  /** The root starter's OIDC `actor_id`. */
  readonly rootAuthorId: string;
  readonly now: Date;
}

/** One lineage row as stored. */
export interface LineageRow {
  readonly id: number;
  readonly parent_run_id: string;
  readonly task_id: string;
  readonly subject_kind: string;
  readonly subject_number: number;
  readonly depth: number;
  readonly trusted: number;
  readonly reason: string;
  readonly root_author_id: string;
}

/**
 * The lineage record a parent leaves for the run it is about to start, from
 * the parent's own frozen request. A parent started by another run passes on
 * the root it inherited; a root passes on its own decision. A request admitted
 * before starters were recorded passes on an untrusted one, which only narrows.
 */
export function lineageRecordFor(
  parent: Pick<TaskRunRequestV1, "runId" | "event" | "starter" | "lineage">,
  run: { readonly task: string; readonly subject: LineageRecordInput["subject"] },
  now: Date,
): LineageRecordInput {
  const depth = (parent.lineage?.depth ?? 0) + 1;
  if (depth > TASK_RUN_MAX_DEPTH) {
    throw new Error(`task.run is refused: a chain of started runs may be at most ${TASK_RUN_MAX_DEPTH} deep`);
  }
  return {
    repositoryId: parent.event.repository.id,
    parentRunId: parent.runId,
    taskId: run.task,
    subject: run.subject,
    depth,
    root: parent.starter ?? { trusted: false, reason: "actor_unknown" },
    rootAuthorId: parent.lineage?.rootAuthorId ?? parent.event.actor.id,
    now,
  };
}

/**
 * Writes the record before the receipt that says the dispatch is under way,
 * so a crash between the two leaves a record no dispatch used (it expires)
 * rather than a dispatch nothing admits. Once per parent: a retried write is
 * ignored, and old rows are pruned on the same path.
 */
export async function recordLineage(db: D1Database, input: LineageRecordInput): Promise<void> {
  const now = input.now.getTime();
  await db.batch([
    db.prepare("DELETE FROM actions_task_lineage WHERE repository_id=? AND created_at<?")
      .bind(input.repositoryId, now - ADMISSION_RETENTION_MS),
    db.prepare(
      "INSERT OR IGNORE INTO actions_task_lineage "
      + "(repository_id,parent_run_id,task_id,subject_kind,subject_number,depth,trusted,reason,root_author_id,created_at) "
      + "VALUES (?,?,?,?,?,?,?,?,?,?)",
    ).bind(
      input.repositoryId,
      input.parentRunId,
      input.taskId,
      input.subject.kind,
      input.subject.number,
      input.depth,
      input.root.trusted ? 1 : 0,
      input.root.reason,
      input.rootAuthorId,
      now,
    ),
  ]);
}

/** What a bot's dispatch of a Gardener task is admitted as, or why it is refused. */
export type LineageMatch =
  | {
    readonly matched: true;
    readonly starter: TaskRunStarterV1;
    readonly lineage: NonNullable<TaskRunRequestV1["lineage"]>;
    readonly subject: { readonly kind: "issue" | "pull_request"; readonly number: number };
  }
  | { readonly matched: false; readonly reason: string };

/** The subject a manual run names, if any. */
export function dispatchSubject(event: NormalizedEventV1): { kind: "issue" | "pull_request"; number: number } | undefined {
  if (event.kind !== "github.workflow_dispatch") return undefined;
  if (event.issue !== undefined) return { kind: "issue", number: event.issue.number };
  if (event.pullRequest !== undefined) return { kind: "pull_request", number: event.pullRequest.number };
  return undefined;
}

/**
 * Admits a run a bot dispatched only as the run another Gardener run started.
 *
 * Nothing in the dispatch is trusted: it must carry no prompt (a started run
 * takes no instructions, and anything else holding `actions: write` could
 * otherwise inject some), and it must match a lineage record for the same
 * repository, task and subject. Two steps, as admissions do:
 *
 * 1. A record this GitHub run already consumed. A re-run keeps its run id, so
 *    it finds its record again, however long after; the window never applies.
 * 2. Otherwise one compare-and-swap claims an unconsumed record inside the
 *    window, and only `changes === 1` wins it. The racing parties are
 *    different runs, so different Durable Objects; the database decides.
 *
 * Consumed before the run is admitted against its limits: a record a refused
 * run stamped stays stamped, so a re-run reconciles through step 1 instead of
 * finding it burnt.
 *
 * Which record a run claims when several match is ordered strictest first:
 * untrusted before trusted, deepest before shallowest, then oldest. Records
 * for one repository, task and subject are interchangeable in everything a run
 * can observe except those three fields, so any assignment hands out the same
 * multiset of outcomes the parents bought: the number of trusted runs can never
 * exceed the number of trusted records. Depth and root author are not
 * interchangeable, and this order makes a mis-assignment cost authority
 * (a shallower chain treated as deeper, a trusted one as untrusted) rather
 * than grant it.
 */
export async function matchLineage(db: D1Database, input: {
  readonly repositoryId: string;
  /** The GitHub workflow run id, which every attempt of the run shares. */
  readonly githubRunId: string;
  readonly taskId: string;
  readonly event: NormalizedEventV1;
  readonly now: Date;
}): Promise<LineageMatch> {
  const subject = dispatchSubject(input.event);
  const named = subject === undefined ? "no issue or pull request" : `${subject.kind === "issue" ? "issue" : "pull request"} #${subject.number}`;
  if (input.event.kind === "github.workflow_dispatch" && input.event.prompt !== undefined) {
    return {
      matched: false,
      reason: `task ${input.taskId} was dispatched by a bot on ${named} with a prompt, and a run another task starts takes no instructions`,
    };
  }
  const columns = "id,parent_run_id,task_id,subject_kind,subject_number,depth,trusted,reason,root_author_id";
  let row = await db.prepare(`SELECT ${columns} FROM actions_task_lineage WHERE repository_id=? AND consumed_by=?`)
    .bind(input.repositoryId, input.githubRunId).first<LineageRow>();
  if (row === null) {
    if (subject === undefined) {
      return { matched: false, reason: `task ${input.taskId} was dispatched by a bot on ${named}, and no Gardener run started it` };
    }
    // The outer `consumed_by IS NULL` is subsumed: the subquery already
    // filters on it and SQLite runs both in one write transaction. It stays so
    // the statement is a compare-and-swap on its face, whatever the subquery
    // becomes.
    const claimed = await db.prepare(
      "UPDATE actions_task_lineage SET consumed_by=? WHERE id=("
      + "SELECT id FROM actions_task_lineage WHERE repository_id=? AND task_id=? AND subject_kind=? AND subject_number=? "
      + "AND consumed_by IS NULL AND created_at>? ORDER BY trusted ASC, depth DESC, created_at ASC LIMIT 1"
      + ") AND consumed_by IS NULL",
    ).bind(
      input.githubRunId,
      input.repositoryId,
      input.taskId,
      subject.kind,
      subject.number,
      input.now.getTime() - LINEAGE_WINDOW_MS,
    ).run();
    if ((claimed.meta.changes ?? 0) !== 1) {
      return {
        matched: false,
        reason: `task ${input.taskId} was dispatched by a bot on ${named}, and no Gardener run started it (no unclaimed lineage record matched)`,
      };
    }
    row = await db.prepare(`SELECT ${columns} FROM actions_task_lineage WHERE repository_id=? AND consumed_by=?`)
      .bind(input.repositoryId, input.githubRunId).first<LineageRow>();
    if (row === null) return { matched: false, reason: `task ${input.taskId}'s lineage record could not be read back after it was claimed` };
  }
  if (subject === undefined || row.task_id !== input.taskId || row.subject_kind !== subject.kind || row.subject_number !== subject.number) {
    return {
      matched: false,
      reason: `task ${input.taskId} was dispatched by a bot on ${named}, but the lineage record this run claimed is for task ${row.task_id} on ${row.subject_kind === "issue" ? "issue" : "pull request"} #${row.subject_number}`,
    };
  }
  const starter = taskRunStarterV1Schema.safeParse({ trusted: row.trusted === 1, reason: row.reason });
  if (!starter.success || row.depth < 1 || row.depth > TASK_RUN_MAX_DEPTH) {
    return { matched: false, reason: `task ${input.taskId}'s lineage record is malformed` };
  }
  return {
    matched: true,
    starter: starter.data,
    lineage: { parentRunId: row.parent_run_id, depth: row.depth, rootAuthorId: row.root_author_id },
    subject,
  };
}
