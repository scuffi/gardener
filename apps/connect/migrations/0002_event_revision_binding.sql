ALTER TABLE webhook_deliveries ADD COLUMN event_action TEXT;
ALTER TABLE webhook_deliveries ADD COLUMN event_state TEXT;
ALTER TABLE webhook_deliveries ADD COLUMN event_draft INTEGER;
ALTER TABLE webhook_deliveries ADD COLUMN head_sha TEXT;
ALTER TABLE webhook_deliveries ADD COLUMN base_ref TEXT;
ALTER TABLE webhook_deliveries ADD COLUMN base_sha TEXT;
