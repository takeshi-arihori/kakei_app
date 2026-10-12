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
