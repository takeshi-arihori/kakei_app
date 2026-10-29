-- Accepted R4: コード監査を既存の認証Audit所有/保持へ写像する。
-- 追加Enumは同TransactionでEnum入力へcastせず、CHECKはtextで比較する。
ALTER TYPE authentication.audit_action ADD VALUE 'recipient-code-issue';
ALTER TYPE authentication.audit_action ADD VALUE 'recipient-code-revoke';
ALTER TYPE authentication.audit_action ADD VALUE 'recipient-code-inspect';

ALTER TABLE authentication.audit_event
  ADD COLUMN code_digest_key_version text,
  ADD COLUMN code_digest bytea,
  ADD CONSTRAINT authentication_audit_code_pair CHECK (
    (code_digest_key_version IS NULL AND code_digest IS NULL)
    OR (code_digest_key_version IS NOT NULL AND code_digest IS NOT NULL
        AND code_digest_key_version ~ '^[A-Za-z0-9._:-]+$'
        AND length(code_digest_key_version) <= 255
        AND code_digest_key_version = audit_key_version
        AND octet_length(code_digest) = 32
        AND action::text IN ('recipient-code-issue','recipient-code-revoke','recipient-code-inspect'))
  ),
  ADD CONSTRAINT authentication_audit_issued_code CHECK (
    action::text <> 'recipient-code-issue' OR decision::text <> 'allow'
    OR code_digest IS NOT NULL
  );
-- 既存行は両列NULL。直接codeId/lookup/MAC/原値は監査に持ち込まない。
