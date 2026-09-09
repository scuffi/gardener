PRAGMA foreign_keys = ON;

-- Destructive, one-time cutover for installations that already applied 0001-0003.
-- Repository rows, settings, and operation policy modes intentionally survive.
-- The unique guard and all destructive statements execute in one D1 batch. A
-- stale concurrent initializer fails at the guard before it can drop new data.
CREATE TABLE IF NOT EXISTS gardener_schema (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  version INTEGER NOT NULL CHECK (version >= 4),
  installed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;
INSERT INTO gardener_schema (singleton, version) VALUES (1, 5);

-- Child tables are removed before parents so foreign-key enforcement can stay on.
DROP TABLE IF EXISTS run_agent_results;
DROP TABLE IF EXISTS run_workflow_plans;
DROP TABLE IF EXISTS workflow_revisions;
DROP TABLE IF EXISTS proposals;
DROP TABLE IF EXISTS runs;
DROP TABLE IF EXISTS events;
DROP TABLE IF EXISTS workflows;
DROP TABLE IF EXISTS audit_records;

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS repositories (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  installation_id TEXT NOT NULL CHECK (length(installation_id) > 0),
  owner TEXT NOT NULL CHECK (length(owner) > 0),
  name TEXT NOT NULL CHECK (length(name) > 0),
  default_branch TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(owner, name)
);

CREATE TABLE IF NOT EXISTS operation_policies (
  operation_kind TEXT PRIMARY KEY CHECK (length(operation_kind) > 0),
  mode TEXT NOT NULL CHECK (mode IN ('disabled', 'approval', 'automatic')),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS audit_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT NOT NULL CHECK (length(actor) > 0),
  action TEXT NOT NULL CHECK (length(action) > 0),
  resource_type TEXT NOT NULL CHECK (length(resource_type) > 0),
  resource_id TEXT NOT NULL CHECK (length(resource_id) > 0),
  detail_json TEXT CHECK (detail_json IS NULL OR json_valid(detail_json)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE TABLE IF NOT EXISTS mcp_consent_states (
  handle_hash TEXT PRIMARY KEY CHECK (length(handle_hash) = 64),
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  csrf_digest TEXT NOT NULL CHECK (length(csrf_digest) = 64),
  owner_github_user_id TEXT NOT NULL CHECK (length(owner_github_user_id) > 0),
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
) STRICT;

CREATE TABLE IF NOT EXISTS gardener_schema (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  version INTEGER NOT NULL CHECK (version >= 4),
  installed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE TABLE IF NOT EXISTS instance_capability_policies (
  capability_kind TEXT PRIMARY KEY CHECK (length(capability_kind) > 0),
  mode TEXT NOT NULL CHECK (mode IN ('disabled', 'approval', 'automatic')),
  constraints_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(constraints_json)),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  slug TEXT NOT NULL UNIQUE CHECK (length(slug) > 0),
  name TEXT NOT NULL CHECK (length(name) > 0),
  description TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  revision_counter INTEGER NOT NULL DEFAULT 0 CHECK (revision_counter >= 0),
  created_by TEXT NOT NULL CHECK (length(created_by) > 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE TABLE IF NOT EXISTS agent_drafts (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  agent_id TEXT NOT NULL,
  source_md TEXT NOT NULL,
  source_hash TEXT NOT NULL CHECK (length(source_hash) = 64),
  parsed_json TEXT NOT NULL CHECK (json_valid(parsed_json)),
  validation_json TEXT NOT NULL CHECK (json_valid(validation_json)),
  provenance_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(provenance_json)),
  compiler_version TEXT NOT NULL CHECK (length(compiler_version) > 0),
  catalog_version TEXT NOT NULL CHECK (length(catalog_version) > 0),
  runtime_version TEXT NOT NULL CHECK (length(runtime_version) > 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  idempotency_key_hash TEXT CHECK (idempotency_key_hash IS NULL OR length(idempotency_key_hash) = 64),
  status TEXT NOT NULL DEFAULT 'editing' CHECK (status IN ('editing', 'published', 'discarded')),
  published_revision_id TEXT,
  created_by TEXT NOT NULL CHECK (length(created_by) > 0),
  updated_by TEXT NOT NULL CHECK (length(updated_by) > 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
  FOREIGN KEY (published_revision_id) REFERENCES agent_revisions(id)
) STRICT;

CREATE TABLE IF NOT EXISTS agent_revisions (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  agent_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  source_md TEXT NOT NULL,
  source_hash TEXT NOT NULL CHECK (length(source_hash) = 64),
  parsed_json TEXT NOT NULL CHECK (json_valid(parsed_json)),
  parsed_hash TEXT NOT NULL CHECK (length(parsed_hash) = 64),
  compiled_json TEXT NOT NULL CHECK (json_valid(compiled_json)),
  compiled_hash TEXT NOT NULL CHECK (length(compiled_hash) = 64),
  provenance_json TEXT NOT NULL CHECK (json_valid(provenance_json)),
  provenance_hash TEXT NOT NULL CHECK (length(provenance_hash) = 64),
  compiler_version TEXT NOT NULL CHECK (length(compiler_version) > 0),
  catalog_version TEXT NOT NULL CHECK (length(catalog_version) > 0),
  runtime_version TEXT NOT NULL CHECK (length(runtime_version) > 0),
  published_paused INTEGER NOT NULL DEFAULT 1 CHECK (published_paused = 1),
  published_by TEXT NOT NULL CHECK (length(published_by) > 0),
  published_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(agent_id, revision),
  UNIQUE(agent_id, id),
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS agent_activations (
  agent_id TEXT PRIMARY KEY,
  revision_id TEXT NOT NULL UNIQUE,
  activated_by TEXT NOT NULL CHECK (length(activated_by) > 0),
  activated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
  FOREIGN KEY (agent_id, revision_id) REFERENCES agent_revisions(agent_id, id) ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS agent_activation_history (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  agent_id TEXT NOT NULL,
  previous_revision_id TEXT,
  revision_id TEXT,
  action TEXT NOT NULL CHECK (action IN ('activate', 'deactivate')),
  actor_id TEXT NOT NULL CHECK (length(actor_id) > 0),
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ((action = 'activate' AND revision_id IS NOT NULL) OR (action = 'deactivate' AND revision_id IS NULL)),
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
  FOREIGN KEY (agent_id, previous_revision_id) REFERENCES agent_revisions(agent_id, id),
  FOREIGN KEY (agent_id, revision_id) REFERENCES agent_revisions(agent_id, id)
) STRICT;

CREATE TABLE IF NOT EXISTS agent_enablement_history (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  agent_id TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  actor_id TEXT NOT NULL CHECK (length(actor_id) > 0),
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS repository_events (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  schema_version INTEGER NOT NULL DEFAULT 2 CHECK (schema_version = 2),
  provider TEXT NOT NULL CHECK (length(provider) > 0),
  delivery_id TEXT NOT NULL CHECK (length(delivery_id) > 0),
  event_kind TEXT NOT NULL CHECK (length(event_kind) > 0),
  action TEXT NOT NULL CHECK (length(action) > 0),
  repository_id TEXT NOT NULL,
  resource_type TEXT NOT NULL CHECK (length(resource_type) > 0),
  resource_id TEXT NOT NULL CHECK (length(resource_id) > 0),
  actor_json TEXT NOT NULL CHECK (json_valid(actor_json)),
  resource_author_json TEXT CHECK (resource_author_json IS NULL OR json_valid(resource_author_json)),
  facts_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(facts_json)),
  envelope_json TEXT NOT NULL CHECK (json_valid(envelope_json)),
  envelope_hash TEXT NOT NULL CHECK (length(envelope_hash) = 64),
  occurred_at TEXT,
  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  admission_status TEXT NOT NULL DEFAULT 'pending' CHECK (admission_status IN ('pending', 'processing', 'completed')),
  admission_token TEXT,
  admission_lease_expires_at TEXT,
  admission_completed_at TEXT,
  CHECK ((admission_status = 'processing') = (admission_token IS NOT NULL AND admission_lease_expires_at IS NOT NULL)),
  UNIQUE(provider, delivery_id),
  FOREIGN KEY (repository_id) REFERENCES repositories(id)
) STRICT;

CREATE TABLE IF NOT EXISTS event_agent_admissions (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  event_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  admission_key TEXT NOT NULL UNIQUE CHECK (length(admission_key) = 64),
  status TEXT NOT NULL CHECK (status IN ('admitted', 'skipped')),
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(event_id, agent_id, revision_id),
  FOREIGN KEY (event_id) REFERENCES repository_events(id) ON DELETE CASCADE,
  FOREIGN KEY (agent_id, revision_id) REFERENCES agent_revisions(agent_id, id)
) STRICT;

CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  kind TEXT NOT NULL CHECK (kind IN ('live', 'simulation', 'manual', 'scheduled')),
  repository_event_id TEXT,
  agent_id TEXT NOT NULL,
  agent_revision_id TEXT NOT NULL,
  workflow_instance_id TEXT UNIQUE,
  parent_run_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('admitted', 'queued', 'running', 'waiting', 'completed', 'completed_with_errors', 'failed', 'cancelled')),
  run_snapshot_json TEXT NOT NULL CHECK (json_valid(run_snapshot_json)),
  run_snapshot_hash TEXT NOT NULL CHECK (length(run_snapshot_hash) = 64),
  policy_snapshot_json TEXT NOT NULL CHECK (json_valid(policy_snapshot_json)),
  policy_snapshot_hash TEXT NOT NULL CHECK (length(policy_snapshot_hash) = 64),
  capability_snapshot_json TEXT NOT NULL CHECK (json_valid(capability_snapshot_json)),
  capability_snapshot_hash TEXT NOT NULL CHECK (length(capability_snapshot_hash) = 64),
  harness_id TEXT NOT NULL CHECK (length(harness_id) > 0),
  harness_version TEXT NOT NULL CHECK (length(harness_version) > 0),
  budgets_json TEXT NOT NULL CHECK (json_valid(budgets_json)),
  usage_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(usage_json)),
  error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at TEXT,
  completed_at TEXT,
  CHECK (parent_run_id IS NULL OR parent_run_id <> id),
  CHECK (kind <> 'live' OR repository_event_id IS NOT NULL),
  FOREIGN KEY (repository_event_id) REFERENCES repository_events(id),
  FOREIGN KEY (agent_id, agent_revision_id) REFERENCES agent_revisions(agent_id, id),
  FOREIGN KEY (parent_run_id) REFERENCES agent_runs(id)
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_runs_live_event_agent
  ON agent_runs(repository_event_id, agent_id, agent_revision_id)
  WHERE kind = 'live';

CREATE TABLE IF NOT EXISTS run_tasks (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  run_id TEXT NOT NULL,
  parent_task_id TEXT,
  stable_key TEXT NOT NULL CHECK (length(stable_key) > 0),
  kind TEXT NOT NULL CHECK (length(kind) > 0),
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'waiting', 'completed', 'failed', 'cancelled')),
  parallel_group TEXT,
  depth INTEGER NOT NULL DEFAULT 0 CHECK (depth >= 0),
  assigned_agent_id TEXT,
  assigned_revision_id TEXT,
  input_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(input_json)),
  input_hash TEXT NOT NULL CHECK (length(input_hash) = 64),
  budgets_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(budgets_json)),
  usage_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(usage_json)),
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  result_hash TEXT CHECK (result_hash IS NULL OR length(result_hash) = 64),
  error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at TEXT,
  completed_at TEXT,
  UNIQUE(run_id, stable_key),
  UNIQUE(run_id, id),
  CHECK ((assigned_agent_id IS NULL) = (assigned_revision_id IS NULL)),
  CHECK (parent_task_id IS NULL OR parent_task_id <> id),
  FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE,
  FOREIGN KEY (run_id, parent_task_id) REFERENCES run_tasks(run_id, id),
  FOREIGN KEY (assigned_agent_id, assigned_revision_id) REFERENCES agent_revisions(agent_id, id)
) STRICT;

CREATE TABLE IF NOT EXISTS run_steps (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  run_id TEXT NOT NULL,
  task_id TEXT,
  stable_key TEXT NOT NULL CHECK (length(stable_key) > 0),
  kind TEXT NOT NULL CHECK (kind IN ('model', 'tool', 'checkpoint', 'effect', 'wait', 'workspace', 'evaluation')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'waiting', 'succeeded', 'failed', 'cancelled')),
  input_json TEXT NOT NULL CHECK (json_valid(input_json)),
  input_hash TEXT NOT NULL CHECK (length(input_hash) = 64),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 1 CHECK (max_attempts > 0 AND attempt_count <= max_attempts),
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  result_hash TEXT CHECK (result_hash IS NULL OR length(result_hash) = 64),
  artifact_refs_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(artifact_refs_json)),
  error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
  retry_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at TEXT,
  completed_at TEXT,
  UNIQUE(run_id, stable_key),
  UNIQUE(run_id, id),
  FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE,
  FOREIGN KEY (run_id, task_id) REFERENCES run_tasks(run_id, id)
) STRICT;

