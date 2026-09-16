PRAGMA foreign_keys = ON;

CREATE TABLE oauth_flows (
  state_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  state_consumed_at TEXT,
  gardener_completed_at TEXT,
  github_user_id TEXT,
  github_login TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE installation_flows (
  state_hash TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  requested_by_github_user_id TEXT NOT NULL,
  requested_by_github_login TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  state_consumed_at TEXT,
  ready_at TEXT,
  finalized_at TEXT,
  installation_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE installations (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  account_login TEXT NOT NULL,
  account_type TEXT NOT NULL CHECK (account_type IN ('User', 'Organization')),
  suspended_at TEXT,
  revoked_at TEXT,
  sync_generation INTEGER NOT NULL DEFAULT 0,
  sync_lease_token TEXT,
  sync_lease_expires_at INTEGER,
  username_lookup_window INTEGER,
  username_lookup_attempts INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE repositories (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  default_branch TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  sync_generation INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(owner, name)
);
CREATE INDEX repositories_installation_active
  ON repositories(installation_id, active);

CREATE TABLE webhook_deliveries (
  delivery_id TEXT PRIMARY KEY,
  event_name TEXT NOT NULL,
  event_action TEXT,
  payload_hash TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  repository_id TEXT,
  repository_name TEXT,
  normalized_event_id TEXT,
  normalized_event_json TEXT,
  normalized_event_hash TEXT,
  status TEXT NOT NULL CHECK (status IN ('received', 'delivering', 'delivered', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  attempt_token TEXT,
  lease_expires_at INTEGER,
  last_error TEXT,
  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  delivered_at TEXT
);
CREATE UNIQUE INDEX webhook_deliveries_normalized_event
  ON webhook_deliveries(normalized_event_id) WHERE normalized_event_id IS NOT NULL;
CREATE INDEX webhook_deliveries_status
  ON webhook_deliveries(status, received_at);

CREATE TABLE operation_receipts (
  operation_id TEXT PRIMARY KEY,
  operation_hash TEXT NOT NULL,
  operation_kind TEXT NOT NULL,
  operation_json TEXT NOT NULL,
  run_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  resource_number INTEGER,
  status TEXT NOT NULL CHECK (status IN ('executing', 'succeeded', 'failed', 'skipped', 'conflicted')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  attempt_token TEXT,
  lease_expires_at INTEGER,
  receipt_json TEXT,
  receipt_hash TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT
);
CREATE INDEX operation_receipts_status
  ON operation_receipts(status, created_at);
