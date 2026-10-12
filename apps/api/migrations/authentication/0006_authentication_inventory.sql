-- Accepted A2 Inventoryに一致させる追加Migration。
-- 適用済みversion 5のChecksumを変えず、未承認の日時だけを除去する。
ALTER TABLE authentication.google_identity DROP COLUMN created_at_ms;
ALTER TABLE authentication.identity_alias DROP COLUMN created_at_ms;