CREATE TABLE IF NOT EXISTS run_artifacts (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  run_id TEXT NOT NULL,
  task_id TEXT,
  step_id TEXT,
  kind TEXT NOT NULL CHECK (length(kind) > 0),
  r2_key TEXT NOT NULL UNIQUE CHECK (length(r2_key) > 0),
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  media_type TEXT NOT NULL CHECK (length(media_type) > 0),
  retention_until TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'quarantined', 'deleted')),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TEXT,
  CHECK ((status = 'deleted') = (deleted_at IS NOT NULL)),
  UNIQUE(run_id, id),
  FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE,
  FOREIGN KEY (run_id, task_id) REFERENCES run_tasks(run_id, id),
  FOREIGN KEY (run_id, step_id) REFERENCES run_steps(run_id, id)
) STRICT;

CREATE TABLE IF NOT EXISTS run_interruptions (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  run_id TEXT NOT NULL,
  task_id TEXT,
  step_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('clarification', 'capability', 'plan_review', 'effect_approval', 'patch_review', 'budget')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'responded', 'rejected', 'expired', 'cancelled')),
  eligible_responders_json TEXT NOT NULL CHECK (json_valid(eligible_responders_json)),
  eligible_responders_hash TEXT NOT NULL CHECK (length(eligible_responders_hash) = 64),
  request_payload_json TEXT NOT NULL CHECK (json_valid(request_payload_json)),
  request_payload_hash TEXT NOT NULL CHECK (length(request_payload_hash) = 64),
  response_payload_json TEXT CHECK (response_payload_json IS NULL OR json_valid(response_payload_json)),
  response_payload_hash TEXT CHECK (response_payload_hash IS NULL OR length(response_payload_hash) = 64),
  nonce_hash TEXT NOT NULL UNIQUE CHECK (length(nonce_hash) = 64),
  expires_at TEXT NOT NULL,
  responded_by TEXT,
  responded_at TEXT,
  terminal_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (status <> 'pending' OR (response_payload_json IS NULL AND response_payload_hash IS NULL AND responded_by IS NULL AND responded_at IS NULL AND terminal_at IS NULL)),
  CHECK (status NOT IN ('responded', 'rejected') OR (response_payload_json IS NOT NULL AND response_payload_hash IS NOT NULL AND responded_by IS NOT NULL AND responded_at IS NOT NULL AND terminal_at IS NOT NULL)),
  CHECK (status NOT IN ('expired', 'cancelled') OR terminal_at IS NOT NULL),
  UNIQUE(run_id, id),
  FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE,
  FOREIGN KEY (run_id, task_id) REFERENCES run_tasks(run_id, id),
  FOREIGN KEY (run_id, step_id) REFERENCES run_steps(run_id, id)
) STRICT;

