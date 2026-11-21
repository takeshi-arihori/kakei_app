-- ADR group-actor-membership-index（#306）。自分のGroup一覧の候補列挙だけに使う
-- Actor単位のGroup索引。Actor subjectは暗号化Payload内にあり、既存Group行から
-- SQLだけでは索引を作れない。既存Group行があれば中断し、backfillは別のOwner
-- Decisionで扱う。SHARE ModeのLockで、行数確認からDDLまでの間のGroup作成を止める。
LOCK TABLE group_aggregate_record IN SHARE MODE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM group_aggregate_record LIMIT 1) THEN
    RAISE EXCEPTION 'existing group rows require an owner decision before adding the actor membership index';
  END IF;
END
$$;

-- 平文はContext単位の用途鍵によるActor digest、その鍵版、Random Group ID、
-- 技術Timestampだけ。Actor subject、Role、状態、業務時刻は保存しない。
CREATE TABLE group_actor_membership_index (
  actor_digest bytea NOT NULL CHECK (octet_length(actor_digest) > 0),
  digest_key_version text NOT NULL CHECK (digest_key_version ~ '^[A-Za-z0-9._:-]+$'),
  group_id uuid NOT NULL REFERENCES group_aggregate_record(group_id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (actor_digest, digest_key_version, group_id)
);

CREATE INDEX group_actor_membership_index_group_idx
  ON group_actor_membership_index (group_id);
