-- 使用後の共有予算を空に戻さず、追加Migrationで前進修正する。
DO $$
BEGIN
  RAISE EXCEPTION 'authentication HTTP rate migration is forward-only';
END
$$;