CREATE TABLE IF NOT EXISTS effects (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  operation_id TEXT NOT NULL UNIQUE CHECK (length(operation_id) > 0),
  run_id TEXT NOT NULL,
  task_id TEXT,
  step_id TEXT,
  interruption_id TEXT,
  effect_kind TEXT NOT NULL CHECK (length(effect_kind) > 0),
  operation_json TEXT NOT NULL CHECK (json_valid(operation_json)),
  operation_hash TEXT NOT NULL CHECK (length(operation_hash) = 64),
  rationale TEXT NOT NULL,
  policy_mode TEXT NOT NULL CHECK (policy_mode IN ('disabled', 'approval', 'automatic')),
  policy_snapshot_hash TEXT NOT NULL CHECK (length(policy_snapshot_hash) = 64),
  status TEXT NOT NULL CHECK (status IN ('proposed', 'blocked', 'pending_approval', 'approved', 'executing', 'executed', 'rejected', 'failed', 'stale', 'cancelled')),
  approval_hash TEXT CHECK (approval_hash IS NULL OR length(approval_hash) = 64),
  receipt_json TEXT CHECK (receipt_json IS NULL OR json_valid(receipt_json)),
  receipt_hash TEXT CHECK (receipt_hash IS NULL OR length(receipt_hash) = 64),
  error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  decided_at TEXT,
  executed_at TEXT,
  CHECK (status <> 'executed' OR (receipt_json IS NOT NULL AND receipt_hash IS NOT NULL AND executed_at IS NOT NULL)),
  FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE,
  FOREIGN KEY (run_id, task_id) REFERENCES run_tasks(run_id, id),
  FOREIGN KEY (run_id, step_id) REFERENCES run_steps(run_id, id),
  FOREIGN KEY (run_id, interruption_id) REFERENCES run_interruptions(run_id, id),
  FOREIGN KEY (effect_kind) REFERENCES operation_policies(operation_kind)
) STRICT;

