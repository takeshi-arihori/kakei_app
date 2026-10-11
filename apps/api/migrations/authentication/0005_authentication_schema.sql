CREATE SCHEMA authentication;

CREATE TYPE authentication.actor_state AS ENUM ('active', 'disabled');
CREATE TYPE authentication.login_attempt_state AS ENUM (
  'ready',
  'consumed',
  'replaced'
);
CREATE TYPE authentication.session_state AS ENUM ('active', 'revoked');
CREATE TYPE authentication.audit_action AS ENUM (
  'begin',
  'read-attempt',
  'complete',
  'inspect',
  'activity',
  'logout',
  'disable',
  'purge'
);
CREATE TYPE authentication.audit_decision AS ENUM ('allow', 'deny');
CREATE TYPE authentication.audit_reason AS ENUM (
  'success',
  'invalid-credential',
  'expired',
  'replayed',
  'disabled',
  'unavailable',
  'already-authenticated',
  'restart-required',
  'csrf-invalid',
  'state-mismatch',
  'concurrency-conflict'
);
CREATE TYPE authentication.key_state_status AS ENUM (
  'uninitialized',
  'active',
  'rotating',
  'restoring',
  'quarantined'
);
CREATE TYPE authentication.deletion_intent_state AS ENUM (
  'prepared',
  'complete'
);

CREATE DOMAIN authentication.utc_milliseconds AS bigint
  CHECK (VALUE BETWEEN 0 AND 9007199254740991);
CREATE DOMAIN authentication.positive_safe_integer AS bigint
  CHECK (VALUE BETWEEN 1 AND 9007199254740991);

CREATE TABLE authentication.actor (
  actor_id uuid PRIMARY KEY,
  state authentication.actor_state NOT NULL,
  version authentication.positive_safe_integer NOT NULL,
  created_at_ms authentication.utc_milliseconds NOT NULL,
  disabled_at_ms authentication.utc_milliseconds,
  control_key_version text NOT NULL
    CHECK (control_key_version ~ '^[A-Za-z0-9._:-]+$'),
  state_mac bytea NOT NULL CHECK (octet_length(state_mac) = 32),
  CHECK (
    (state = 'active' AND disabled_at_ms IS NULL)
    OR (
      state = 'disabled'
      AND disabled_at_ms IS NOT NULL
      AND disabled_at_ms >= created_at_ms
    )
  )
);

CREATE TABLE authentication.google_identity (
  identity_id uuid PRIMARY KEY,
  actor_id uuid NOT NULL UNIQUE
    REFERENCES authentication.actor (actor_id) ON DELETE RESTRICT,
  version authentication.positive_safe_integer NOT NULL,
  envelope_version smallint NOT NULL CHECK (envelope_version > 0),
  algorithm_id text NOT NULL CHECK (algorithm_id = 'AES-256-GCM'),
  schema_version authentication.positive_safe_integer NOT NULL,
  key_version text NOT NULL
    CHECK (key_version ~ '^[A-Za-z0-9._:-]+$'),
  ciphertext bytea NOT NULL CHECK (octet_length(ciphertext) > 0),
  nonce bytea NOT NULL CHECK (octet_length(nonce) = 12),
  authentication_tag bytea NOT NULL
    CHECK (octet_length(authentication_tag) = 16),
  created_at_ms authentication.utc_milliseconds NOT NULL
);

CREATE TABLE authentication.identity_alias (
  purpose text NOT NULL CHECK (purpose = 'auth-google-identity/v1'),
  digest_key_version text NOT NULL
    CHECK (digest_key_version ~ '^[A-Za-z0-9._:-]+$'),
  digest bytea NOT NULL CHECK (octet_length(digest) = 32),
  identity_id uuid NOT NULL
    REFERENCES authentication.google_identity (identity_id) ON DELETE CASCADE,
  created_at_ms authentication.utc_milliseconds NOT NULL,
  PRIMARY KEY (purpose, digest_key_version, digest),
  UNIQUE (identity_id, digest_key_version)
);

CREATE INDEX authentication_identity_alias_identity_idx
  ON authentication.identity_alias (identity_id);

