-- GM所有の独立proof世代だけを制御する。鍵Material/Actor/コード参照を保存しない。
CREATE TABLE group_recipient_code_proof_key_state (
  id smallint PRIMARY KEY CHECK (id = 1),
  current_key_version text CHECK (
    current_key_version IS NULL OR
    (length(current_key_version) BETWEEN 1 AND 255 AND current_key_version ~ '^[A-Za-z0-9._:-]+$')
  ),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO group_recipient_code_proof_key_state (id, current_key_version) VALUES (1, NULL);

-- ADR #55の許可項目だけ。直接Group FK/削除cascadeを持たず90日保持する。
CREATE TABLE group_recipient_invitation_audit_record (
  request_id uuid PRIMARY KEY,
  occurred_at timestamptz NOT NULL,
  action text NOT NULL CHECK (action = 'CreateInvitationFromRecipientCode'),
  decision text NOT NULL CHECK (decision = 'allow'),
  reason_code text NOT NULL CHECK (reason_code = 'InvitationCreated'),
  policy_version bigint NOT NULL CHECK (policy_version > 0),
  actor_pseudonym bytea NOT NULL CHECK (octet_length(actor_pseudonym) = 32),
  group_pseudonym bytea NOT NULL CHECK (octet_length(group_pseudonym) = 32),
  resource_pseudonym bytea NOT NULL CHECK (octet_length(resource_pseudonym) = 32),
  request_fingerprint bytea NOT NULL CHECK (octet_length(request_fingerprint) = 32),
  audit_key_version text NOT NULL CHECK (
    length(audit_key_version) BETWEEN 1 AND 255 AND audit_key_version ~ '^[A-Za-z0-9._:-]+$'
  ),
  UNIQUE (audit_key_version, request_fingerprint)
);
CREATE INDEX group_recipient_invitation_audit_retention_idx
  ON group_recipient_invitation_audit_record (occurred_at);
