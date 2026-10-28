# 認証Schema Migration

認証RecordはPostgreSQLの`authentication` Schemaが所有する。`0005_authentication_schema.sql`は既存APIの番号付き`app_schema_migrations`台帳を使い、Group Managementの4件に続くversion 5として適用する。一度適用したSQLのChecksumは不変とし、その後の変更は新しい番号のMigrationで追加する。

保存項目は[承認済みA2 Inventory](../../../../docs/security/authentication-protected-storage.md)に限定し、`actor`、`google_identity`、`identity_alias`、`login_attempt`、`session_record`、`audit_event`、`key_state`／`key_generation`、`deletion_intent`へ写像する。version 6適用後のIdentityとAliasには作成日時を保持しない。外部キーは認証Schema内で閉じ、Groupへの参照や業務DataへCascadeする関係を作らない。

Migrationはepochなし・`uninitialized`の`key_state`を1行だけ作る。`key_generation`の初期値は空で、鍵世代・検索・書込のMetadataだけを保存し、鍵Materialを生成・保存・導出しない。別途承認するProviderが鍵Stateを初期化するまでWriterは利用不可とする。保存時刻はJavaScriptのsafe integer範囲内の非負UTC Unix millisecondsとする。

制約によりID・版、状態と終端時刻の整合、Attemptの5分期限、Sessionのidle／absolute境界、Envelope／Digest長、ActorごとのGoogle Identity、Identityと鍵世代ごとのAlias、鍵世代ごとのCookie Digestの一意性を強制する。成功Auditの一意制約は同じ鍵世代のAttempt仮名に対する重複を拒否する。世代をまたぐ一回消費は後続StoreのAttempt CASが保証する。Auditは固定Enumと用途別仮名だけを許し、直接識別子、Provider Token、Network Address、診断自由文を保存しない。

`0005_authentication_schema.down.sql`は台帳がversion 5までの空・未使用分離DBだけを対象とする。認証Dataまたは初期状態以外の鍵Stateがある場合は、Objectを削除する前に拒否する。削除対象は認証Schemaと台帳のversion 5だけで、Group Managementを削除・Cascadeしない。version 6以降でこのDownを実行しない。

結合Testは末尾が`_test`のDBだけで実行する。同じ固定Schema名を使うSuiteはSession Advisory Lockで直列化し、開始時に既存の認証Schemaがあれば後処理の削除権限を取得せず拒否する。検証用DBには認証Writerを接続しない。後処理はSuiteが存在しないことを確認した認証Schemaと、実行ごとのランダム名のGroup検証Schemaだけを削除する。

## version 6による保存項目の是正

PR #221で統合したversion 5は不変とし、`0006_authentication_inventory.sql`を追加する。Identity／Aliasの未承認`created_at_ms`だけを削除し、ID、所有関係、版、Digest、Envelope、鍵状態、既存Group業務行には変更を加えない。空DBでは既存の番号順に1〜6を適用し、version 5適用済みDBでは6だけを追加する。Migration RunnerのTransactionで両列の削除と台帳追記を共通Commitし、途中故障では全てRollbackする。再実行は保存済みChecksumでskipし、不一致なら拒否する。

削除した日時は復元できない。`0006_authentication_inventory.down.sql`は空DBでも明示拒否し、未承認列の再追加を行わない。適用後の変更は新しい番号のForward-fixで届ける。適用時は認証Writerを閉じ、旧日時列を参照するCodeがないことを確認してからMigrationを実行する。検証用のSchema破棄はSuiteが所有する分離環境に限定する。

## version 7: HTTP専用の共有Rate予算

`0007_authentication_http_rate.sql`は[承認済みHTTP契約](../../../../docs/security/authentication-http-boundary.md)に従い、独立Schema `authentication_http`へ`rate_policy`と`rate_window`を追加する。既存5/6のSQL・Checksum・認証RecordとGroup Schemaを変更しない。共通Migration RunnerのTransactionと台帳で適用し、既存DBでは7だけを追加する。

`rate_policy`はstate_id=1の単一行、policy_version=1、公開deployment_namespace/key_version、32-byte鍵照合値を持つ。鍵MaterialやRaw IPを保存しない。初期化は明示操作で、異なる鍵/Namespace/Policyを無条件upsertして既存予算を消さない。

`rate_window`はoperation（attempt/login/session/logout）、kind（global/peer）、32-byte専用HMAC、分境界window_start_ms、count（1〜601）、expires_at_msだけを保持する。PKはoperation/kind/digest/window。Windowのsafe範囲・60秒期限・Digest長をCHECKし、expiry Indexを小Batch清掃に使う。HMACはNamespace/操作/種別/接続Peerまたはglobal固定label/Windowへ束縛する短期仮名である。認証DataのBackup/Restoreや削除Ledgerの正本にしない。

期限到達後の行は予算に再利用せず、24h以内に削除する。清掃能力と固定通知は[開発Runbook](../../../../docs/operations/authentication-local-development.md)を参照する。鍵喪失・commit結果不明・不一致は予約を許可せず、プロセス内Mapへfallbackしない。本番の鍵保管・Rotation・DB保護・Failover時の巻戻し防止は未有効の別Gate。

version 7のDownは明示拒否する。使用済み予算を削除して上限を復活させず、必要な変更は追加Migrationで前進修正する。試験Schema破棄は開始時に既存Schema不在を確認したSuite所有環境だけに限定する。

## version 8: 招待コードの最小Inventoryと鍵制御Metadata（#237）

