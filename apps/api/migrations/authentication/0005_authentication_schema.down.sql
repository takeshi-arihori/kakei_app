DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM authentication.actor)
    OR EXISTS (SELECT 1 FROM authentication.google_identity)
    OR EXISTS (SELECT 1 FROM authentication.identity_alias)
    OR EXISTS (SELECT 1 FROM authentication.login_attempt)
    OR EXISTS (SELECT 1 FROM authentication.session_record)
    OR EXISTS (SELECT 1 FROM authentication.audit_event)
    OR EXISTS (SELECT 1 FROM authentication.key_generation)
    OR EXISTS (SELECT 1 FROM authentication.deletion_intent)
    OR (SELECT count(*) FROM authentication.key_state) <> 1
    OR EXISTS (
      SELECT 1
      FROM authentication.key_state
      WHERE status <> 'uninitialized'
        OR epoch IS NOT NULL
        OR generation_version <> 1
    )
  THEN
    RAISE EXCEPTION 'authentication schema down migration requires an unused schema';
  END IF;
END
$$;

DROP TABLE authentication.deletion_intent;
DROP TABLE authentication.key_generation;
DROP TABLE authentication.audit_event;
DROP TABLE authentication.session_record;
DROP TABLE authentication.login_attempt;
DROP TABLE authentication.identity_alias;
DROP TABLE authentication.google_identity;
DROP TABLE authentication.actor;
DROP TABLE authentication.key_state;

DROP TYPE authentication.deletion_intent_state;
DROP TYPE authentication.key_purpose;
DROP TYPE authentication.key_state_status;
DROP TYPE authentication.audit_reason;
DROP TYPE authentication.audit_decision;
DROP TYPE authentication.audit_action;
DROP TYPE authentication.session_state;
DROP TYPE authentication.login_attempt_state;
DROP TYPE authentication.actor_state;
DROP DOMAIN authentication.positive_safe_integer;
DROP DOMAIN authentication.utc_milliseconds;

DROP SCHEMA authentication;
DELETE FROM app_schema_migrations WHERE version = 5;
