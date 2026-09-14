PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS github_username_resolution_limits (
  instance_id TEXT PRIMARY KEY REFERENCES instances(id) ON DELETE CASCADE,
  window_started_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL CHECK (attempts BETWEEN 1 AND 31)
) STRICT;
