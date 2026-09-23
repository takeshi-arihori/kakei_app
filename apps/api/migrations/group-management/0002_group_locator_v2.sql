-- Preserve the v1 table for audit and forward-fix. No v1 digest can be re-keyed.
-- The table lock closes the gap between the row-count preflight and v2 DDL.
LOCK TABLE group_operation_locator IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM group_operation_locator LIMIT 1) THEN
    RAISE EXCEPTION 'legacy group operation locator rows require an owner decision';
  END IF;
END
$$;

-- The row exists before a key provider is wired. A NULL current version makes
-- command writes fail closed until an approved provider initializes it.
CREATE TABLE group_operation_locator_key_state (
  id smallint PRIMARY KEY CHECK (id = 1),
  current_key_version text CHECK (
    current_key_version IS NULL OR current_key_version ~ '^[A-Za-z0-9._:-]+$'
  ),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO group_operation_locator_key_state (id, current_key_version)
VALUES (1, NULL);

CREATE TABLE group_operation_locator_v2 (
  locator_digest bytea NOT NULL CHECK (octet_length(locator_digest) > 0),
  digest_key_version text NOT NULL CHECK (digest_key_version ~ '^[A-Za-z0-9._:-]+$'),
  command_fingerprint bytea NOT NULL CHECK (octet_length(command_fingerprint) > 0),
  group_id uuid NOT NULL REFERENCES group_aggregate_record(group_id) ON DELETE CASCADE,
  operation_result_record_id uuid NOT NULL UNIQUE,
  created_at timestamptz NOT NULL,
  UNIQUE (locator_digest, digest_key_version),
  FOREIGN KEY (group_id, operation_result_record_id)
    REFERENCES group_operation_result_record(group_id, logical_record_id)
    ON DELETE CASCADE
);

CREATE INDEX group_operation_locator_v2_group_idx
  ON group_operation_locator_v2 (group_id);

-- Close Intent and receipt details stay inside the protected payload. This
-- append-only record shape is consumed by the state writer in Task #95.
CREATE TABLE group_close_history_record (
  logical_record_id uuid PRIMARY KEY,
  group_id uuid NOT NULL REFERENCES group_aggregate_record(group_id) ON DELETE CASCADE,
  aggregate_version bigint NOT NULL CHECK (aggregate_version >= 0),
  envelope_version smallint NOT NULL CHECK (envelope_version > 0),
  algorithm_id text NOT NULL CHECK (algorithm_id = 'AES-256-GCM'),
  schema_version bigint NOT NULL CHECK (schema_version > 0),
  key_version text NOT NULL CHECK (key_version ~ '^[A-Za-z0-9._:-]+$'),
  ciphertext bytea NOT NULL CHECK (octet_length(ciphertext) > 0),
  nonce bytea NOT NULL CHECK (octet_length(nonce) = 12),
  authentication_tag bytea NOT NULL CHECK (octet_length(authentication_tag) = 16),
  created_at timestamptz NOT NULL
);

CREATE INDEX group_close_history_group_version_idx
  ON group_close_history_record (group_id, aggregate_version);
