-- Flue submissions outlive a Workflow attempt. Persist each immutable harness
-- request and accepted submission so retries reattach instead of dispatching
-- another model request.
CREATE TABLE harness_requests (
  run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  harness_id TEXT NOT NULL CHECK (length(harness_id) BETWEEN 1 AND 255),
  harness_version TEXT NOT NULL CHECK (length(harness_version) BETWEEN 1 AND 100),
  request_json TEXT NOT NULL CHECK (json_valid(request_json)),
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (run_id, request_id)
) STRICT;

CREATE INDEX idx_harness_requests_created
  ON harness_requests(created_at DESC);

CREATE TRIGGER harness_requests_immutable
BEFORE UPDATE ON harness_requests
BEGIN
  SELECT RAISE(ABORT, 'harness requests are immutable');
END;

CREATE TABLE harness_submissions (
  run_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  submission_id TEXT NOT NULL UNIQUE,
  harness_id TEXT NOT NULL CHECK (length(harness_id) BETWEEN 1 AND 255),
  harness_version TEXT NOT NULL CHECK (length(harness_version) BETWEEN 1 AND 100),
  submission_json TEXT NOT NULL CHECK (json_valid(submission_json)),
  submission_hash TEXT NOT NULL CHECK (length(submission_hash) = 64),
  accepted_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (run_id, request_id),
  FOREIGN KEY (run_id, request_id) REFERENCES harness_requests(run_id, request_id) ON DELETE CASCADE
) STRICT;

CREATE INDEX idx_harness_submissions_created
  ON harness_submissions(created_at DESC);

CREATE TRIGGER harness_submissions_immutable
BEFORE UPDATE ON harness_submissions
BEGIN
  SELECT RAISE(ABORT, 'harness submissions are immutable');
END;

UPDATE gardener_schema SET version = 6 WHERE singleton = 1 AND version = 5;
