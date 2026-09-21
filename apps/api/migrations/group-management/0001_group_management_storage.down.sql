DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM group_aggregate_record LIMIT 1) THEN
    RAISE EXCEPTION 'group storage down migration requires an empty schema';
  END IF;
END
$$;

DROP TABLE IF EXISTS group_operation_locator;
DROP TABLE IF EXISTS group_actor_access_index;
DROP TABLE IF EXISTS group_operation_result_record;
DROP TABLE IF EXISTS group_invitation_history_record;
DROP TABLE IF EXISTS group_membership_history_record;
DROP TABLE IF EXISTS group_invitation_record;
DROP TABLE IF EXISTS group_participant_record;
DROP TABLE IF EXISTS group_aggregate_record;

DELETE FROM app_schema_migrations WHERE version = 1;
