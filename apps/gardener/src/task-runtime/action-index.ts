/**
 * A small index of a session's runner actions.
 *
 * Each stored action carries its full result, and a shell result may be
 * several hundred kilobytes (held twice, raw and canonical). Several session
 * paths, one of them on every tool call, need only each action's sequence and
 * state, and used to load every record to get them. On a long run that is
 * tens of megabytes per call and can exhaust the Durable Object's memory.
 * The index keeps one tiny summary beside each record, and readers page
 * through those instead.
 */

export const ACTION_PREFIX = "action:";
const ACTION_META_PREFIX = "action-meta:";
/**
 * Set only when the first action of a session is written by code that keeps
 * the index. A session with actions from before the index never gets it, and
 * is read through a paged scan of the full records instead.
 */
const ACTION_INDEX_KEY = "action-index/v1";
const SUMMARY_PAGE = 512;
/** Full records can each hold megabytes of output, so older sessions page through very few at a time. */
const RECORD_PAGE = 2;

export type ActionState = "running" | "ambiguous" | "completed";

export interface ActionSummary {
  operationId: string;
  sequence: number;
  state: ActionState;
}

interface IndexedAction {
  state: ActionState;
  action: { operationId: string; sequence: number };
}

export interface ActionStorage {
  get<T>(key: string): Promise<T | undefined>;
  list<T>(options: { prefix: string; limit?: number; startAfter?: string }): Promise<Map<string, T>>;
}

/** The record and its summary, to be written in one `put`. */
export function actionEntries<T extends IndexedAction>(record: T): Record<string, T | ActionSummary> {
  return {
    [`${ACTION_PREFIX}${record.action.operationId}`]: record,
    [`${ACTION_META_PREFIX}${record.action.operationId}`]: summarize(record),
  };
}

/** Call in the transaction that writes a new action, before writing it. */
export async function indexIfFirstAction(transaction: ActionStorage & { put(key: string, value: unknown): Promise<void> }): Promise<void> {
  if (await transaction.get(ACTION_INDEX_KEY)) return;
  if ((await transaction.list({ prefix: ACTION_PREFIX, limit: 1 })).size > 0) return;
  await transaction.put(ACTION_INDEX_KEY, true);
}

/** Every action's summary, in key order, holding at most one page of full records at a time. */
export async function listActionSummaries(storage: ActionStorage): Promise<ActionSummary[]> {
  const indexed = await storage.get<boolean>(ACTION_INDEX_KEY);
  const summaries: ActionSummary[] = [];
  const prefix = indexed ? ACTION_META_PREFIX : ACTION_PREFIX;
  const limit = indexed ? SUMMARY_PAGE : RECORD_PAGE;
  let startAfter: string | undefined;
  for (;;) {
    const page = await storage.list<ActionSummary | IndexedAction>({ prefix, limit, ...(startAfter ? { startAfter } : {}) });
    for (const [key, value] of page) {
      startAfter = key;
      summaries.push(indexed ? value as ActionSummary : summarize(value as IndexedAction));
    }
    if (page.size < limit) return summaries;
  }
}

function summarize(record: IndexedAction): ActionSummary {
  return { operationId: record.action.operationId, sequence: record.action.sequence, state: record.state };
}