CREATE TABLE authentication.login_attempt (
  attempt_id uuid PRIMARY KEY,
  version authentication.positive_safe_integer NOT NULL,
  epoch uuid NOT NULL,
  created_at_ms authentication.utc_milliseconds NOT NULL,
  expires_at_ms authentication.utc_milliseconds NOT NULL,
  state authentication.login_attempt_state NOT NULL,
  terminal_at_ms authentication.utc_milliseconds,
  cookie_digest_key_version text NOT NULL
    CHECK (cookie_digest_key_version ~ '^[A-Za-z0-9._:-]+$'),
  cookie_digest bytea NOT NULL CHECK (octet_length(cookie_digest) = 32),
  envelope_version smallint NOT NULL CHECK (envelope_version > 0),
  algorithm_id text NOT NULL CHECK (algorithm_id = 'AES-256-GCM'),
  schema_version authentication.positive_safe_integer NOT NULL,
  key_version text NOT NULL
    CHECK (key_version ~ '^[A-Za-z0-9._:-]+$'),
  ciphertext bytea NOT NULL CHECK (octet_length(ciphertext) > 0),
  nonce bytea NOT NULL CHECK (octet_length(nonce) = 12),
  authentication_tag bytea NOT NULL
    CHECK (octet_length(authentication_tag) = 16),
  UNIQUE (cookie_digest_key_version, cookie_digest),
  CHECK (expires_at_ms = created_at_ms + 300000),
  CHECK (
    (state = 'ready' AND terminal_at_ms IS NULL)
    OR (
      state IN ('consumed', 'replaced')
      AND terminal_at_ms IS NOT NULL
      AND terminal_at_ms >= created_at_ms
    )
  )
);

CREATE INDEX authentication_login_attempt_expiry_idx
  ON authentication.login_attempt (expires_at_ms)
  WHERE state = 'ready';
CREATE INDEX authentication_login_attempt_terminal_idx
  ON authentication.login_attempt (terminal_at_ms)
  WHERE terminal_at_ms IS NOT NULL;

CREATE TABLE authentication.session_record (
  session_id uuid PRIMARY KEY,
  actor_id uuid NOT NULL
    REFERENCES authentication.actor (actor_id) ON DELETE RESTRICT,
  version authentication.positive_safe_integer NOT NULL,
  epoch uuid NOT NULL,
  created_at_ms authentication.utc_milliseconds NOT NULL,
  absolute_expires_at_ms authentication.utc_milliseconds NOT NULL,
  idle_expires_at_ms authentication.utc_milliseconds NOT NULL,
  state authentication.session_state NOT NULL,
  terminal_at_ms authentication.utc_milliseconds,
  cookie_digest_key_version text NOT NULL
    CHECK (cookie_digest_key_version ~ '^[A-Za-z0-9._:-]+$'),
  cookie_digest bytea NOT NULL CHECK (octet_length(cookie_digest) = 32),
  envelope_version smallint NOT NULL CHECK (envelope_version > 0),
  algorithm_id text NOT NULL CHECK (algorithm_id = 'AES-256-GCM'),
  schema_version authentication.positive_safe_integer NOT NULL,
  key_version text NOT NULL
    CHECK (key_version ~ '^[A-Za-z0-9._:-]+$'),
  ciphertext bytea NOT NULL CHECK (octet_length(ciphertext) > 0),
  nonce bytea NOT NULL CHECK (octet_length(nonce) = 12),
  authentication_tag bytea NOT NULL
    CHECK (octet_length(authentication_tag) = 16),
  UNIQUE (cookie_digest_key_version, cookie_digest),
  CHECK (
    absolute_expires_at_ms > created_at_ms
    AND absolute_expires_at_ms - created_at_ms <= 604800000
  ),
  CHECK (
    idle_expires_at_ms > created_at_ms
    AND idle_expires_at_ms <= absolute_expires_at_ms
  ),
  CHECK (
    (state = 'active' AND terminal_at_ms IS NULL)
    OR (
      state = 'revoked'
      AND terminal_at_ms IS NOT NULL
      AND terminal_at_ms >= created_at_ms
    )
  )
);

CREATE INDEX authentication_session_actor_state_idx
  ON authentication.session_record (actor_id, state);
CREATE INDEX authentication_session_expiry_idx
  ON authentication.session_record (
    LEAST(idle_expires_at_ms, absolute_expires_at_ms)
  )
  WHERE state = 'active';
CREATE INDEX authentication_session_terminal_idx
  ON authentication.session_record (terminal_at_ms)
  WHERE terminal_at_ms IS NOT NULL;

