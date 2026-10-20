-- One row per task run that started the model, for the run limits
-- (`runs`, `runs-per-author`). A run writes only its own row, once, so a
-- reconnect finds it and is not counted twice. `admitted_at` is Unix time in
-- milliseconds. `trusted` records whether a maintainer, schedule, manual run
-- or push started it: `runs` counts every row, `runs-per-author` only the
-- untrusted ones. Rows older than 31 days are pruned when a run is admitted,
-- which is longer than the longest window (a month counts as 30 days).
CREATE TABLE IF NOT EXISTS actions_task_run_admissions (
  run_id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  trusted INTEGER NOT NULL CHECK (trusted IN (0, 1)),
  admitted_at INTEGER NOT NULL
);

-- `runs`: every run of a task in a window.
CREATE INDEX IF NOT EXISTS idx_actions_task_run_admissions_task
  ON actions_task_run_admissions(repository_id, task_id, admitted_at);

-- `runs-per-author`: one starter's runs of a task in a window.
CREATE INDEX IF NOT EXISTS idx_actions_task_run_admissions_author
  ON actions_task_run_admissions(repository_id, task_id, author_id, admitted_at);
