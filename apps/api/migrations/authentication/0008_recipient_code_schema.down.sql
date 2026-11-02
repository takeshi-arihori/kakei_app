-- 適用済みコード/鍵世代/ENUMを破棄して旧Writerを復活させず、追加Migrationで前進修正する。
DO $$
BEGIN
  RAISE EXCEPTION 'recipient-code migration is forward-only';
END
$$;