CREATE TABLE authentication.audit_event (
  event_id uuid PRIMARY KEY,
  request_id uuid NOT NULL,
  occurred_at_ms authentication.utc_milliseconds NOT NULL,
  action authentication.audit_action NOT NULL,
  decision authentication.audit_decision NOT NULL,
  reason authentication.audit_reason NOT NULL,
  actor_digest_key_version text
    CHECK (actor_digest_key_version ~ '^[A-Za-z0-9._:-]+$'),
  actor_digest bytea CHECK (actor_digest IS NULL OR octet_length(actor_digest) = 32),
  attempt_digest_key_version text
    CHECK (attempt_digest_key_version ~ '^[A-Za-z0-9._:-]+$'),
  attempt_digest bytea
    CHECK (attempt_digest IS NULL OR octet_length(attempt_digest) = 32),
  session_digest_key_version text
    CHECK (session_digest_key_version ~ '^[A-Za-z0-9._:-]+$'),
  session_digest bytea
    CHECK (session_digest IS NULL OR octet_length(session_digest) = 32),
  audit_key_version text NOT NULL
    CHECK (audit_key_version ~ '^[A-Za-z0-9._:-]+$'),
  CHECK ((actor_digest_key_version IS NULL) = (actor_digest IS NULL)),
  CHECK ((attempt_digest_key_version IS NULL) = (attempt_digest IS NULL)),
  CHECK ((session_digest_key_version IS NULL) = (session_digest IS NULL))
);

CREATE INDEX authentication_audit_expiry_idx
  ON authentication.audit_event (occurred_at_ms);
CREATE UNIQUE INDEX authentication_audit_successful_attempt_idx
  ON authentication.audit_event (attempt_digest_key_version, attempt_digest)
  WHERE action = 'complete'
    AND decision = 'allow'
    AND attempt_digest IS NOT NULL;

CREATE TABLE authentication.key_state (
  state_id smallint PRIMARY KEY CHECK (state_id = 1),
  status authentication.key_state_status NOT NULL,
  generation_version authentication.positive_safe_integer NOT NULL,
  epoch uuid,
  CHECK (
    (status = 'uninitialized' AND epoch IS NULL)
    OR (status <> 'uninitialized' AND epoch IS NOT NULL)
  )
);

CREATE TYPE authentication.key_purpose AS ENUM (
  'google-identity-search',
  'login-attempt-cookie',
  'session-cookie',
  'actor-state-mac',
  'audit-actor',
  'audit-attempt',
  'audit-session',
  'deleted-actor',
  'deletion-ledger-mac'
);

CREATE TABLE authentication.key_generation (
  generation_id uuid PRIMARY KEY,
  purpose authentication.key_purpose NOT NULL,
  key_version text NOT NULL
    CHECK (key_version ~ '^[A-Za-z0-9._:-]+$'),
  epoch uuid,
  searchable boolean NOT NULL,
  write_required boolean NOT NULL,
  retired_at_ms authentication.utc_milliseconds,
  UNIQUE NULLS NOT DISTINCT (purpose, key_version, epoch),
  CHECK (
    (purpose IN ('login-attempt-cookie', 'session-cookie') AND epoch IS NOT NULL)
    OR (purpose NOT IN ('login-attempt-cookie', 'session-cookie') AND epoch IS NULL)
  ),
  CHECK (
    retired_at_ms IS NULL
    OR (searchable = false AND write_required = false)
  )
);

CREATE INDEX authentication_key_generation_search_idx
  ON authentication.key_generation (purpose, epoch, key_version)
  WHERE searchable;
CREATE INDEX authentication_key_generation_write_idx
  ON authentication.key_generation (purpose, epoch, key_version)
  WHERE write_required;

INSERT INTO authentication.key_state (
  state_id,
  status,
  generation_version,
  epoch
) VALUES (1, 'uninitialized', 1, NULL);

CREATE TABLE authentication.deletion_intent (
  operation_id uuid PRIMARY KEY,
  actor_digest_key_version text NOT NULL
    CHECK (actor_digest_key_version ~ '^[A-Za-z0-9._:-]+$'),
  actor_digest bytea NOT NULL CHECK (octet_length(actor_digest) = 32),
  version authentication.positive_safe_integer NOT NULL,
  state authentication.deletion_intent_state NOT NULL,
  created_at_ms authentication.utc_milliseconds NOT NULL,
  updated_at_ms authentication.utc_milliseconds NOT NULL,
  CHECK (updated_at_ms >= created_at_ms),
  UNIQUE (actor_digest_key_version, actor_digest)
);

CREATE INDEX authentication_deletion_intent_state_idx
  ON authentication.deletion_intent (state, created_at_ms);
