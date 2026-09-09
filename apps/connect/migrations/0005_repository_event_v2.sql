ALTER TABLE webhook_deliveries ADD COLUMN normalized_event_json TEXT;
ALTER TABLE webhook_deliveries ADD COLUMN normalized_event_hash TEXT;
ALTER TABLE operation_receipts ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 1;
ALTER TABLE operation_receipts ADD COLUMN operation_hash TEXT;
