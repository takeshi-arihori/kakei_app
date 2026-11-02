-- Accepted R4: コード消費とGM成功を同じcommitの用途別監査へ写像する。
ALTER TYPE authentication.audit_action ADD VALUE 'recipient-code-consume';

ALTER TABLE authentication.audit_event
  DROP CONSTRAINT authentication_audit_code_pair,
  DROP CONSTRAINT authentication_audit_issued_code,
  ADD CONSTRAINT authentication_audit_code_pair CHECK (
    (code_digest_key_version IS NULL AND code_digest IS NULL)
    OR (code_digest_key_version IS NOT NULL AND code_digest IS NOT NULL
        AND code_digest_key_version ~ '^[A-Za-z0-9._:-]+$'
        AND length(code_digest_key_version) <= 255
        AND code_digest_key_version = audit_key_version
        AND octet_length(code_digest) = 32
        AND action::text IN ('recipient-code-issue','recipient-code-revoke','recipient-code-inspect','recipient-code-consume'))
  ),
  ADD CONSTRAINT authentication_audit_successful_code CHECK (
    action::text NOT IN ('recipient-code-issue','recipient-code-consume')
    OR decision::text <> 'allow' OR code_digest IS NOT NULL
  );
-- 既存行・保持期限・Ownerは維持。新Enumを同Transactionでcastせずtextで比較する。
