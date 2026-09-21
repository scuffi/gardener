-- Bind every enabled repository bundle to its trusted authoring identity and
-- source path. The CLI writes these values from the canonical project lock;
-- runner/model input can never choose them.
CREATE TABLE actions_repository_tasks_v12 (
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

INSERT INTO actions_repository_tasks_v12
  (repository_id,bundle_hash,task_id,source_path,enabled,created_at,updated_at)
SELECT rt.repository_id,rt.bundle_hash,b.task_id,
  '.gardener/tasks/' || b.task_id || '/TASK.md',
  rt.enabled,rt.created_at,rt.updated_at
FROM actions_repository_tasks rt
JOIN actions_task_bundles b ON b.bundle_hash=rt.bundle_hash;

DROP TABLE actions_repository_tasks;
ALTER TABLE actions_repository_tasks_v12 RENAME TO actions_repository_tasks;

CREATE INDEX idx_actions_repository_tasks_enabled
  ON actions_repository_tasks(repository_id, enabled, bundle_hash);

UPDATE gardener_schema SET version = 12 WHERE singleton = 1 AND version = 11;