CREATE TABLE IF NOT EXISTS inbox_items (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  kind TEXT NOT NULL CHECK (kind IN ('interruption', 'effect', 'failed_run', 'draft_activation', 'eval_regression', 'workspace_cleanup')),
  run_id TEXT,
  entity_type TEXT NOT NULL CHECK (length(entity_type) > 0),
  entity_id TEXT NOT NULL CHECK (length(entity_id) > 0),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  title TEXT NOT NULL CHECK (length(title) > 0),
  summary TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
  eligible_responders_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(eligible_responders_json)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TEXT,
  UNIQUE(kind, entity_type, entity_id),
  CHECK ((status = 'open') = (resolved_at IS NULL)),
  FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS run_capability_grants (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  run_id TEXT NOT NULL,
  interruption_id TEXT,
  capability_kind TEXT NOT NULL CHECK (length(capability_kind) > 0),
  scope_json TEXT NOT NULL CHECK (json_valid(scope_json)),
  scope_hash TEXT NOT NULL CHECK (length(scope_hash) = 64),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'consumed', 'revoked', 'expired')),
  granted_by TEXT NOT NULL CHECK (length(granted_by) > 0),
  reason TEXT NOT NULL,
  max_uses INTEGER NOT NULL DEFAULT 1 CHECK (max_uses > 0),
  use_count INTEGER NOT NULL DEFAULT 0 CHECK (use_count >= 0 AND use_count <= max_uses),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  terminal_at TEXT,
  CHECK ((status = 'active') = (terminal_at IS NULL)),
  FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE,
  FOREIGN KEY (run_id, interruption_id) REFERENCES run_interruptions(run_id, id),
  FOREIGN KEY (capability_kind) REFERENCES instance_capability_policies(capability_kind)
) STRICT;

