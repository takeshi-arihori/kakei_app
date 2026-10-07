# Group ManagementのMigration

`0001_group_management_storage.sql`は、ADR #55で採用した初期PostgreSQL 17保存構造の正本です。`applySqlMigrations`で番号順に適用します。Runnerは正確なSHA-256 Checksumを`app_schema_migrations`へ記録し、同じ内容の再実行をSkipします。適用済みVersionのFile内容が変更されている場合は拒否します。

`0002_group_locator_v2.sql`は、ADR #85のLocator構造とADR #73の保護されたGroup終了履歴構造を追加します。Migrationはv1 Locator Tableの行数を確認する前に`ACCESS EXCLUSIVE` Lockを取得します。v1に1行でもあればErrorとしてMigration Transaction全体をRollbackし、別のOwner Decisionによる解決を必要とします。行数が0ならv1 Tableを保持したまま、`group_operation_locator_v2`、`group_operation_locator_key_state`、`group_close_history_record`を追加します。v1の行・Table・Columnは削除しません。未使用v1 Tableの除去は、別途互換性Reviewを行った後のContract Migrationでのみ可能です。

`0003_close_intent_registry.sql`は、[ADR #102](../../../../docs/adr/close-intent-id-retention-boundary.md)に従ってCloseIntent Registryを追加します。Groupの存在中からGroup削除の1年後までCloseIntentIdの一意性を強制します。Group ManagementのRetention Transactionで行を退役させるまでは、Group FKは`ON DELETE RESTRICT`です。保護された終了履歴が存在し、Review済みBackfillがない場合、Migration 0003は拒否します。本番適用は、文書化した履歴0件の事前確認、またはReview済み復号・Backfill・重複検査が完了するまで保留します。

`0004_group_management_retention.sql`は、Task #103の保存境界を実装します。`created_at`をNullableにし、既存の退役行からその値を除去します。Registryの構造制約を変更し、生存行は`group_id`と`created_at`を持ち、退役行は不透明な`close_intent_id`と`retain_until`だけを持つようにします。operation IDをKeyとし、正のIntent Versionと不透明なCanonical Receiptを持つ`group_management_deletion_receipt_record`も追加します。この制御Recordは、Group ID、Actor、終了詳細、他ContextのData、業務Ciphertextを持ちません。`PostgresGroupManagementRetentionAdapter`は、Registry行の退役、Group Management業務行のCascade削除、Receipt Recordの追加を1つのTransactionで行います。応答喪失後の再試行では再削除せず、同じoperation／VersionのRecordを読み取ります。別のPurge Transactionは`BEGIN`後に注入されたUTCの`txNow`を1回取得し、`retain_until <= txNow`の退役行だけを削除します。

`0003_close_intent_registry.down.sql`は、Registryが空の場合に限る開発用Rollbackです。`0004_group_management_retention.down.sql`は、退役Registryまたは削除Receiptが存在する場合もRollbackを拒否します。削除状態がCommitされた後は、両Migrationを保持してForward-fixします。一意性や復旧履歴を削除しません。

Key-stateのSingletonは、現行鍵VersionがNullの状態で始まります。承認済みKey Providerが初期化するまでCommand Writerは拒否する必要があります。この行は、Commandの`FOR SHARE`とRotationの`FOR UPDATE`が共有するLock対象です。Migrationは鍵を生成・保存しません。

## Dataの境界

Schemaが保存するのは、RandomなRecord識別子、CASとAccess PolicyのVersion、Envelope Metadata、Ciphertext、96-bit Nonce、128-bit Authentication Tag、技術Timestamp、用途別Digest、Request Fingerprintだけです。Participantの本人参照、Actor Subject、Owner参照、Invitation Payload、operation結果は暗号化Record内に保持します。鍵、Token平文、復号済みPayloadをColumnやFixtureへ保存しません。

v2 Locatorは、Canonical Actor Subjectとoperation IDから作る1つのDigest、その鍵Version、Command Fingerprint Digest、RandomなGroup ID、保護されたoperation結果のFKを保存します。Actorやoperation入力は保存しません。Group終了履歴Tableは他の不変履歴と同じ保護Envelope Columnを使い、Task #95が追記専用Writerを提供します。RegistryはActor、operation ID、終了詳細、暗号化Payloadを複製せず、退役後は技術的作成時刻とGroup IDも保持しません。期限切れ行もPurgeがCommitするまで再利用を阻止します。Commit後はDBによる一意性強制が終了し、UUIDv4の実用上の一意性に従います。

## 読取Adapterと保護Payload

Task #94の`PostgresGroupReadRepository`は、読取専用の`load(groupId)`と`findOperation(actorSubject, operationId)`を実装します。Task #96の公開`PostgresGroupRepository`は、この読取AdapterとTransaction境界を組み合わせます。Group ManagementのLocator Key Portから現行・旧Locator候補を導出し、GroupのData Keyを取得する前にv2 Locatorを検索します。一致した場合だけ、FKで結ばれた保護operation結果を読みます。候補や行がない場合、鍵読取・復号を行わず`Missing`を返します。不正Metadata、認証失敗、鍵喪失、不正Payload、DB失敗は、同じ汎用読取失敗になります。このAdapterは、別の候補ベースの`GroupOperationReplayPort`を実装しません。

保護されたGroupとoperation結果のPayloadは、AES-256-GCM Envelope内のVersion付きJSONです。読取Adapterは、行のRecord ID、Random Group ID、Record種別、Schema／鍵／Aggregate VersionからCanonical AADを再構築します。保護Payloadと行を照合し、PostgreSQL行をDomain型として公開せず、Domain Groupを復元します。Codec、Canonical AAD Encoder、Locator Key Portは注入されます。このTaskは本番Key Providerを導入せず、APIにもAdapterを接続しません。Task #95は状態保存、Task #96は公開Atomic CommitとLocator／結果保存を担当します。

Task #95のState Writerは呼出し側のPostgreSQL Transactionを受け取り、現行Aggregate VersionをLock・検証します。その上で、保護された現行Participant／Invitation行とActor Access Indexを原子的に置き換え、Membership・Invitation・Group終了履歴を追記します。現行行は最新Aggregate Versionの置換可能なProjectionであり、追記専用なのは履歴Tableだけです。Writerは呼出し側のTransactionを開始・Commit・Rollbackしません。Task #96の公開Repositoryは、Locator Key-state行を`FOR SHARE`で固定し、候補operationを確認します。状態保存前に新しいCloseIntent Registry Keyを予約し、保護状態とoperation結果を保存してから、現行Locator Digestだけを`ON CONFLICT DO NOTHING`で追加します。Locator競合時は敗者のTransactionをRollbackしてから勝者を解決します。終了履歴は専用AAD種別`group-close-history`を使い、Group終了のIntentとReceiptを暗号化し、Membership／Invitation履歴との混同を防ぎます。

## RollbackとForward-fix

`0001_group_management_storage.down.sql`は、空の開発・Test Schemaでのみ使用できます。Group行が存在すると失敗します。業務Dataの適用後は、破壊的なDownやDropを実行しません。新しい番号のExpand Migrationを追加し、互換性のあるReader／WriterをDeployした上で、旧構造が参照されなくなってからContract MigrationまたはForward-fixを行います。

MigrationはCredential、Connection Pool、Timeout、本番Deploy設定を選びません。#42のTask分割後、Repositoryの`load`／`findOperation`は#94、状態・履歴のCASは#95、Locator／結果CommitとKey-state Lockは#96、固定Access Policy Lockは#97の担当です。#103はGMのGroup削除Transaction、CloseIntent Registryの退役・Purge、同一Transaction内のCanonical GM削除後Receipt Record保存を担当します。Task #118はGM所有Receipt Portと不変Record契約を定義します。#119は型付きの検証済み削除Evidence入力契約を定義し、他の2 ContextのReceipt結果と全3 Contextの鍵破棄確認を1つのPrepared Intentへ束縛します。Coordinator、他Contextの削除・Verifier、Checkpoint／Witness、Backup／Restore、本番接続は後続Gateです。`pnpm --filter @kakei/api test:e2e`はPostgreSQL上でMigrationを検証し、CIも一時的なPostgreSQL 17 Serviceで同じCommandを実行します。本番Migrationは、運用者がv1行数の事前確認、Reader／Writerの互換性、Forward-fix経路を確認してから適用します。本番削除・Trafficは、ADR #55のReceipt・鍵破棄・Checkpoint／Witness・Backup／Restore・Runbook要件を満たすまで保留します。
