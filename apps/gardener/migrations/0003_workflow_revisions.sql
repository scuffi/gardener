-- Additive columns are installed idempotently by ensureDatabase(). Keeping ALTER TABLE
-- out of this migration lets numbered migrations run safely after first-use bootstrap.

CREATE TABLE IF NOT EXISTS workflow_revisions (
  workflow_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  definition_json TEXT NOT NULL,
  compiled_plan_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  validator_version TEXT NOT NULL,
  validation_json TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('system', 'dashboard', 'agent')),
  created_by TEXT NOT NULL,
  source_metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workflow_id, revision),
  FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_workflow_revisions_created_at
  ON workflow_revisions(workflow_id, created_at DESC);

CREATE TABLE IF NOT EXISTS run_workflow_plans (
  run_id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  plan_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE,
  FOREIGN KEY (workflow_id, revision) REFERENCES workflow_revisions(workflow_id, revision)
);

CREATE TABLE IF NOT EXISTS run_agent_results (
  run_id TEXT PRIMARY KEY,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
);
