-- One row per task a run started with `task.run`, written when its apply
-- reports it is about to dispatch, before GitHub is called. A run started by
-- `github-actions[bot]` on `workflow_dispatch` is admitted only by consuming a
-- matching row: nothing in the dispatch itself is trusted.
--
-- `trusted`, `reason` and `root_author_id` are the chain's root starter
-- decision and author, so every run of the chain inherits the root's scope and
-- counts against the root author's `runs-per-author`. `depth` is the started
-- run's: the parent's plus one. `created_at` is Unix time in milliseconds.
-- `consumed_by` is the GitHub workflow run id that consumed the row, which a
-- re-run of the same workflow run keeps, so it finds its row again.
-- Rows older than 31 days are pruned when a row is written.
CREATE TABLE IF NOT EXISTS actions_task_lineage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repository_id TEXT NOT NULL,
  -- The planning run whose plan holds the task run; one task run per plan.
  parent_run_id TEXT NOT NULL UNIQUE CHECK (length(parent_run_id) BETWEEN 1 AND 160),
  task_id TEXT NOT NULL CHECK (length(task_id) BETWEEN 1 AND 160),
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('issue', 'pull_request')),
  subject_number INTEGER NOT NULL CHECK (subject_number > 0),
  depth INTEGER NOT NULL CHECK (depth >= 1),
  trusted INTEGER NOT NULL CHECK (trusted IN (0, 1)),
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 64),
  root_author_id TEXT NOT NULL CHECK (length(root_author_id) BETWEEN 1 AND 20),
  created_at INTEGER NOT NULL,
  consumed_by TEXT CHECK (consumed_by IS NULL OR (length(consumed_by) BETWEEN 1 AND 20 AND consumed_by NOT GLOB '*[^0-9]*'))
);

-- Matching an unconsumed row for a started run.
CREATE INDEX IF NOT EXISTS idx_actions_task_lineage_match
  ON actions_task_lineage(repository_id, task_id, subject_kind, subject_number, consumed_by, created_at);

-- A re-run finding the row it already consumed.
CREATE INDEX IF NOT EXISTS idx_actions_task_lineage_consumed
  ON actions_task_lineage(repository_id, consumed_by);
