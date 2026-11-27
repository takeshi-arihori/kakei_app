-- 表が空の開発・Test環境だけで使う。索引行が1行でもあれば拒否し、Data適用後は
-- Forward-fixする。確認からDROPまでの間の書込をLockで止める。
LOCK TABLE group_actor_membership_index IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM group_actor_membership_index LIMIT 1) THEN
    RAISE EXCEPTION 'actor membership index down migration requires an empty index';
  END IF;
END
$$;

DROP TABLE group_actor_membership_index;

DELETE FROM app_schema_migrations WHERE version = 12;