`0008_recipient_code_schema.sql`は[Accepted詳細設計R4](../../../../docs/security/invitation-code-lifecycle.md#r4-保存inventory鍵原子性)と[#236の内部Record](../../src/shared/application/authentication/recipient-code-record.ts)を次へ写像する。共有認証技術が所有し、Group/InvitationへのFK・Cascade・原コード・Profile・Session原値・暗号化Payload/Nonceは追加しない。

| 論理field | 物理列 / 型 | 制約・意味 |
| --- | --- | --- |
| codeId | code_id / uuid | PK、UUIDv4。原コードから独立し、DBで乱数生成しない |
| recipientActorId | recipient_actor_id / uuid | NOT NULL、UUIDv4、authentication.actorだけへのFK、ON DELETE RESTRICT |
| recordVersion | record_version / positive_safe_integer | NOT NULL、1〜9007199254740991 |
| epoch | epoch / uuid | NOT NULL、UUIDv4。現在の外部epochとの一致検証はAdapterが担当 |
| createdAt / expiresAt | created_at_ms / expires_at_ms、utc_milliseconds | NOT NULL、非負safe integer、差は600000ms固定 |
| status | state / recipient_code_state | NOT NULL、issued/consumed/replaced/revoked。expiredは時刻由来で保存しない |
| terminalAt | terminal_at_ms / utc_milliseconds | 唯一のnullable列。IssuedならNULL、終端なら作成以降。期限後の終端化も許可する |
| lookupKeyVersion / lookupDigest | lookup_key_version / text、lookup_digest / bytea | NOT NULL、鍵世代は許可ASCIIの1〜255文字、Digestは32-byte、世代とDigestの組をUnique |
| macKeyVersion / mac | mac_key_version / text、state_mac / bytea | NOT NULL、鍵世代は許可ASCIIの1〜255文字、MACは32-byte。真偽検証は#238以降 |

全列に初期値を持たせず、Migration完了時の新Tableは空。`authentication_recipient_code_issued_actor_idx`は`state='issued'`だけをpredicateとしてActorごとにUniqueにする。期限超過Issuedも再発行のTransactionで先に終端化し、`now()`をpredicateへ持ち込まない。終端行を含むActor参照索引と、`LEAST(expires_at_ms,COALESCE(terminal_at_ms,expires_at_ms))`の清掃索引を追加する。Actor無効時点との最早照合は#244の保守処理が担当する。

既存`key_purpose`に`recipient-code-lookup`と`recipient-code-state-mac`の2用途だけを追加する。前者は`auth-recipient-code-lookup/v1`、後者はRecord別の`auth-recipient-code-state/v1`の世代制御で、鍵Materialではない。`key_state`のstatus/generation_version/epoch、旧`key_generation`行は更新しない。コード用世代も初期化せず、MAC Materialは将来ProviderがcodeIdごとに独立保持する。非Cookie用途として`key_generation.epoch`はNULLの既存制約を継承し、現在epochは`key_state`とRecordの照合で扱う。GM再送proofの制御は#242、コードAuditの物理保存・用途拡張は#240以降で扱う。

### 適用・互換性・停止条件

1. 適用前に対象DBの所有・PG17・台帳/Checksumと認証Writer/保守の停止を確認する。適用済み5/6/7のSQLを変更せず、7までのDBには8だけ、空DBには1〜8を番号順で渡す。
2. 既存Runnerの単一TransactionでENUM追加・Table/索引・台帳追記を共通commitする。SQL内にTransaction制御を重複しない。新しい鍵用途ENUMの値は追加Transaction内で使用せず、世代行を作らない。故障時はENUM/Table/台帳も全rollbackする。再実行はChecksum一致ならskip、不一致なら停止する。
3. 適用後に旧行と旧Checksum不変、recipient_codeが空、旧key_state/世代不変を確認する。通常main・専用DevのMigration一覧は変更しない。既存認証は新用途の行がない間だけ従来どおりで、新コード機能は未接続のまま。
4. 新用途のMetadataを入れると旧通常Writer・清掃・Restore readerは、非active世代でも未知用途としてfail closedする。Readerの許可集合をこのTaskで広げたり、不明用途をskipしたりしない。#239〜#245と公開契約/実装・既存Production Gate完了前にコードWriter・鍵初期化を有効化しない。

SchemaだけでMAC真正性、Actor本人性、現在epoch、同一接続の一回消費/GM原子性、24時間清掃、Restore失効を保証しない。これらが未実装の間に新しいコード行・鍵世代が見つかった場合は活性化を止め、隔離して後続保守の対応を確認する。

`0008_recipient_code_schema.down.sql`は空DBでも拒否する。実DataのDropやENUM削除、台帳巻戻しで旧Writerを復活させず、Writer停止と新しい番号のForward-fixを使う。

### 実DB検証と文書Trace

`test/recipient-code-schema-migration.integration.spec.ts`で、空DB/7からの追加、旧認証/GM行・稼働鍵Metadata/Checksum不変、再実行・Checksum拒否、故障時DDL/ENUM/台帳rollback、12列/nullability/初期値なし、FK RESTRICT、一Actor一Issued、世代別Digest/ID一意性、状態/時刻/版/byte長・UUIDv4・鍵世代制約、清掃索引、旧Reader3種の未知用途拒否、Down拒否を実PG17で検証する。

検証は末尾`_test`・PG17を確認してから共通Session Advisory Lockを取得し、既存のauthentication/authentication_http Schemaがあれば所有権を得ず拒否する。自分が不在確認後に作成したSchemaと、実行ごとのランダム名のGM検証Schemaだけを削除する。認証WriterはTest DBへ接続しない。既存の正式ER図はGM locatorの関係を対象とするため変更せず、このInventory表と実Schema検証を招待コードの保存Traceとする。
