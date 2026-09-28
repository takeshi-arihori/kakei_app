-- A retired registry row may retain only the opaque CloseIntent UUID and its
-- retention deadline. Existing retired rows, if any, are scrubbed before the
-- stricter shape constraint is installed.
ALTER TABLE group_close_intent_registry
  ALTER COLUMN created_at DROP NOT NULL;

UPDATE group_close_intent_registry
   SET created_at = NULL
 WHERE group_id IS NULL;

ALTER TABLE group_close_intent_registry
  DROP CONSTRAINT group_close_intent_registry_check;

ALTER TABLE group_close_intent_registry
  ADD CONSTRAINT group_close_intent_registry_shape_check CHECK (
    (
      group_id IS NOT NULL
      AND retain_until IS NULL
      AND created_at IS NOT NULL
    )
    OR
    (
      group_id IS NULL
      AND retain_until IS NOT NULL
      AND created_at IS NULL
    )
  );

-- This Retention Control Ledger record deliberately excludes Group identity,
-- actors, close details, and other Context data. The operation/version binding
-- is the minimum identity needed to recover the same committed GM receipt.
CREATE TABLE group_management_deletion_receipt_record (
  operation_id text PRIMARY KEY CHECK (length(btrim(operation_id)) > 0),
  intent_version bigint NOT NULL CHECK (intent_version > 0),
  canonical_receipt text NOT NULL CHECK (length(canonical_receipt) > 0)
);
