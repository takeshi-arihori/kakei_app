-- The legacy protected close history cannot be backfilled without the
-- approved Group data key provider. Never guess or silently skip its IDs.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM group_close_history_record LIMIT 1) THEN
    RAISE EXCEPTION 'protected close history requires an approved CloseIntent registry backfill';
  END IF;
END
$$;

CREATE TABLE group_close_intent_registry (
  close_intent_id uuid PRIMARY KEY,
  group_id uuid REFERENCES group_aggregate_record(group_id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  retain_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (group_id IS NOT NULL AND retain_until IS NULL)
    OR (group_id IS NULL AND retain_until IS NOT NULL)
  )
);

CREATE INDEX group_close_intent_registry_expiry_idx
  ON group_close_intent_registry (retain_until)
  WHERE group_id IS NULL;
