# CloseIntentIdの保持期間と一意性境界

- Status: Accepted
- Accepted: 2026-09-23
- Decision Owner: Project Owner（takeshi-arihori）
- Decision record: [GitHub ADR Issue #102](https://github.com/takeshi-arihori/kakei_app/issues/102)
- Amends: [ADR #55: Snapshot Revisionの保護と保持境界](snapshot-revision-security-and-retention.md)、[ADR #73: Group終了の整合性と保持期限境界](group-close-consistency-and-retention-boundary.md)
- Related implementation: [Task #96](https://github.com/takeshi-arihori/kakei_app/issues/96)、[Task #103](https://github.com/takeshi-arihori/kakei_app/issues/103)

## Context

ADR #73はCloseIntentIdの全Group一意性を定め、ADR #55はGroup削除時のRetention、削除証拠、Checkpoint／Witness、Backup Restore Gateを定める。Protected close historyは暗号化されるため、暗号化履歴自体に重複検索可能な一意制約を置けない。Groupの状態更新前に重複を拒否するには、CloseIntentIdだけを保持するPostgreSQL registryが必要になる。

一意性registryを永久保持すればDB上の重複拒否を期限なしで続けられるが、識別子を無期限に保持し、その完全性・復旧可能性も無期限で担保する必要がある。Project OwnerはこのTrade-offを確認し、Group削除後1年の保持を選択した。

## Decision

1. 信頼されたGroup Management境界がCSPRNGでcanonical lowercase UUIDv4のCloseIntentIdを生成する。任意の値を呼出側から指定させず、Domain value objectもUUIDv4形式を検証する。
2. PostgreSQLはGroup存続中、およびGroupの`deletedAt`から1年間、CloseIntentIdの重複を拒否する。期限を過ぎてもcleanupがcommitするまではregistry行を残し、重複を拒否する。
3. Group存続中のregistry行は`close_intent_id`を`group_id`へ束縛する。Group Managementの削除Transactionで`group_id`をNULL化し、`retain_until`を設定してから、同Context所有の業務Dataを削除する。retired rowに残すのはopaque CloseIntent UUIDと期限Metadataだけとし、Group ID、Actor、operation ID、close詳細、PII、暗号化Payloadは残さない。
4. `retain_until`は`deletedAt`をAsia/Tokyoへ変換して1暦年を加え、2月29日は2月28日へclampした時刻をUTCで保存する。これはADR #73の暦年規則に従う。
5. CleanupはTransaction開始時に一度だけ取得したUTC `txNow`を使い、`retain_until <= txNow`の行を対象とする。DB上の強制一意性は期限行の削除がcommitした時点で終了する。以後はCSPRNG UUIDv4の実用上一意性に依存し、絶対的一意性は主張しない。
6. registry操作自体はGroup削除を認可しない。既存Retention CoordinatorがADR #55の必要な全Context deletion receiptと鍵破棄確認を検証した後にのみ、Group Managementの削除を実行できる。他ContextのData Ownerは各自のDataと削除Receiptに引き続き責任を持つ。
7. Productionでregistry writeの完全性を証明できる復旧手順が有効になるまで、復元DBへwrite trafficを流さない。authoritative PostgreSQL stateとacknowledged registry commitまでを含む連続したdurable WALを証明・復元できない場合はwriteを停止したままとする。

## Implementation ownership

- #96はDomain UUIDv4検証、registryの原子的登録、Group状態更新前の重複拒否を担当する。Retention接続前に物理Group削除でregistryが消えないようGroup FKは`ON DELETE RESTRICT`とする。
- #103はGroup Management内のGroup root／所有domain data削除、registry退役・期限切れcleanup、およびGM canonical post-deletion Receipt recordの同一削除transactionへの保存を担当する。これはOwner Accepted ADR #115が本ADRのreceipt orderをAmendしたことによる実装scope同期である。Task #118はGM Receipt Port／immutable record contractを、#119はER／Settlementのverified Receipt outcomeとGMを含む3 Contextのkey-destruction confirmation outcomeを同一Prepared intentへ束縛するtyped evidence input contractを定義する。#103は当該検証済み境界の後にのみ呼び出し可能であり、他Context削除、Receipt verification・signing／canonicalization、Retention Coordinator実装、Checkpoint／Witness、Backup／Restore、Runbook、本番wiringは対象外。
- v3 Migrationはprotected close-historyに既存行がある場合、Backfillなしに適用せずfail-closedにrollbackする。Production適用は対象Historyが空というpreflight、または別途レビュー済みの復号／backfillと重複検査が揃うまでBlockedとする。
- #96は本ADRと関連文書のRepository同期が完了し、個別Ready Gateを満たすまでBlockedとする。

## Alternatives

| 案 | 判断 | 理由 |
| --- | --- | --- |
| UUID registryを永久保持 | 不採用 | 識別子を無期限に保持し、復旧完全性も無期限に要求する |
| UUIDv4だけを生成しregistryを持たない | 不採用 | Group存続中と削除後1年のDB重複拒否ができない |
| Group存続中と削除後1年のregistry | 採用 | Group削除後の保持を有限にし、期限後cleanup commitを一意性境界にできる |

## Consequences

DBがCloseIntentId重複を強制拒否する期間は、Group存続中から削除後1年のregistry cleanup commitまでに限定される。cleanup後は生成UUIDの確率的な一意性となり、DBの歴史全体にわたる一意性は保証しない。registry行をGroup業務Dataから分離し、保持終了後に識別子と期限Metadataを削除できる。一方、削除Transaction、期限計算、cleanupとRestoreの運用Gateが必要である。

このDecisionはADR #55の全Context削除証拠、Retention Coordinator、Checkpoint／Witness、Backup Restore Gateを緩和しない。また、ADR #73の信頼境界内でのCSPRNG UUIDv4生成と重複拒否の要件を保ちつつ、DBが全Group履歴にわたって絶対的一意性を強制する期間をGroup存続中と削除後1年のcleanup commitまでに限定する。cleanup後のIDは実用上一意だが、DBを使った歴史全体の重複検査は保証しない。

## Review trigger

CloseIntentIdを呼出側指定にする、UUID生成方式を変更する、保持期間／Timezone規則を変更する、registryの保存項目を増やす、Context間削除Protocolを変更する、registry commitを含む復旧完全性を証明できなくなる場合は再審査する。Rollbackは新ADRで行い、Group削除と保持のfenceを維持する。
