ALTER TABLE operation_receipts ADD COLUMN attempt_token TEXT;
ALTER TABLE operation_receipts ADD COLUMN lease_expires_at INTEGER;

-- A deployment interrupted while an older operation was executing left no safe lease owner.
-- Mark it retryable; the exact operation payload and stable provider marker still bind the retry.
UPDATE operation_receipts
SET status = 'failed', error = 'Execution lease migrated; safe retry required', completed_at = CURRENT_TIMESTAMP
WHERE status = 'executing';
