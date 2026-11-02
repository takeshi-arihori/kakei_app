-- Accepted招待コードInventoryだけを追加する。Transaction/Checksumは既存Runnerが所有する。
-- 新ENUM用途はこのTransaction内で使用・初期化しない。既存世代とkey_stateは変更しない。
ALTER TYPE authentication.key_purpose ADD VALUE 'recipient-code-lookup';
ALTER TYPE authentication.key_purpose ADD VALUE 'recipient-code-state-mac';

CREATE TYPE authentication.recipient_code_state AS ENUM (
  'issued',
  'consumed',
  'replaced',
  'revoked'
);

CREATE TABLE authentication.recipient_code (
  code_id uuid PRIMARY KEY
    CHECK (code_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  recipient_actor_id uuid NOT NULL
    REFERENCES authentication.actor (actor_id) ON DELETE RESTRICT
    CHECK (recipient_actor_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  record_version authentication.positive_safe_integer NOT NULL,
  epoch uuid NOT NULL
    CHECK (epoch::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  created_at_ms authentication.utc_milliseconds NOT NULL,
  expires_at_ms authentication.utc_milliseconds NOT NULL,
  state authentication.recipient_code_state NOT NULL,
  terminal_at_ms authentication.utc_milliseconds,
  lookup_key_version text NOT NULL
    CHECK (lookup_key_version ~ '^[A-Za-z0-9._:-]+$' AND length(lookup_key_version) <= 255),
  lookup_digest bytea NOT NULL CHECK (octet_length(lookup_digest) = 32),
  mac_key_version text NOT NULL
    CHECK (mac_key_version ~ '^[A-Za-z0-9._:-]+$' AND length(mac_key_version) <= 255),
  state_mac bytea NOT NULL CHECK (octet_length(state_mac) = 32),
  CONSTRAINT authentication_recipient_code_lookup_unique
    UNIQUE (lookup_key_version, lookup_digest),
  CHECK (expires_at_ms = created_at_ms + 600000),
  CHECK (
    (state = 'issued' AND terminal_at_ms IS NULL)
    OR (
      state IN ('consumed', 'replaced', 'revoked')
      AND terminal_at_ms IS NOT NULL
      AND terminal_at_ms >= created_at_ms
    )
  )
);

-- 期限超過Issuedも新規発行時に明示終端化する。時刻をpartial predicateへ持ち込まない。
CREATE UNIQUE INDEX authentication_recipient_code_issued_actor_idx
  ON authentication.recipient_code (recipient_actor_id)
  WHERE state = 'issued';

-- Actor削除inventoryは終端行も対象とする。GroupへのFK/連鎖削除は持たない。
CREATE INDEX authentication_recipient_code_actor_idx
  ON authentication.recipient_code (recipient_actor_id);

-- 終端が期限後でも自然期限を清掃起算として失わない。Actor無効化の起算は後続保守が照合する。
CREATE INDEX authentication_recipient_code_cleanup_due_idx
  ON authentication.recipient_code (
    LEAST(expires_at_ms, COALESCE(terminal_at_ms, expires_at_ms))
  );
