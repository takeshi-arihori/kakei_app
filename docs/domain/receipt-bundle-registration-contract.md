# Receipt Bundle初回登録契約

Task [#182](https://github.com/takeshi-arihori/kakei_app/issues/182)の純Domain契約。[ADR #170](../adr/receipt-category-consistency-boundary.md)、[ADR #179](../adr/receipt-bundle-edit-and-snapshot-lock.md)、[手動確定契約](receipt-manual-confirmation-contract.md)、[Adjustment配賦](receipt-adjustment-allocation-contract.md)に従う。

## 所有と入力境界

Expense RecordingのReceipt RootがConfirmed ItemとBundleの対応を所有する。BundleはこのSliceではRoot所有の不変登録factsで、独立Lifecycleを持つ可変Root／Child Entityを追加しない。Bundle IDはopaqueなValue Objectで空参照を拒否する。公開ID形式、発番方式、DB保存Schemaは決めない。

Callerは既存`GroupExpense.register`で生成した初回Expense Rootを渡す。ReceiptはそのID／Group参照との対応を保持し、Expense Rootを所有・変更しない。Participant集合、payer、割合、整数配賦はGroupExpenseの責務であり、Receiptへ複製しない。Receipt ID、Uploader、購入日、Item Categoryと調整前後の額、Adjustment、確認履歴は維持する。

Group参照の由来は初回Expenseの`groupId`だけであり、次Pairも同Groupであることを検証する。Receiptの実Group所属、実Actor本人性、現在Group資格／Closing fence、ExpenseのDB新規性／他Receiptとの一意対応は証明しない。これらは後続Application／Storageの条件で、照会Portや保存契約を本Taskで導入しない。

## PRE／POST／INV／FAIL

| ID | 条件 | Test |
| --- | --- | --- |
| BR-P1 | Confirmed Root、期待版一致、Actor参照はUploader、操作日時は有限Date。 | Draft・非Uploader（Owner含む）・不正Actor・旧版・不正日時拒否 |
| BR-P2 | 未使用Bundle ID、有効なItem参照を1件以上、重複なく選ぶ。全ItemはReceipt内に存在し未割当。 | 空・重複・未知・割当済みItem／Bundle拒否 |
| BR-P3 | Expenseはversion 1かつ訂正なし。当Receiptで未対応のID。Source Owner＝Uploader、購入日＝Receipt、額＝選択Item調整後合計、Group＝初回PairのGroup。 | 重複Expense・非初回・Source／日付／金額／Group不一致拒否 |
| BR-O1 | 成功は同じReceipt IDの新Rootを返し版+1、Bundle対応とActor／UTC／旧新版／before／after履歴を追記。 | 2段階登録と同一性・履歴検証 |
| BR-O2 | `hasCompleteBundleRegistration()`は1件以上のBundleがあり、全Confirmed ItemがBundleへ割当済みの場合true。登録操作で全Bundleに初回Expense対応を保証する。 | Draft／Confirmed未割当（Itemなしを含む）／一部=false、1〜複数Bundle全割当=true |
| BR-I1 | 入力配列をcopy／freeze。旧Root、成功済みBundle、Item facts、確認履歴、提供Expenseは変化しない。 | 入出力mutation・途中失敗・修正後再試行 |
| BR-F1 | 不成立は固定messageと機械判定可能codeのReceiptInvariantViolation。新版・部分結果を返さない。 | 拒否全般と旧Root非変更 |

JPY合計はBigIntで比較し、0円とsafe integer上限も扱う。safe integerは内部技術制限でProduct上限ではない。GroupExpense factoryの1〜4人・10%刻み・合計100%・payer包含・0%・最大剰余方式を再利用する。手入力Expenseの訂正Ruleをこの操作で呼び出さない。

## 履歴と失敗の意味

登録は`BundleRegistered`の不変Root遷移履歴を追加する。既存`Confirmed`履歴とその旧Snapshotは変更しない。後のPairが失敗しても成功済みPairを持つRootをそのまま使い、修正した入力で残Itemの登録を計算できる。同入力を新版へ再送した場合は期待版不一致を拒否する。

これは実保存、CAS先着、応答喪失時の結果replayを意味しない。古いRootから複数の代替新版を計算できるが、実winnerの選択は外側の保存責務である。完了照会trueも、DBの全Expense保存済み／月次Projection包含の証拠にはならない。

## 後続Gate

- Receipt版とExpense新規性／一意対応を同判断点で確認する共通atomic commit、結果不明のdurable idempotency
- Source本人性、Receipt実Group所属、現在Group資格／Closing fence、Category状態の照合
- Bundle Item所属変更、payer／割合変更、Snapshot初選択との競合と永久lock
- Snapshot後RejectedのItem額／Adjustment／Category訂正と対応Expense反映
- Persistence／保護Record／Schema、Projection、公開API／UI、OCR／画像／Retention

既存BundleやItem所属を登録APIで変更できない。後続編集機能の未実装を「編集永久禁止」というProduct Ruleへ置き換えない。

## 検証と文書影響

`apps/api/src/expense-recording/domain/receipt-bundle-registration.spec.ts`が上記契約を検証する。既存Receipt確認・Adjustment・GroupExpense配賦／訂正の回帰とAPI architecture testを実施する。新しいFramework／DB／API／Context間依存を追加せず、3 Context map、Migration、GraphQL Schema、運用Runbookの変更は不要。実DB／Browser E2Eはこの純Domain Sliceの対象外で、後続の保存・接続Taskで必要となる。
