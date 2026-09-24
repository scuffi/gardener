-- Gardener runtime schema: repository enrollment, task bundles, runs, and audit.
CREATE TABLE IF NOT EXISTS actions_repository_enrollments (
  repository_id TEXT PRIMARY KEY CHECK (length(repository_id) BETWEEN 1 AND 20 AND substr(repository_id, 1, 1) <> '0' AND repository_id NOT GLOB '*[^0-9]*'),
  owner_id TEXT NOT NULL CHECK (length(owner_id) BETWEEN 1 AND 20 AND substr(owner_id, 1, 1) <> '0' AND owner_id NOT GLOB '*[^0-9]*'),
  owner_login TEXT NOT NULL CHECK (length(owner_login) BETWEEN 1 AND 100),
  repository_name TEXT NOT NULL CHECK (length(repository_name) BETWEEN 1 AND 100),
  visibility TEXT NOT NULL CHECK (visibility IN ('public', 'private', 'internal')),
  plan_job_workflow_ref TEXT NOT NULL CHECK (length(plan_job_workflow_ref) BETWEEN 1 AND 1024),
  effects_job_workflow_ref TEXT CHECK (effects_job_workflow_ref IS NULL OR length(effects_job_workflow_ref) BETWEEN 1 AND 1024),
  oidc_audience TEXT NOT NULL CHECK (length(oidc_audience) BETWEEN 1 AND 512),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(owner_id, owner_login, repository_name)
) STRICT;

CREATE TABLE IF NOT EXISTS actions_task_runs (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 160),
  repository_id TEXT NOT NULL,
  github_run_id TEXT NOT NULL CHECK (length(github_run_id) BETWEEN 1 AND 20 AND substr(github_run_id, 1, 1) <> '0' AND github_run_id NOT GLOB '*[^0-9]*'),
  github_run_attempt INTEGER NOT NULL CHECK (github_run_attempt > 0),
  phase TEXT NOT NULL CHECK (phase IN ('plan', 'effects')),
  bundle_hash TEXT NOT NULL CHECK (length(bundle_hash) = 64),
  request_json TEXT NOT NULL CHECK (json_valid(request_json)),
  status TEXT NOT NULL CHECK (status IN ('admitted', 'running', 'completed', 'failed', 'cancelled')),
  harness_submission_json TEXT CHECK (harness_submission_json IS NULL OR json_valid(harness_submission_json)),
  outcome_json TEXT CHECK (outcome_json IS NULL OR json_valid(outcome_json)),
  effect_receipt_json TEXT CHECK (effect_receipt_json IS NULL OR json_valid(effect_receipt_json)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(repository_id, github_run_id, github_run_attempt, phase),
  FOREIGN KEY (repository_id) REFERENCES actions_repository_enrollments(repository_id)
) STRICT;

CREATE TABLE IF NOT EXISTS actions_task_audit (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  event TEXT NOT NULL CHECK (length(event) BETWEEN 1 AND 100),
  detail_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail_json)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (run_id) REFERENCES actions_task_runs(id)
) STRICT;

CREATE TRIGGER IF NOT EXISTS actions_task_audit_no_update
BEFORE UPDATE ON actions_task_audit
BEGIN
  SELECT RAISE(ABORT, 'Actions task audit records are immutable');
END;

CREATE TRIGGER IF NOT EXISTS actions_task_audit_no_delete
BEFORE DELETE ON actions_task_audit
BEGIN
  SELECT RAISE(ABORT, 'Actions task audit records are immutable');
END;

-- Store immutable compiled task bundles separately from repository enrollment.
-- Runners select bundles only by SHA-256; the runtime loads canonical bytes from
-- D1 after authenticating the repository with GitHub OIDC.
CREATE TABLE IF NOT EXISTS actions_task_bundles (
  bundle_hash TEXT PRIMARY KEY CHECK (length(bundle_hash) = 64 AND bundle_hash NOT GLOB '*[^a-f0-9]*'),
  task_id TEXT NOT NULL CHECK (length(task_id) BETWEEN 1 AND 160),
  bundle_json TEXT NOT NULL CHECK (json_valid(bundle_json)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE TABLE IF NOT EXISTS actions_repository_tasks (
  repository_id TEXT NOT NULL,
  bundle_hash TEXT NOT NULL,
  task_id TEXT NOT NULL CHECK (length(task_id) BETWEEN 1 AND 160),
  source_path TEXT NOT NULL CHECK (
    length(source_path) BETWEEN 1 AND 1024
    AND substr(source_path, 1, 1) <> '/'
    AND instr(source_path, '\\') = 0
    AND instr('/' || source_path || '/', '/../') = 0
    AND instr('/' || source_path || '/', '/./') = 0
  ),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (repository_id, bundle_hash),
  FOREIGN KEY (repository_id) REFERENCES actions_repository_enrollments(repository_id),
  FOREIGN KEY (bundle_hash) REFERENCES actions_task_bundles(bundle_hash)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_actions_repository_tasks_enabled
  ON actions_repository_tasks(repository_id, enabled, bundle_hash);

CREATE TABLE IF NOT EXISTS actions_control_audit (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL CHECK (scope IN ('repository', 'task')),
  repository_id TEXT NOT NULL,
  task_id TEXT,
  bundle_hash TEXT,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  detail_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_actions_control_audit_repository
  ON actions_control_audit(repository_id, sequence DESC);

CREATE TRIGGER IF NOT EXISTS actions_repository_enabled_audit
AFTER UPDATE OF enabled ON actions_repository_enrollments
WHEN OLD.enabled <> NEW.enabled
BEGIN
  INSERT INTO actions_control_audit(scope,repository_id,task_id,bundle_hash,enabled,detail_json)
  VALUES ('repository',NEW.repository_id,NULL,NULL,NEW.enabled,'{"source":"database-trigger"}');
END;

CREATE TRIGGER IF NOT EXISTS actions_task_enabled_audit
AFTER UPDATE OF enabled ON actions_repository_tasks
WHEN OLD.enabled <> NEW.enabled
BEGIN
  INSERT INTO actions_control_audit(scope,repository_id,task_id,bundle_hash,enabled,detail_json)
  VALUES ('task',NEW.repository_id,NEW.task_id,NEW.bundle_hash,NEW.enabled,'{"source":"database-trigger"}');
END;
