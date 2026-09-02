PRAGMA foreign_keys = ON;

CREATE TABLE instances (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  owner_github_user_id TEXT,
  callback_url TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  claimed_at TEXT,
  revoked_at TEXT
);

CREATE TABLE landing_states (
  state_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  consumed_at TEXT
);

CREATE TABLE landing_sessions (
  session_hash TEXT PRIMARY KEY,
  github_user_id TEXT NOT NULL,
  github_login TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE oauth_states (
  state_hash TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('login', 'installation')),
  redirect_uri TEXT,
  expires_at INTEGER NOT NULL,
  consumed_at TEXT
);

CREATE TABLE identities (
  instance_id TEXT NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
  github_user_id TEXT NOT NULL,
  github_login TEXT NOT NULL,
  last_login_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (instance_id, github_user_id)
);

CREATE TABLE installations (
  id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL,
  account_login TEXT NOT NULL,
  suspended_at TEXT,
  revoked_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX installations_instance ON installations(instance_id);

CREATE TABLE repositories (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  instance_id TEXT NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  default_branch TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(instance_id, owner, name)
);
CREATE INDEX repositories_installation ON repositories(installation_id, active);

CREATE TABLE webhook_deliveries (
  delivery_id TEXT PRIMARY KEY,
  event_name TEXT NOT NULL,
  repository_id TEXT,
  instance_id TEXT,
  normalized_event_id TEXT,
  resource_kind TEXT,
  resource_number INTEGER,
  status TEXT NOT NULL DEFAULT 'received',
  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  relayed_at TEXT,
  error TEXT
);

CREATE INDEX webhook_event_scope ON webhook_deliveries(instance_id, repository_id, normalized_event_id, resource_number, status);

CREATE TABLE grants (
  jti TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  resource_kind TEXT NOT NULL,
  resource_number INTEGER NOT NULL,
  operations TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE operation_receipts (
  operation_id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
  grant_jti TEXT NOT NULL REFERENCES grants(jti),
  operation_kind TEXT NOT NULL,
  operation TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  resource_number INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'executing',
  receipt TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT
);
