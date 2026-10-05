# 登録済みReceipt ItemのCategory訂正契約

[Task #190](https://github.com/takeshi-arihori/kakei_app/issues/190)は[現行モデル](../product/current-model.md)の確定後明細訂正と[ADR #170](../adr/receipt-category-consistency-boundary.md)／[ADR #179](../adr/receipt-bundle-edit-and-snapshot-lock.md)を、Receipt Rootの純Domain操作へ反映する。対象は登録済みBundleに属するConfirmed Item一件のCategoryだけ。未割当Itemの一般編集、金額・Adjustment・購入日・品名訂正は別操作であり、この入口の未割当拒否をProduct全体の編集禁止へ一般化しない。

## 所有・内部操作・Knowledge State

`Receipt.correctItemCategory`はReceiptの現在期待版、Actor、現在Group Owner、Group、有限操作Date、Item／新Category参照、nullable Case期待版／factsを受け取る。Receiptが自身のItem・Bundle対応・初選択・版・不変履歴を守り、CategoryIdを既存VOで検証する。Category定義のLifecycleやSettlement Caseを所有しない。新Aggregate／Service／Port、他ContextのEntity／Repository／型依存、公開API／保存Schemaを追加しない。

**Accepted**: 確定明細のUploaderまたは現在Group Ownerによる訂正、関連ExpenseのSnapshot選択前またはRejected時だけの編集、同ID・不変履歴、旧Snapshot不変、Bundle所属・payer・割合の永久固定。CategoryはItem単位なので、この操作は対象Itemに対応するBundle／Expenseだけで状態を判断する。他BundleがAwaitingApproval／PaymentActive／Archivedでも未選択の対象を止めず、他BundleのRejectedを対象へ流用して許可しない。金額／Adjustment訂正の広い影響範囲を、このCategory契約から確定しない。

**内部契約**: 対象Bundle未初選択なら`caseFact`と`expectedCaseVersion`は両方明示null。初選択済みなら対象Expense／Groupに一致するCase facts、canonical lowercase UUIDのCase ID、正safe Case版と期待版一致、`lifecycle === 'Rejected'`を必須とする。Approved／AwaitingApproval／PaymentActive／CancellationPending／Archived／Withdrawn／Cancelled／未知値を拒否する。Item IDとCategory IDはopaque nonblank。safe整数版・有限UTCは内部技術制約で、Productの上限・時刻順序を新設しない。訂正理由を新たに必須化しない。

**Assumption／Application PRE**: Callerは本人性、現在Owner・同Group資格・Active／Closing fence、新Category実在／Active／Group適合、実Receipt現在版・初選択真偽と、対象Expenseが実際に属する現在Caseの状態／版を同判断点Sourceへ束縛する。Client申告を直接factsへ写像しない。初選択のCase参照は現在の関連Case同一性を証明しないため、現在Case IDとの固定一致は要求しない。別Caseへ解放後の状態を含め、実関連と訂正可否のSource確認はCaller責務。Rootの成功・参照一致だけで本番認可、Source currentness、CAS／先着を主張しない。

## PRE／POST／INV／FAILとTest Trace

| ID | 契約／責務 | Verification |
| --- | --- | --- |
| IC-P1 | Confirmed・現在Receipt版、nonblank Actor／現在Owner／Group／Item、新Category VO、有限日時、対象Itemの登録BundleとGroup一致。ActorはUploaderまたは現在Owner（Root入力／値比較）。 | Uploader／Owner成功。Draft、未知／未割当Item、非資格／旧Owner、空参照、Group不一致、旧版／不正版、Category不正、UTC不正拒否。 |
| IC-P2 | 対象Bundle未選択ならCase関連は明示null、選択済みなら対象Expense／Group・canonical Case参照・正safe Case版／期待版一致・Rejectedが必要（Root Policy）。 | 実Caseで部分選択の3方向を検証。他Bundleが承認待ち／支払中／Archiveでも未選択対象は成功。対象Rejected・他Bundle未選択／別Case承認待ち／支払中は成功。対象承認待ち／支払中／Archive・他BundleRejectedは拒否。Case facts流用・欠損／余分なfacts・参照／版／全拒否状態を検証。 |
| IC-O1 | 対象Categoryだけ変更、同Receipt／Item ID、版+1、`ItemCategoryCorrected`へActor／UTC／Item／旧新版／Caseコピー／before-afterを追記（Root POST）。 | Category差分、履歴append、入力Date／Case mutation、全関連値の不変性。 |
| IC-I1 | JPY原額・調整後額、品名、他Item、Adjustment／配賦・合計・購入日、全Bundle Pair／所属／Group、初選択と全旧履歴を維持。Expense・Category定義・旧Settlement Revisionを更新しない（Root INV）。 | 訂正→未選択所属移動→初選択→Rejected訂正を実Rootで検証。過去履歴保持、永久guard拒否、旧Receipt／Expense／Case不変。ProductionはCategory定義／Caseへ依存しない。 |
| IC-O2 | 同Categoryでも全PRE／Policy／日時を検証し、成立時はsameRoot no-op。版／履歴を増やさない。新版への旧期待版再送は拒否（内部再入力）。 | 未選択／Rejectedの同値、同値の非資格／旧版／不正日時／Case欠損／不許可状態拒否。版上限でも妥当な同値はno-op、実変更の版overflowは拒否。 |
| IC-F1 | 拒否は`ReceiptInvariantViolation`の固定message／機械判定code。部分結果を返さず、旧Root／入力／旧Snapshot／履歴を変更しない。 | 拒否時非変更、copy／deep freeze、stale replay、overflow。 |

主Evidenceは`apps/api/src/expense-recording/domain/receipt-item-category-correction.spec.ts`。Settlement Caseのstart／reject／approve／支払報告／受取確認をTestだけで使い、Source状態からprimitive factsへ写像する。Receipt登録・Adjustment・移動・永久lock、Category、Expense、Settlementおよびarchitectureを回帰する。

## 不変履歴と残る接続

変更時だけ同Receipt IDで版+1、CategoryIdを差し替えた新しいItemと不変Snapshot・履歴を返す。入力Case factsは必要Fieldだけコピー・freezeし、DateはUTC文字列へコピーする。旧Rootから代替候補を計算できることと、Storageで訂正が成立することは区別する。

Category訂正では金額・負担が変わらないため、Expenseの財務値・版をDomain操作内で更新しない。月次Category Projectionへの実反映は後続で、今回の成功を月次反映完了と扱わない。初選択・再申請との競合にはReceipt CAS／Case版fence／Category Active確認を同判断点で裁定する保存契約が必要。durable operation-result replay、保護保存・Retention、公開API／画面／OCRも未接続。新履歴のActor・分類・金融値をplaintext Storage／Logへ保存しない。

手入力Expenseのamount訂正が持つ解放済みWithdrawn／Cancelledの扱いを、このReceipt Category操作へ転用しない。Bundle所属／payer／割合のUploader専用永久guardもCategory訂正へ転用せず、訂正成功後も永久固定を維持する。

関連Category・Receipt・Bundle契約、ADR170／179、Inventory／design-gatesへ実装Traceを同期する。Context map／正式図は境界・所有・関係不変のため更新不要。公開Schema／Migration／保護Record／Runbook変更なし。Category経路のDB／Browser業務E2Eは未接続のため対象外、既存API／PostgreSQL結合・Web入口E2EはCIで回帰する。RollbackはPR revert。Accepted Decision・承認履歴・公開Readyを変更しない。
