CREATE TABLE group_aggregate_record (
  group_id uuid PRIMARY KEY,
  logical_record_id uuid NOT NULL UNIQUE,
  aggregate_version bigint NOT NULL CHECK (aggregate_version >= 0),
  access_policy_version bigint NOT NULL CHECK (access_policy_version >= 0),
  envelope_version smallint NOT NULL CHECK (envelope_version > 0),
  algorithm_id text NOT NULL CHECK (algorithm_id = 'AES-256-GCM'),
  schema_version bigint NOT NULL CHECK (schema_version > 0),
  key_version text NOT NULL CHECK (key_version ~ '^[A-Za-z0-9._:-]+$'),
  ciphertext bytea NOT NULL CHECK (octet_length(ciphertext) > 0),
  nonce bytea NOT NULL CHECK (octet_length(nonce) = 12),
  authentication_tag bytea NOT NULL CHECK (octet_length(authentication_tag) = 16),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_partition_at timestamptz,
  CHECK (updated_at >= created_at)
);

CREATE INDEX group_aggregate_record_policy_version_idx
  ON group_aggregate_record (group_id, access_policy_version);
CREATE INDEX group_aggregate_record_deleted_partition_idx
  ON group_aggregate_record (deleted_partition_at)
  WHERE deleted_partition_at IS NOT NULL;

CREATE TABLE group_participant_record (
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
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_partition_at timestamptz,
  CHECK (updated_at >= created_at)
);

CREATE INDEX group_participant_record_group_idx
  ON group_participant_record (group_id, aggregate_version);

CREATE TABLE group_invitation_record (
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
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_partition_at timestamptz,
  CHECK (updated_at >= created_at)
);

CREATE INDEX group_invitation_record_group_idx
  ON group_invitation_record (group_id, aggregate_version);

CREATE TABLE group_membership_history_record (
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

CREATE UNIQUE INDEX group_membership_history_group_version_idx
  ON group_membership_history_record (group_id, aggregate_version, logical_record_id);

CREATE TABLE group_invitation_history_record (
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

CREATE UNIQUE INDEX group_invitation_history_group_version_idx
  ON group_invitation_history_record (group_id, aggregate_version, logical_record_id);

CREATE TABLE group_operation_result_record (
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
  created_at timestamptz NOT NULL,
  UNIQUE (group_id, logical_record_id)
);

CREATE INDEX group_operation_result_group_idx
  ON group_operation_result_record (group_id, aggregate_version);

CREATE TABLE group_actor_access_index (
  group_id uuid NOT NULL REFERENCES group_aggregate_record(group_id) ON DELETE CASCADE,
  actor_digest bytea NOT NULL CHECK (octet_length(actor_digest) > 0),
  digest_key_version text NOT NULL CHECK (digest_key_version ~ '^[A-Za-z0-9._:-]+$'),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (group_id, actor_digest),
  CHECK (updated_at >= created_at)
);

CREATE INDEX group_actor_access_digest_idx
  ON group_actor_access_index (actor_digest, digest_key_version);

CREATE TABLE group_operation_locator (
  actor_digest bytea NOT NULL CHECK (octet_length(actor_digest) > 0),
  operation_digest bytea NOT NULL CHECK (octet_length(operation_digest) > 0),
  command_fingerprint bytea NOT NULL CHECK (octet_length(command_fingerprint) > 0),
  digest_key_version text NOT NULL CHECK (digest_key_version ~ '^[A-Za-z0-9._:-]+$'),
  group_id uuid NOT NULL REFERENCES group_aggregate_record(group_id) ON DELETE CASCADE,
  operation_result_record_id uuid NOT NULL UNIQUE,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (actor_digest, operation_digest),
  FOREIGN KEY (group_id, operation_result_record_id)
    REFERENCES group_operation_result_record(group_id, logical_record_id)
    ON DELETE CASCADE
);

CREATE INDEX group_operation_locator_group_idx
  ON group_operation_locator (group_id);
