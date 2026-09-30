-- Adds the AI Gateway facts `gardener deploy` records, so `upgrade` keeps the
-- gateway. SQLite cannot alter a CHECK constraint, so the table is rebuilt.
DROP TABLE IF EXISTS actions_installation_next;
CREATE TABLE actions_installation_next (
  key TEXT PRIMARY KEY CHECK (key IN (
    'runtime_origin', 'cli_version', 'deployment_hash', 'deployed_at',
    'ai_gateway', 'ai_gateway_project'
  )),
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO actions_installation_next(key, value, updated_at)
  SELECT key, value, updated_at FROM actions_installation;
DROP TABLE actions_installation;
ALTER TABLE actions_installation_next RENAME TO actions_installation;
