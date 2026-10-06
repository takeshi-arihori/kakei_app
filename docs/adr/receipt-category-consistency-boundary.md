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

[Task #173](https://github.com/takeshi-arihori/kakei_app/issues/173)の[Category lifecycle契約](../domain/category-lifecycle-contract.md)は、Group専用の追加・名称変更・無効化・不変履歴とSystem定義読取factsを純Domainへ反映する。System管理履歴、実Source認可、名前Validation、Receiptとの同時点照合、保存・保持・公開操作の完成を意味せず、上記Gateを維持する。Decisionの変更ではなく実装Traceである。

[Task #175](https://github.com/takeshi-arihori/kakei_app/issues/175)の[Receipt Adjustment整数配賦契約](../domain/receipt-adjustment-allocation-contract.md)は、種別／符号の検証、Item単位とReceipt全体の整数配賦、最終額Invariantを純Domainへ反映する。Draft確認、宣言Receipt合計との一致、公開認可、保存、Bundle／Expense登録は実装せず、G1／G2を維持する。これは採用済みDecisionのTraceであり、ADRの境界を拡張しない。

[Task #177](https://github.com/takeshi-arihori/kakei_app/issues/177)の[Receipt Draft手動確定契約](../domain/receipt-manual-confirmation-contract.md)は、同一Receipt RootのDraft→Confirmed純Domain遷移、Uploaderが明示確認したItem／Adjustment facts、必須購入日、#175配賦後合計と宣言Receipt合計の一致、不変version履歴を実装する。実本人性・Group資格／fence、Category同時点確認、Persistence／CAS、公開API、Bundle／Expense登録・月次Projectionを完了済みとしない。これはAccepted境界のTraceであり、新しいProduct Ruleを追加しない。

本番認証Provider、OCR製品、画像Storage、名称重複／正規化、公開GraphQL／Error、具体Port署名・lock順・operation再送、保護Record kind・Schema・Key・Audit・Backup・Deployment、実Retention・Projectionはこの承認で確定しない。Category再有効化・個人専用分類・Suggestion手動CRUD・全利用者学習を追加しない。

文書同期対象はADR一覧、current-modelのArchitecture注記、design-gates、domain-designのKnowledge State、shared-expense-design-boundaries、Expense／Receipt／Category InventoryのOwner Gateである。Confirmed業務Rule・画面分類・Routeの採用状態は変更しない。

## Review Trigger / Rollback

Receipt Rootの競合・履歴Cost、Category責務の分離、BundleとExpenseの原子性、Group終了削除との協調が境界を維持できない場合、新しいADRで見直す。Accepted後のDecision変更はOwnerの明示承認で行い、過去の証跡を消さない。未接続Codeはrevert可能だが、保存接続後の復旧は別TaskのMigration／Runbookで定める。


## Forward trace: Bundle編集とSnapshot固定

[ADR #179](receipt-bundle-edit-and-snapshot-lock.md)はOwnerの2026-10-02の統合本文承認により、ここで個別契約へ残したBundle操作Actorと所属／payer／割合の編集期間を追補する。Uploader専用、Snapshot初選択後の永久固定、既存Expense ID・登録Participant facts・履歴の維持、Rejected後のItem金額／Adjustment／Category訂正維持を採用する。本ADRの承認対象3点と初回Pair共通commit、段階登録・全対応登録前の月次非包含は保持し、過去のAccepted本文・承認証跡は変更しない。実保存・競合・本人性・Projection等の完成は主張しない。


## Bundle初回登録の純Domain trace（2026-10-03）

[Task #182](https://github.com/takeshi-arihori/kakei_app/issues/182)の[初回登録契約](../domain/receipt-bundle-registration-contract.md)とDomain Testは、Confirmed Itemの非空・一意割当、調整後合計と初回Expense対応、Uploader／版確認、不変履歴、段階登録と全割当完了の内部事実を扱う。実Group所属／本人性、共通atomic commit、durable再送結果、月次Projection、Bundle編集とSnapshot lock、Rejected後訂正の実装はこのSliceに含めない。Accepted Decisionを変更せず、公開API／画面Readyを引き上げない。

## Bundle初Snapshot選択と永久編集Policyの純Domain trace（2026-10-03）

[Task #184](https://github.com/takeshi-arihori/kakei_app/issues/184)の[初選択・永久編集lock契約](../domain/receipt-bundle-snapshot-lock-contract.md)は、Receiptが初回Pairを維持してSource初選択の参照・Actor・UTCを不変値として記録し、以後のItem所属／payer／割合の編集可否を永久に拒否する内部Policyを扱う。Rejected／Withdrawn／Cancelledでも解除しない。Sourceの選択ActorにUploader一致を要求せず、編集PolicyだけをUploader専用とする。実Sourceの初選択確認・選択資格、実編集Command、保存atomicity／CAS／durable lock／再送、本人性／Group fence、Rejected後Item訂正、Projection／API／画面は後続Gateのまま。Accepted Decisionと公開Ready状態を変更しない。

## Bundle payer／Split変更の純Domain trace（2026-10-03）

[Task #186](https://github.com/takeshi-arihori/kakei_app/issues/186)の[payer／Split変更契約](../domain/receipt-bundle-split-change-contract.md)は、Receiptの共通編集Policyを通過した内部factsと対応Expenseの値整合を確認し、同ID・同登録Participant集合／joinOrder・額・購入日・Source・初回事実を維持してpayer／割合／整数負担を変更する。不変履歴とamount訂正履歴を相互に保持し、初選択後はfacts取得を永久拒否する。DTOは認可capabilityではなく、実Source currentness・初選択と編集の原子裁定・Receipt読取版fence＋Expense CAS、本人性／Group fence、durable lock／再送、実Item移動／Rejected後Item訂正、保存／Projection／API／画面は後続Gate。Accepted Decisionと公開Ready状態を変更しない。

## Bundle Item移動の純Domain trace（2026-10-03）

[Task #188](https://github.com/takeshi-arihori/kakei_app/issues/188)の[Item移動・Expense額反映契約](../domain/receipt-bundle-item-movement-contract.md)は、両Bundleの共通永久Policy・一意所属・非空を守り、Item調整値と同Pairを維持して所属を移す。Callerが前後Receipt factsを両Expenseへ束縛し、現在payer／割合・登録集合／joinOrder・初回事実・既存履歴を維持して額・整数負担を再計算する。0円移動でも両履歴を追加する。DTOは認可capabilityではなく、実Source／本人性・Group fence、初選択との同時裁定、Receiptと両Expenseの共通atomic commit／CAS／durable再送、Rejected後Item訂正、保護保存／Projection／API／画面は後続Gate。Accepted Decisionと公開Readyを変更しない。

## 登録済みItem Category訂正の純Domain trace（2026-10-05）

[Task #190](https://github.com/takeshi-arihori/kakei_app/issues/190)の[Category訂正契約](../domain/receipt-item-category-correction-contract.md)は、Uploaderまたは現在Group Ownerが登録済みConfirmed Item一件のCategoryだけを訂正し、同ID・金融値・Bundle対応・初選択・旧Snapshot・全履歴を保持する。対象Itemに対応するExpenseが未選択なら編集可能、初選択後は同判断点の関連CaseがRejectedの場合だけ許可する。他Bundleの状態を対象へ流用せず、所属／payer／割合の永久固定を解除しない。同Categoryでも条件を検証したsameRoot no-op。実Category Active／Group適合・Source現在版／本人性・Closing、訂正と初選択／再申請の保存裁定・CAS／再送、金額／Adjustment訂正、月次Projection／公開API／画面は後続Gate。Accepted Decisionと公開Readyを変更しない。


## 登録済みItem原額訂正とExpense反映の純Domain trace（2026-10-06）

[Task #192](https://github.com/takeshi-arihori/kakei_app/issues/192)の[原額訂正・財務反映契約](../domain/receipt-item-amount-correction-contract.md)は、Uploaderまたは現在Group Ownerが登録済みItem一件の原額を理由付き訂正し、既存Adjustment再配賦で影響する全Bundleの未選択／Rejected条件を検証する。各既存Expense ID・登録集合／payer／割合・初回事実・全履歴と旧精算Revisionを維持して額・負担へ反映する。Bundle永久lockを解除しない。Adjustment自体の編集、Draft／一般編集、実Source・認可／Group fence、全影響Root共通保存／CAS／再送、保護保存／Projection／API／画面は後続Gate。純Domain成功を実保存や公開Readyの証拠にしない。

## 既存Adjustment金額訂正の実装trace（2026-10-06）

[Task #194](https://github.com/takeshi-arihori/kakei_app/issues/194)の[Adjustment金額訂正契約](../domain/receipt-adjustment-amount-correction-contract.md)は、既存一件の額訂正と全再配賦、影響する登録Bundleの未選択／Rejected条件、同Expense IDの額・負担・不変履歴を純Domainで扱う。原額・Category・Pair／初選択永久lock・現在payer／割合・旧精算Snapshot・全既存履歴を維持する。既存の原額／割合／Item移動／手入力訂正も新Adjustment履歴を保持する。追加／削除・種別／適用先変更、Draft／一般編集、実Source・認可／Group fence・原子的保存／再送／保護保存、Projection／API／画面は後続Gate。Accepted本文・承認履歴・公開Ready状態を変更しない。
