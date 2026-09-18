-- Additive Actions-native runtime state. This is deliberately separate from
-- the historical Gateway/Agent tables so the final cutover can retain only
-- this surface.
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

UPDATE gardener_schema SET version = 10 WHERE singleton = 1 AND version = 9;