CREATE TABLE IF NOT EXISTS agent_eval_cases (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  agent_id TEXT NOT NULL,
  revision_id TEXT,
  name TEXT NOT NULL CHECK (length(name) > 0),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('package', 'dashboard', 'trace', 'system')),
  fixture_json TEXT NOT NULL CHECK (json_valid(fixture_json)),
  fixture_hash TEXT NOT NULL CHECK (length(fixture_hash) = 64),
  expectations_json TEXT NOT NULL CHECK (json_valid(expectations_json)),
  security_invariant INTEGER NOT NULL DEFAULT 0 CHECK (security_invariant IN (0, 1)),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_by TEXT NOT NULL CHECK (length(created_by) > 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(agent_id, name, fixture_hash),
  UNIQUE(agent_id, id),
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
  FOREIGN KEY (agent_id, revision_id) REFERENCES agent_revisions(agent_id, id)
) STRICT;

CREATE TABLE IF NOT EXISTS agent_eval_results (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  eval_case_id TEXT NOT NULL,
  run_id TEXT,
  agent_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'passed', 'failed', 'error', 'cancelled')),
  scorer_id TEXT NOT NULL CHECK (length(scorer_id) > 0),
  scorer_version TEXT NOT NULL CHECK (length(scorer_version) > 0),
  score REAL CHECK (score IS NULL OR (score >= 0 AND score <= 1)),
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  result_hash TEXT CHECK (result_hash IS NULL OR length(result_hash) = 64),
  artifact_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  CHECK (artifact_id IS NULL OR run_id IS NOT NULL),
  FOREIGN KEY (agent_id, eval_case_id) REFERENCES agent_eval_cases(agent_id, id) ON DELETE CASCADE,
  FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE,
  FOREIGN KEY (agent_id, revision_id) REFERENCES agent_revisions(agent_id, id),
  FOREIGN KEY (run_id, artifact_id) REFERENCES run_artifacts(run_id, id)
) STRICT;

