-- Additive Flue-native runtime product state and D1/Cron delivery outbox.
ALTER TABLE agent_runs ADD COLUMN runtime_driver TEXT NOT NULL DEFAULT 'workflow-v1'
  CHECK (runtime_driver IN ('workflow-v1', 'flue-native-v1'));
ALTER TABLE agent_runs ADD COLUMN result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json));
ALTER TABLE agent_runs ADD COLUMN result_hash TEXT CHECK (result_hash IS NULL OR length(result_hash) = 64);
ALTER TABLE agent_runs ADD COLUMN cancel_requested_at TEXT;
ALTER TABLE agent_runs ADD COLUMN cancel_reason TEXT;
ALTER TABLE agent_runs ADD COLUMN native_model_id TEXT
  CHECK (native_model_id IS NULL OR length(native_model_id) > 0);
ALTER TABLE agent_runs ADD COLUMN native_profile TEXT
  CHECK (native_profile IS NULL OR length(native_profile) > 0);
ALTER TABLE agent_runs ADD COLUMN native_request_protocol TEXT
  CHECK (native_request_protocol IS NULL OR length(native_request_protocol) > 0);
ALTER TABLE agent_runs ADD COLUMN terminal_claim_hash TEXT
  CHECK (terminal_claim_hash IS NULL OR length(terminal_claim_hash) = 64);

CREATE TRIGGER agent_runs_runtime_driver_immutable
BEFORE UPDATE OF runtime_driver ON agent_runs
WHEN NEW.runtime_driver <> OLD.runtime_driver
BEGIN
  SELECT RAISE(ABORT, 'run runtime driver is immutable');
END;

CREATE TRIGGER agent_runs_native_fields_insert
BEFORE INSERT ON agent_runs
WHEN ((NEW.result_json IS NULL) <> (NEW.result_hash IS NULL))
  OR (NEW.cancel_reason IS NOT NULL AND NEW.cancel_requested_at IS NULL)
  OR (NEW.runtime_driver = 'flue-native-v1' AND
      (NEW.native_model_id IS NULL OR NEW.native_profile IS NULL OR NEW.native_request_protocol IS NULL))
  OR (NEW.runtime_driver <> 'flue-native-v1' AND
      (NEW.native_model_id IS NOT NULL OR NEW.native_profile IS NOT NULL
       OR NEW.native_request_protocol IS NOT NULL OR NEW.terminal_claim_hash IS NOT NULL))
BEGIN
  SELECT RAISE(ABORT, 'run native fields are invalid');
END;

CREATE TRIGGER agent_runs_native_fields_update
BEFORE UPDATE OF result_json, result_hash, cancel_requested_at, cancel_reason ON agent_runs
WHEN ((NEW.result_json IS NULL) <> (NEW.result_hash IS NULL))
  OR (OLD.result_json IS NOT NULL AND (NEW.result_json IS NOT OLD.result_json OR NEW.result_hash IS NOT OLD.result_hash))
  OR (NEW.cancel_reason IS NOT NULL AND NEW.cancel_requested_at IS NULL)
  OR (OLD.cancel_requested_at IS NOT NULL AND
      (NEW.cancel_requested_at IS NOT OLD.cancel_requested_at OR NEW.cancel_reason IS NOT OLD.cancel_reason))
BEGIN
  SELECT RAISE(ABORT, 'run result is immutable and cancellation is monotonic');
END;

CREATE TRIGGER agent_runs_native_protocol_fields_update
BEFORE UPDATE OF native_model_id, native_profile, native_request_protocol, terminal_claim_hash ON agent_runs
WHEN NEW.native_model_id IS NOT OLD.native_model_id
  OR NEW.native_profile IS NOT OLD.native_profile
  OR NEW.native_request_protocol IS NOT OLD.native_request_protocol
  OR (OLD.terminal_claim_hash IS NOT NULL AND NEW.terminal_claim_hash IS NOT OLD.terminal_claim_hash)
  OR (NEW.terminal_claim_hash IS NOT NULL AND NEW.runtime_driver <> 'flue-native-v1')
BEGIN
  SELECT RAISE(ABORT, 'run native protocol is immutable and terminal claim is monotonic');
END;

CREATE UNIQUE INDEX idx_audit_dedupe_run_cancellation
  ON audit_records(action, resource_type, resource_id)
  WHERE action = 'agent_run.cancel_requested';

CREATE TABLE flue_dispatch_outbox (
  run_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'accepted', 'settled')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  claim_token TEXT,
  claim_expires_at TEXT,
  settlement_outcome TEXT CHECK (settlement_outcome IS NULL OR settlement_outcome IN ('completed', 'failed', 'aborted')),
  settlement_error_json TEXT CHECK (settlement_error_json IS NULL OR json_valid(settlement_error_json)),
  last_error_json TEXT CHECK (last_error_json IS NULL OR json_valid(last_error_json)),
  settled_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (run_id, request_id),
  FOREIGN KEY (run_id, request_id) REFERENCES harness_requests(run_id, request_id) ON DELETE CASCADE,
  CHECK ((claim_token IS NULL) = (claim_expires_at IS NULL)),
  CHECK ((state = 'settled' AND settlement_outcome IS NOT NULL AND settled_at IS NOT NULL)
    OR (state <> 'settled' AND settlement_outcome IS NULL AND settled_at IS NULL))
) STRICT;

CREATE INDEX idx_flue_dispatch_outbox_due
  ON flue_dispatch_outbox(state, next_attempt_at, claim_expires_at);

UPDATE gardener_schema SET version = 8 WHERE singleton = 1 AND version = 7;
