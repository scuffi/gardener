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

UPDATE gardener_schema SET version = 13 WHERE singleton = 1 AND version = 12;
