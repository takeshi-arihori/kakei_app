DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM group_management_deletion_receipt_record LIMIT 1
  ) OR EXISTS (
    SELECT 1
      FROM group_close_intent_registry
     WHERE group_id IS NULL
     LIMIT 1
  ) THEN
    RAISE EXCEPTION 'Group Management retention down migration requires no committed deletion state';
  END IF;
END
$$;

DROP TABLE group_management_deletion_receipt_record;

ALTER TABLE group_close_intent_registry
  DROP CONSTRAINT group_close_intent_registry_shape_check;

ALTER TABLE group_close_intent_registry
  ADD CHECK (
    (group_id IS NOT NULL AND retain_until IS NULL)
    OR (group_id IS NULL AND retain_until IS NOT NULL)
  );

ALTER TABLE group_close_intent_registry
  ALTER COLUMN created_at SET NOT NULL;

DELETE FROM app_schema_migrations WHERE version = 4;
