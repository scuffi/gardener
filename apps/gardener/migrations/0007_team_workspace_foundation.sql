-- Pre-V1 team/workspace cutover. One D1 database is one workspace.
-- Every destructive statement is independently guarded so manually replaying this
-- file after the marker reaches v7 cannot remove post-cutover data.
DELETE FROM harness_submissions WHERE EXISTS (SELECT 1 FROM gardener_schema WHERE singleton = 1 AND version = 6);
DELETE FROM harness_requests WHERE EXISTS (SELECT 1 FROM gardener_schema WHERE singleton = 1 AND version = 6);
DELETE FROM run_capability_grants WHERE EXISTS (SELECT 1 FROM gardener_schema WHERE singleton = 1 AND version = 6);
DELETE FROM effects WHERE EXISTS (SELECT 1 FROM gardener_schema WHERE singleton = 1 AND version = 6);
DELETE FROM run_interruptions WHERE EXISTS (SELECT 1 FROM gardener_schema WHERE singleton = 1 AND version = 6);
DELETE FROM agent_eval_results WHERE EXISTS (SELECT 1 FROM gardener_schema WHERE singleton = 1 AND version = 6);
DELETE FROM agent_eval_cases WHERE EXISTS (SELECT 1 FROM gardener_schema WHERE singleton = 1 AND version = 6);
DELETE FROM workspace_leases WHERE EXISTS (SELECT 1 FROM gardener_schema WHERE singleton = 1 AND version = 6);
DELETE FROM run_artifacts WHERE EXISTS (SELECT 1 FROM gardener_schema WHERE singleton = 1 AND version = 6);
DELETE FROM run_steps WHERE EXISTS (SELECT 1 FROM gardener_schema WHERE singleton = 1 AND version = 6);
DELETE FROM run_tasks WHERE EXISTS (SELECT 1 FROM gardener_schema WHERE singleton = 1 AND version = 6);
DELETE FROM inbox_items WHERE EXISTS (SELECT 1 FROM gardener_schema WHERE singleton = 1 AND version = 6);
DELETE FROM agent_runs WHERE EXISTS (SELECT 1 FROM gardener_schema WHERE singleton = 1 AND version = 6);
DELETE FROM event_agent_admissions WHERE EXISTS (SELECT 1 FROM gardener_schema WHERE singleton = 1 AND version = 6);
DELETE FROM repository_events WHERE EXISTS (SELECT 1 FROM gardener_schema WHERE singleton = 1 AND version = 6);
DELETE FROM agent_activation_history WHERE EXISTS (SELECT 1 FROM gardener_schema WHERE singleton = 1 AND version = 6);
DELETE FROM agent_enablement_history WHERE EXISTS (SELECT 1 FROM gardener_schema WHERE singleton = 1 AND version = 6);
DELETE FROM agent_activations WHERE EXISTS (SELECT 1 FROM gardener_schema WHERE singleton = 1 AND version = 6);
DELETE FROM agent_drafts WHERE EXISTS (SELECT 1 FROM gardener_schema WHERE singleton = 1 AND version = 6);
DELETE FROM agents WHERE EXISTS (SELECT 1 FROM gardener_schema WHERE singleton = 1 AND version = 6);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  display_name TEXT NOT NULL CHECK (length(display_name) > 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE TABLE IF NOT EXISTS external_identities (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (length(provider) > 0),
  provider_subject TEXT NOT NULL CHECK (length(provider_subject) > 0),
  username TEXT CHECK (username IS NULL OR length(username) > 0),
  profile_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(profile_json)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(provider, provider_subject),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) STRICT;

CREATE TRIGGER IF NOT EXISTS external_identities_no_update
BEFORE UPDATE OF user_id, provider, provider_subject ON external_identities
BEGIN
  SELECT RAISE(ABORT, 'external identity subjects are immutable');
END;

CREATE TABLE IF NOT EXISTS memberships (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  user_id TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  permanent INTEGER NOT NULL DEFAULT 0 CHECK (permanent IN (0, 1)),
  created_by_user_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (permanent = 0 OR role = 'owner'),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by_user_id) REFERENCES users(id)
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_memberships_single_owner
  ON memberships(role) WHERE role = 'owner';

CREATE TRIGGER IF NOT EXISTS memberships_permanent_owner_no_update
BEFORE UPDATE OF role, permanent, user_id ON memberships
WHEN OLD.permanent = 1
BEGIN
  SELECT RAISE(ABORT, 'the permanent owner membership cannot be changed');
END;

CREATE TRIGGER IF NOT EXISTS memberships_permanent_owner_no_delete
BEFORE DELETE ON memberships
WHEN OLD.permanent = 1
BEGIN
  SELECT RAISE(ABORT, 'the permanent owner membership cannot be deleted');
END;

CREATE TABLE IF NOT EXISTS invitations (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  provider TEXT NOT NULL CHECK (length(provider) > 0),
  provider_subject TEXT NOT NULL CHECK (length(provider_subject) > 0),
  username TEXT NOT NULL CHECK (length(username) > 0),
  role TEXT NOT NULL DEFAULT 'member' CHECK (role = 'member'),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'revoked')),
  invited_by_user_id TEXT NOT NULL,
  accepted_by_user_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  accepted_at TEXT,
  revoked_at TEXT,
  CHECK ((status = 'pending' AND accepted_by_user_id IS NULL AND accepted_at IS NULL AND revoked_at IS NULL)
    OR (status = 'accepted' AND accepted_by_user_id IS NOT NULL AND accepted_at IS NOT NULL AND revoked_at IS NULL)
    OR (status = 'revoked' AND accepted_by_user_id IS NULL AND accepted_at IS NULL AND revoked_at IS NOT NULL)),
  FOREIGN KEY (invited_by_user_id) REFERENCES users(id),
  FOREIGN KEY (accepted_by_user_id) REFERENCES users(id)
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_invitations_pending_subject
  ON invitations(provider, provider_subject) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS provider_login_handoffs (
  handoff_hash TEXT PRIMARY KEY CHECK (length(handoff_hash) = 64),
  provider TEXT NOT NULL CHECK (provider = 'github'),
  provider_subject TEXT NOT NULL CHECK (length(provider_subject) > 0),
  username TEXT NOT NULL CHECK (length(username) > 0),
  expires_at INTEGER NOT NULL CHECK (expires_at > 0),
  completed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  consumed_at TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS idx_provider_login_handoffs_expiry
  ON provider_login_handoffs(expires_at, consumed_at);

CREATE TABLE IF NOT EXISTS dashboard_sessions (
  token_hash TEXT PRIMARY KEY CHECK (length(token_hash) = 64),
  user_id TEXT NOT NULL,
  csrf_digest TEXT NOT NULL CHECK (length(csrf_digest) = 64),
  cookie_name TEXT NOT NULL CHECK (cookie_name IN ('__Host-gardener_session', 'gardener_session')),
  idle_expires_at INTEGER NOT NULL CHECK (idle_expires_at > 0),
  absolute_expires_at INTEGER NOT NULL CHECK (absolute_expires_at >= idle_expires_at),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS idx_dashboard_sessions_user
  ON dashboard_sessions(user_id, revoked_at, idle_expires_at);
CREATE INDEX IF NOT EXISTS idx_dashboard_sessions_expiry
  ON dashboard_sessions(absolute_expires_at);

CREATE TABLE IF NOT EXISTS provider_installation_requests (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  provider TEXT NOT NULL CHECK (provider = 'github'),
  initiated_by_user_id TEXT NOT NULL,
  initiated_by_subject TEXT NOT NULL,
  initiated_by_login TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'finalizing', 'completed')),
  expires_at INTEGER NOT NULL CHECK (expires_at > 0),
  installation_id TEXT,
  finalize_token TEXT,
  finalize_lease_expires_at INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  FOREIGN KEY (initiated_by_user_id) REFERENCES users(id)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_provider_installation_requests_expiry
  ON provider_installation_requests(expires_at, status);

CREATE TABLE IF NOT EXISTS agent_repository_assignments (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  agent_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  authority_ceiling TEXT NOT NULL DEFAULT 'disabled' CHECK (authority_ceiling IN ('disabled', 'approval', 'automatic')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  config_hash TEXT NOT NULL CHECK (length(config_hash) = 64),
  created_by_user_id TEXT NOT NULL,
  updated_by_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  removed_at TEXT,
  UNIQUE(agent_id, repository_id),
  UNIQUE(id, version, config_hash),
  FOREIGN KEY (agent_id) REFERENCES agents(id),
  FOREIGN KEY (repository_id) REFERENCES repositories(id),
  FOREIGN KEY (created_by_user_id) REFERENCES users(id),
  FOREIGN KEY (updated_by_user_id) REFERENCES users(id)
) STRICT;

CREATE TRIGGER IF NOT EXISTS agent_repository_assignments_monotonic_version
BEFORE UPDATE ON agent_repository_assignments
WHEN NEW.version < OLD.version
  OR NEW.version > OLD.version + 1
  OR (NEW.version = OLD.version + 1 AND NEW.config_hash = OLD.config_hash)
  OR (NEW.config_hash <> OLD.config_hash AND NEW.version <> OLD.version + 1)
  OR ((NEW.enabled IS NOT OLD.enabled
    OR NEW.authority_ceiling IS NOT OLD.authority_ceiling
    OR NEW.removed_at IS NOT OLD.removed_at)
    AND (NEW.version <> OLD.version + 1 OR NEW.config_hash = OLD.config_hash))
BEGIN
  SELECT RAISE(ABORT, 'assignment authorization changes require one version increment and a new config hash');
END;

CREATE TABLE IF NOT EXISTS agent_repository_assignment_history (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  assignment_id TEXT NOT NULL,
  assignment_version INTEGER NOT NULL CHECK (assignment_version > 0),
  config_hash TEXT NOT NULL CHECK (length(config_hash) = 64),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  authority_ceiling TEXT NOT NULL CHECK (authority_ceiling IN ('disabled', 'approval', 'automatic')),
  action TEXT NOT NULL CHECK (action IN ('added', 'enabled', 'paused', 'resumed', 'disabled', 'removed', 'revision_changed', 'authority_narrowed', 'authority_widened')),
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
  actor_user_id TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(assignment_id, assignment_version),
  FOREIGN KEY (assignment_id) REFERENCES agent_repository_assignments(id),
  FOREIGN KEY (actor_user_id) REFERENCES users(id)
) STRICT;

CREATE TRIGGER IF NOT EXISTS agent_repository_assignment_history_no_update
BEFORE UPDATE ON agent_repository_assignment_history
BEGIN
  SELECT RAISE(ABORT, 'assignment history is immutable');
END;

CREATE TRIGGER IF NOT EXISTS agent_repository_assignment_history_no_delete
BEFORE DELETE ON agent_repository_assignment_history
BEGIN
  SELECT RAISE(ABORT, 'assignment history is immutable');
END;

CREATE TABLE IF NOT EXISTS repository_operation_policies (
  repository_id TEXT NOT NULL,
  operation_kind TEXT NOT NULL CHECK (length(operation_kind) > 0),
  mode TEXT NOT NULL CHECK (mode IN ('disabled', 'approval', 'automatic')),
  policy_version INTEGER NOT NULL CHECK (policy_version > 0),
  updated_by_user_id TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (repository_id, operation_kind),
  FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE,
  FOREIGN KEY (operation_kind) REFERENCES operation_policies(operation_kind),
  FOREIGN KEY (updated_by_user_id) REFERENCES users(id)
) STRICT;

CREATE TABLE IF NOT EXISTS repository_capability_policies (
  repository_id TEXT NOT NULL,
  capability_kind TEXT NOT NULL CHECK (length(capability_kind) > 0),
  mode TEXT NOT NULL CHECK (mode IN ('disabled', 'approval', 'automatic')),
  constraints_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(constraints_json)),
  policy_version INTEGER NOT NULL CHECK (policy_version > 0),
  updated_by_user_id TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (repository_id, capability_kind),
  FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE,
  FOREIGN KEY (capability_kind) REFERENCES instance_capability_policies(capability_kind),
  FOREIGN KEY (updated_by_user_id) REFERENCES users(id)
) STRICT;

INSERT OR IGNORE INTO settings (key, value) VALUES ('policy_version', '1');
INSERT OR IGNORE INTO settings (key, value) VALUES ('assignment_epoch', '1');

CREATE TRIGGER IF NOT EXISTS settings_team_counters_monotonic
BEFORE UPDATE OF value ON settings
WHEN OLD.key IN ('policy_version', 'assignment_epoch')
  AND (NEW.value GLOB '*[^0-9]*' OR length(NEW.value) = 0 OR CAST(NEW.value AS INTEGER) < CAST(OLD.value AS INTEGER))
BEGIN
  SELECT RAISE(ABORT, 'team/workspace counters are monotonic positive integers');
END;

INSERT OR IGNORE INTO repository_operation_policies
  (repository_id, operation_kind, mode, policy_version)
SELECT repositories.id, operation_policies.operation_kind, operation_policies.mode, 1
FROM repositories CROSS JOIN operation_policies
WHERE repositories.active = 1;

INSERT OR IGNORE INTO repository_capability_policies
  (repository_id, capability_kind, mode, constraints_json, policy_version)
SELECT repositories.id, instance_capability_policies.capability_kind,
  instance_capability_policies.mode, instance_capability_policies.constraints_json, 1
FROM repositories CROSS JOIN instance_capability_policies
WHERE repositories.active = 1;

ALTER TABLE agent_runs ADD COLUMN assignment_id TEXT REFERENCES agent_repository_assignments(id);
ALTER TABLE agent_runs ADD COLUMN assignment_version INTEGER CHECK (assignment_version IS NULL OR assignment_version > 0);
ALTER TABLE agent_runs ADD COLUMN assignment_config_hash TEXT CHECK (assignment_config_hash IS NULL OR length(assignment_config_hash) = 64);
ALTER TABLE agent_runs ADD COLUMN repository_id TEXT REFERENCES repositories(id);
ALTER TABLE agent_runs ADD COLUMN repository_policy_hash TEXT CHECK (repository_policy_hash IS NULL OR length(repository_policy_hash) = 64);
ALTER TABLE agent_runs ADD COLUMN repository_policy_version INTEGER CHECK (repository_policy_version IS NULL OR repository_policy_version > 0);

CREATE INDEX IF NOT EXISTS idx_agent_runs_assignment
  ON agent_runs(assignment_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_runs_repository
  ON agent_runs(repository_id, created_at DESC);

CREATE TRIGGER IF NOT EXISTS agent_runs_assignment_binding_insert
BEFORE INSERT ON agent_runs
WHEN ((NEW.assignment_id IS NULL) <> (NEW.assignment_version IS NULL))
  OR ((NEW.assignment_id IS NULL) <> (NEW.assignment_config_hash IS NULL))
  OR (NEW.assignment_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM agent_repository_assignments
    WHERE id = NEW.assignment_id AND agent_id = NEW.agent_id AND repository_id = NEW.repository_id
      AND version = NEW.assignment_version AND config_hash = NEW.assignment_config_hash
  ))
  OR ((NEW.repository_policy_hash IS NULL) <> (NEW.repository_policy_version IS NULL))
BEGIN
  SELECT RAISE(ABORT, 'run assignment and repository policy bindings must be exact');
END;

CREATE TRIGGER IF NOT EXISTS agent_runs_assignment_binding_update
BEFORE UPDATE OF assignment_id, assignment_version, assignment_config_hash, repository_id, repository_policy_hash, repository_policy_version, agent_id ON agent_runs
WHEN ((NEW.assignment_id IS NULL) <> (NEW.assignment_version IS NULL))
  OR ((NEW.assignment_id IS NULL) <> (NEW.assignment_config_hash IS NULL))
  OR (NEW.assignment_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM agent_repository_assignments
    WHERE id = NEW.assignment_id AND agent_id = NEW.agent_id AND repository_id = NEW.repository_id
      AND version = NEW.assignment_version AND config_hash = NEW.assignment_config_hash
  ))
  OR ((NEW.repository_policy_hash IS NULL) <> (NEW.repository_policy_version IS NULL))
BEGIN
  SELECT RAISE(ABORT, 'run assignment and repository policy bindings must be exact');
END;

ALTER TABLE audit_records ADD COLUMN actor_user_id TEXT REFERENCES users(id);
ALTER TABLE audit_records ADD COLUMN actor_identity_json TEXT CHECK (actor_identity_json IS NULL OR json_valid(actor_identity_json));

CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_dedupe_membership
  ON audit_records(action, resource_type, resource_id)
  WHERE action = 'membership.invitation_accepted';
CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_dedupe_policy_unconfigured
  ON audit_records(action, resource_type, resource_id)
  WHERE action = 'repository.policy_unconfigured';

UPDATE gardener_schema SET version = 7 WHERE singleton = 1 AND version = 6;
