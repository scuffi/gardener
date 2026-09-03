-- active_revision and revision_counter are declared by 0001 for fresh first-use databases.
-- Existing databases receive only missing columns through ensureDatabase(), which uses
-- PRAGMA table_info(workflows) because SQLite has no ADD COLUMN IF NOT EXISTS.

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
  UNIQUE (workflow_id, content_hash),
  FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_workflow_revisions_created_at
  ON workflow_revisions(workflow_id, created_at DESC);
