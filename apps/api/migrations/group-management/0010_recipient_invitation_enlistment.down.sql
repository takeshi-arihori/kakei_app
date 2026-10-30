-- 未初期化・空環境だけの切り戻し。保存済みAudit/鍵制御を削除して解消しない。
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM group_recipient_invitation_audit_record)
     OR EXISTS (SELECT 1 FROM group_recipient_code_proof_key_state WHERE current_key_version IS NOT NULL) THEN
    RAISE EXCEPTION 'GM recipient invitation metadata requires forward-fix';
  END IF;
END
$$;
DROP TABLE group_recipient_invitation_audit_record;
DROP TABLE group_recipient_code_proof_key_state;
