-- 未承認の列と破棄済み日時は復活させず、追加Migrationで前進修正する。
DO $$
BEGIN
  RAISE EXCEPTION 'authentication inventory migration is forward-only';
END
$$;
