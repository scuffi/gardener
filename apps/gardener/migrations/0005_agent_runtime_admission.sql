-- Add a narrow lease around event-to-Agent selection so webhook retries reconcile
-- interrupted admission without allowing a later Agent revision to consume an old event.
ALTER TABLE repository_events
  ADD COLUMN admission_status TEXT NOT NULL DEFAULT 'pending'
  CHECK (admission_status IN ('pending', 'processing', 'completed'));
ALTER TABLE repository_events ADD COLUMN admission_token TEXT;
ALTER TABLE repository_events ADD COLUMN admission_lease_expires_at TEXT;
ALTER TABLE repository_events ADD COLUMN admission_completed_at TEXT;

UPDATE gardener_schema SET version = 5 WHERE singleton = 1 AND version = 4;
