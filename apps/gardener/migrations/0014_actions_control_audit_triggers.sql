CREATE TRIGGER IF NOT EXISTS actions_repository_enabled_audit
AFTER UPDATE OF enabled ON actions_repository_enrollments
WHEN OLD.enabled <> NEW.enabled
BEGIN
  INSERT INTO actions_control_audit(scope,repository_id,task_id,bundle_hash,enabled,detail_json)
  VALUES ('repository',NEW.repository_id,NULL,NULL,NEW.enabled,'{"source":"database-trigger"}');
END;

CREATE TRIGGER IF NOT EXISTS actions_task_enabled_audit
AFTER UPDATE OF enabled ON actions_repository_tasks
WHEN OLD.enabled <> NEW.enabled
BEGIN
  INSERT INTO actions_control_audit(scope,repository_id,task_id,bundle_hash,enabled,detail_json)
  VALUES ('task',NEW.repository_id,NEW.task_id,NEW.bundle_hash,NEW.enabled,'{"source":"database-trigger"}');
END;

UPDATE gardener_schema SET version = 14 WHERE singleton = 1 AND version = 13;
