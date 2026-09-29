-- One row per accepted sync: a push to the default branch that made the
-- repository's live tasks exactly the committed ones. Rows are the audit trail
-- and order syncs, so a slow older run cannot undo a newer one.
CREATE TABLE actions_repository_syncs (
  repository_id TEXT NOT NULL,
  github_run_id TEXT NOT NULL CHECK (length(github_run_id) BETWEEN 1 AND 20 AND substr(github_run_id, 1, 1) <> '0' AND github_run_id NOT GLOB '*[^0-9]*'),
  github_run_attempt INTEGER NOT NULL CHECK (github_run_attempt > 0),
  commit_sha TEXT NOT NULL CHECK (length(commit_sha) = 40 AND commit_sha NOT GLOB '*[^a-f0-9]*'),
  actor_login TEXT NOT NULL CHECK (length(actor_login) BETWEEN 1 AND 100),
  workflow_ref TEXT NOT NULL CHECK (length(workflow_ref) BETWEEN 1 AND 1024),
  tasks_json TEXT NOT NULL CHECK (json_valid(tasks_json)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (repository_id, github_run_id, github_run_attempt),
  FOREIGN KEY (repository_id) REFERENCES actions_repository_enrollments(repository_id)
) STRICT;

-- Run ids increase per repository, so a sync from an older run than one
-- already accepted is stale. Raising here aborts the whole sync batch.
CREATE TRIGGER actions_repository_syncs_in_order
BEFORE INSERT ON actions_repository_syncs
WHEN EXISTS (
  SELECT 1 FROM actions_repository_syncs s
  WHERE s.repository_id = NEW.repository_id
    AND CAST(s.github_run_id AS INTEGER) > CAST(NEW.github_run_id AS INTEGER)
)
BEGIN
  SELECT RAISE(ABORT, 'gardener_sync_stale');
END;

CREATE TRIGGER actions_repository_syncs_no_update
BEFORE UPDATE ON actions_repository_syncs
BEGIN
  SELECT RAISE(ABORT, 'Gardener sync records are immutable');
END;

CREATE TRIGGER actions_repository_syncs_no_delete
BEFORE DELETE ON actions_repository_syncs
BEGIN
  SELECT RAISE(ABORT, 'Gardener sync records are immutable');
END;
