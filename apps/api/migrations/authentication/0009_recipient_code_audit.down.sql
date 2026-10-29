-- Audit/Enumを破棄して過去Writerへ戻さず、追加Migrationで前進修正する。
DO $$
BEGIN
  RAISE EXCEPTION 'recipient-code audit migration is forward-only';
END
$$;
