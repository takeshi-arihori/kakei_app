-- 消費の監査履歴を破棄せず、追加Migrationによるforward-fixを行う。
DO $$
BEGIN
  RAISE EXCEPTION 'recipient-code consumption audit migration is forward-only';
END
$$;
