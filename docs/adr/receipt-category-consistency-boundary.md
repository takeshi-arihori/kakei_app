# レシート・カテゴリの所有とBundle登録の原子的境界

- Status: Accepted（対象3点のみ。実Adapter完成・本番有効化を意味しない）
- Owner: takeshi-arihori
- Proposed: 2026-10-02
- Owner Accepted: 2026-10-02
- Proposal / Approval evidence: [ADR #170](https://github.com/takeshi-arihori/kakei_app/issues/170)
- Amends: ADR #24の未決だったReceipt／Categoryの具体境界
- Preserves: ADR #55／#73／#152、3 Context、Modular Monolith、State model＋不変履歴

## Context

[現行Product](../product/current-model.md)はUploader専用Draft、手動確定した明細、明細別Category、Adjustment、1 Itemの1 Bundle所属、1 Bundleから1 Expense、全対応支出登録前の月次集計除外をConfirmedとしている。[ADR #152](expense-settlement-consistency-boundary.md)はGroupExpenseとSettlementCaseのRoot・予約原子性だけを採用し、Receipt／Categoryを未決として残した。既存DirectoryやDBの配置から未決Ownerを確定しない。

Issue #170の保存前・保存後独立Planning評価はpass、findings=[]、missingEvidence=[]。これはProposalの整合と保存の評価である。その後、Ownerは2026-10-02、案Aの3点採用確認に「はい」と明示回答した。次の3点だけをAcceptedとし、他Gateをまとめて解消しない。

## Decision（Owner承認対象3点）

1. Expense RecordingがReceipt Rootを所有する。DraftからConfirmedまで同じReceiptの明細、Category参照、Adjustment、Bundle対応、版と不変履歴を保持する。Receipt確定は支出登録入力の確定であり、全Expenseを同時生成する新しいProduct Ruleを追加しない。
2. Expense Recordingが個別Category Rootを所有する。System標準とGroup専用の種別を分離し、安定ID、名称、Active／Inactive、変更履歴を保持する。Group OwnerはGroup専用だけを追加・名称変更・無効化できる。System標準をGroup削除に巻き込まない。
3. 1 Bundleと対応Expenseの登録・一意対応を、Receipt版、Expense新規性とともに共通commitで全成功または全rollbackとして確定する。複数Bundleは段階登録できるが、全Item割当と全対応Expense登録までは月次集計へ含めない。各Rootをそれぞれの公開Application境界から協調させる。

## Existing Rules and Source Boundary

ReceiptのSource OwnerはUploader。Draftの閲覧・編集・確定はUploader本人に限定し、Group OwnerというだけでDraftを公開しない。Actor本人性と同判断点のGroup資格・Closing fenceはApplication側が実Sourceから確認する。

訂正が影響するItem／Bundle／ExpenseすべてについてSource状態・版を確認し、固定Snapshotへ変更を伝播させない。Receipt全体Adjustmentは全影響範囲を対象とする。編集Fieldごとの影響範囲、他Itemが精算中の編集許可、Bundle操作Actor、確定後画像閲覧は個別契約へ残す。

Group専用Category、Group限定Suggestion、Groupの明細・履歴は対象Group配下Dataとして削除する。共有System標準定義の寿命を、標準を参照していたGroupの履歴の寿命と区別する。System管理API・管理者本人性を今回採用しない。

## Alternatives

| 比較 | 案A（採用） | 案B |
| --- | --- | --- |
| Receipt | ERのReceipt Root | 同じ |
| Category | ERの個別Root、標準／Group専用を分離 | GMが定義を所有し、ERは公開Portで参照 |
| 利点 | 分類対象・候補・定義の変更理由が近い。GMはMember／Role／終了を維持 | Groupの共有設定をGMへ集められる |
| 負担 | 現在Ownerの照会とGroup終了連携が必要 | 分類・確定ごとのContext間版照合と依存が増える |

BundleとExpenseを順に別commitで保存する代案は、途中失敗による対応欠落を残す。共通commitの具体実装は別契約・Testで検証する。別Processへの分離・補償方式・全面Event Sourcingは採用しない。

## Consequences

Receipt内の整合と分類定義の変化をERへ凝集できる。一方、Root履歴量・競合・コピーCost、複数Root commit、Group削除の所有境界には実装・運用上の検証が必要となる。immutableな代替Rootを生成できても、保存先着・実CAS・実認可・実rollbackの証拠にはならない。

## Implementation and Remaining Gates

採用後も[Delivery Workflow](../engineering/delivery-workflow.md)に従って個別TaskをReady評価する。最初の候補はGroup専用Categoryの追加・名称変更・無効化・不変履歴という純Domain成果。その後にReceipt Adjustment整数配賦、Draft手動確定、Bundle対応を分ける。公開API・保存・本人性・Retentionはそれぞれ別の契約とSecurity／運用Gateを満たす。[Inventory](../product/mvp-web-expense-receipt-category-inventory.md)と[設計Gate](../product/design-gates.md)へTraceし、[ADR #55](snapshot-revision-security-and-retention.md)／[ADR #73](group-close-consistency-and-retention-boundary.md)の保護・保持を維持する。

本番認証Provider、OCR製品、画像Storage、名称重複／正規化、公開GraphQL／Error、具体Port署名・lock順・operation再送、保護Record kind・Schema・Key・Audit・Backup・Deployment、実Retention・Projectionはこの承認で確定しない。Category再有効化・個人専用分類・Suggestion手動CRUD・全利用者学習を追加しない。

文書同期対象はADR一覧、current-modelのArchitecture注記、design-gates、domain-designのKnowledge State、shared-expense-design-boundaries、Expense／Receipt／Category InventoryのOwner Gateである。Confirmed業務Rule・画面分類・Routeの採用状態は変更しない。

## Review Trigger / Rollback

Receipt Rootの競合・履歴Cost、Category責務の分離、BundleとExpenseの原子性、Group終了削除との協調が境界を維持できない場合、新しいADRで見直す。Accepted後のDecision変更はOwnerの明示承認で行い、過去の証跡を消さない。未接続Codeはrevert可能だが、保存接続後の復旧は別TaskのMigration／Runbookで定める。