CREATE TABLE IF NOT EXISTS workspace_leases (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  run_id TEXT NOT NULL,
  task_id TEXT,
  workspace_key TEXT NOT NULL UNIQUE CHECK (length(workspace_key) > 0),
  provider TEXT NOT NULL DEFAULT 'cloudflare-computer' CHECK (provider IN ('cloudflare-computer')),
  backend TEXT NOT NULL CHECK (backend IN ('filesystem', 'git', 'shell', 'javascript', 'container')),
  state TEXT NOT NULL CHECK (state IN ('provisioning', 'active', 'lost', 'releasing', 'released', 'failed')),
  lease_token_hash TEXT NOT NULL CHECK (length(lease_token_hash) = 64),
  lease_expires_at TEXT NOT NULL,
  cleanup_state TEXT NOT NULL DEFAULT 'not_due' CHECK (cleanup_state IN ('not_due', 'pending', 'claimed', 'completed', 'failed')),
  cleanup_after TEXT NOT NULL,
  cleanup_claim_token_hash TEXT CHECK (cleanup_claim_token_hash IS NULL OR length(cleanup_claim_token_hash) = 64),
  cleanup_claimed_by TEXT,
  cleanup_claimed_at TEXT,
  cleanup_claim_expires_at TEXT,
  cleanup_attempts INTEGER NOT NULL DEFAULT 0 CHECK (cleanup_attempts >= 0),
  last_error_json TEXT CHECK (last_error_json IS NULL OR json_valid(last_error_json)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  released_at TEXT,
  CHECK (cleanup_state <> 'claimed' OR (cleanup_claim_token_hash IS NOT NULL AND cleanup_claimed_by IS NOT NULL AND cleanup_claimed_at IS NOT NULL AND cleanup_claim_expires_at IS NOT NULL)),
  CHECK (state <> 'released' OR (released_at IS NOT NULL AND cleanup_state = 'completed')),
  FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE,
  FOREIGN KEY (run_id, task_id) REFERENCES run_tasks(run_id, id)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_agents_enabled ON agents(enabled, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_drafts_agent ON agent_drafts(agent_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_revisions_agent ON agent_revisions(agent_id, revision DESC);
CREATE INDEX IF NOT EXISTS idx_agent_activation_history_agent ON agent_activation_history(agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_repository_events_received ON repository_events(repository_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_event_admissions_event ON event_agent_admissions(event_id, status);
CREATE INDEX IF NOT EXISTS idx_agent_runs_status_created ON agent_runs(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_runs_agent_created ON agent_runs(agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_runs_parent ON agent_runs(parent_run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_run_tasks_parent ON run_tasks(run_id, parent_task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_run_tasks_parallel ON run_tasks(run_id, parallel_group, status);
CREATE INDEX IF NOT EXISTS idx_run_steps_task ON run_steps(run_id, task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_run_steps_status ON run_steps(status, retry_at);
CREATE INDEX IF NOT EXISTS idx_run_artifacts_retention ON run_artifacts(status, retention_until);
CREATE INDEX IF NOT EXISTS idx_interruptions_pending ON run_interruptions(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_effects_run ON effects(run_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_effects_pending ON effects(status, created_at);
CREATE INDEX IF NOT EXISTS idx_inbox_open ON inbox_items(status, priority, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_capability_grants_active ON run_capability_grants(run_id, capability_kind, expires_at) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_eval_results_revision ON agent_eval_results(agent_id, revision_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_workspace_cleanup ON workspace_leases(cleanup_state, cleanup_after, cleanup_claim_expires_at);

CREATE TRIGGER IF NOT EXISTS agent_revisions_no_update
BEFORE UPDATE ON agent_revisions
BEGIN
  SELECT RAISE(ABORT, 'agent revisions are immutable');
END;

CREATE TRIGGER IF NOT EXISTS agent_revisions_no_delete
BEFORE DELETE ON agent_revisions
WHEN EXISTS (SELECT 1 FROM agents WHERE id = OLD.agent_id)
BEGIN
  SELECT RAISE(ABORT, 'agent revisions are immutable');
END;

INSERT OR IGNORE INTO settings (key, value) VALUES ('global_paused', 'true');
INSERT OR IGNORE INTO settings (key, value) VALUES ('code_execution_enabled', 'false');
INSERT OR IGNORE INTO settings (key, value) VALUES ('onboarding_completed', 'false');

-- Existing operation defaults are retained for compatibility. New operation
-- kinds are disabled. INSERT OR IGNORE never raises an existing installation's mode.
INSERT OR IGNORE INTO operation_policies (operation_kind, mode) VALUES
  ('issue.label.add', 'approval'),
  ('issue.label.remove', 'approval'),
  ('issue.comment.create', 'approval'),
  ('issue.comment.update', 'approval'),
  ('issue.close', 'disabled'),
  ('issue.reopen', 'disabled'),
  ('branch.create', 'disabled'),
  ('commit.create', 'disabled'),
  ('pull_request.update', 'disabled'),
  ('pull_request.review.submit', 'disabled'),
  ('pull_request.merge', 'disabled'),
  ('issue.assignee.add', 'disabled'),
  ('issue.assignee.remove', 'disabled'),
  ('pull_request.comment.create', 'disabled'),
  ('pull_request.comment.update', 'disabled'),
  ('pull_request.reviewer.request', 'disabled'),
  ('pull_request.reviewer.remove', 'disabled'),
  ('pull_request.open_draft', 'disabled'),
  ('discussion.comment.create', 'disabled'),
  ('discussion.comment.update', 'disabled'),
  ('discussion.answer.mark', 'disabled'),
  ('discussion.answer.unmark', 'disabled'),
  ('discussion.close', 'disabled'),
  ('discussion.reopen', 'disabled'),
  ('check.rerun', 'disabled'),
  ('release.create', 'disabled'),
  ('release.update', 'disabled'),
  ('release.publish', 'disabled'),
  ('release.delete', 'disabled');

-- Retain every mode for still-supported operations while removing obsolete V1
-- catalog rows. Newly introduced kinds above remain disabled.
DELETE FROM operation_policies WHERE operation_kind NOT IN (
  'issue.label.add', 'issue.label.remove', 'issue.comment.create', 'issue.comment.update',
  'issue.close', 'issue.reopen', 'issue.assignee.add', 'issue.assignee.remove',
  'pull_request.comment.create', 'pull_request.comment.update', 'pull_request.review.submit',
  'pull_request.reviewer.request', 'pull_request.reviewer.remove', 'pull_request.update',
  'branch.create', 'commit.create', 'pull_request.open_draft', 'pull_request.merge',
  'discussion.comment.create', 'discussion.comment.update', 'discussion.answer.mark',
  'discussion.answer.unmark', 'discussion.close', 'discussion.reopen', 'check.rerun',
  'release.create', 'release.update', 'release.publish', 'release.delete'
);

-- Reads are safe only inside an explicitly enabled Agent. Writable and executable
-- Computer capabilities still require approval; container access does not imply network.
INSERT OR IGNORE INTO instance_capability_policies (capability_kind, mode) VALUES
  ('github.repository.metadata.read', 'automatic'),
  ('github.issue.read', 'automatic'),
  ('github.pull_request.read', 'automatic'),
  ('github.comment.read', 'automatic'),
  ('github.review.read', 'automatic'),
  ('github.discussion.read', 'automatic'),
  ('github.check.read', 'automatic'),
  ('github.contents.read', 'automatic'),
  ('github.commit.read', 'automatic'),
  ('github.release.read', 'automatic'),
  ('workspace.fs.read', 'automatic'),
  ('workspace.fs.write', 'approval'),
  ('workspace.git.read', 'automatic'),
  ('workspace.git.write-local', 'approval'),
  ('workspace.exec.shell', 'approval'),
  ('workspace.exec.javascript', 'approval'),
  ('workspace.exec.container', 'approval'),
  ('workspace.network.connect', 'disabled'),
  ('workspace.dependencies.install', 'disabled'),
  ('workspace.artifacts.publish', 'approval');
