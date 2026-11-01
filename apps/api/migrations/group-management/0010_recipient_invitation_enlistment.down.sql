-- 未初期化・空環境だけの切り戻し。保存済みAudit/鍵制御を削除して解消しない。
DO $$
BEGIN
  -- 準備済みGM Scopeと直列化し、確認からDROPまでを単一Statement内で保護する。
  LOCK TABLE group_recipient_code_proof_key_state IN ACCESS EXCLUSIVE MODE;
  LOCK TABLE group_operation_result_record IN SHARE MODE;
  LOCK TABLE group_recipient_invitation_audit_record IN ACCESS EXCLUSIVE MODE;
  IF EXISTS (SELECT 1 FROM group_recipient_invitation_audit_record)
     OR EXISTS (SELECT 1 FROM group_recipient_code_proof_key_state WHERE current_key_version IS NOT NULL)
     OR EXISTS (SELECT 1 FROM group_operation_result_record) THEN
    RAISE EXCEPTION 'GM recipient invitation metadata requires forward-fix';
  END IF;
  DROP TABLE group_recipient_invitation_audit_record;
  DROP TABLE group_recipient_code_proof_key_state;
END
$$;
