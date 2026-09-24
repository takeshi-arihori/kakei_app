DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM group_close_intent_registry LIMIT 1) THEN
    RAISE EXCEPTION 'CloseIntent registry down migration requires an empty registry';
  END IF;
END
$$;

DROP TABLE group_close_intent_registry;
DELETE FROM app_schema_migrations WHERE version = 3;
