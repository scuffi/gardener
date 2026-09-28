-- Installation facts the CLI reads back, so no operator keeps local state.
-- Written by `gardener deploy`; the runtime itself never reads them.
CREATE TABLE actions_installation (
  key TEXT PRIMARY KEY CHECK (key IN ('runtime_origin', 'cli_version', 'deployment_hash', 'deployed_at')),
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
