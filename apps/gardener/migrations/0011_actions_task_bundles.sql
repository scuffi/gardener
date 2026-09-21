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
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (repository_id, bundle_hash),
  FOREIGN KEY (repository_id) REFERENCES actions_repository_enrollments(repository_id),
  FOREIGN KEY (bundle_hash) REFERENCES actions_task_bundles(bundle_hash)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_actions_repository_tasks_enabled
  ON actions_repository_tasks(repository_id, enabled, bundle_hash);

UPDATE gardener_schema SET version = 11 WHERE singleton = 1 AND version = 10;
