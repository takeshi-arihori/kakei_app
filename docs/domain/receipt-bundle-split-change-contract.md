# Receipt Bundleのpayer／Split割合変更契約

Task [#186](https://github.com/takeshi-arihori/kakei_app/issues/186)の純Domain契約。[ADR #179](../adr/receipt-bundle-edit-and-snapshot-lock.md)、[ADR #170](../adr/receipt-category-consistency-boundary.md)、[初回登録](receipt-bundle-registration-contract.md)、[初選択・永久編集lock](receipt-bundle-snapshot-lock-contract.md)に従う。

## 操作・所有・信頼境界

Uploaderは、初Snapshot選択前の登録済みBundleについて、同じExpense IDのpayerとSplit割合を変更した新Rootを計算できる。ReceiptはItem／Bundle／Expense対応と永久編集Policyを所有し、GroupExpenseはpayer／割合／負担と不変履歴を所有する。Participant集合・各ID・joinOrderは登録時のまま維持する。Group Ownerというだけでは許可しない。新しいEntity／Root／Context／Port／Repositoryを追加せず、DTOは参照・版・調整後額の運搬に限定する。

`Receipt.bundleEditingFacts(CheckReceiptBundleEditing)`は既存`assertBundleEditingAllowed`と同じprivate guardでConfirmed、現在期待版、既存Bundle、Uploader、初選択なしを確認し、Receipt／Bundle／Expense／Group参照、Receipt版、Uploader、購入日、当Bundle Itemの調整後合計をprimitiveの不変コピーとして返す。Receipt版・履歴・Item・Pairを変更しない。payer／割合をReceiptに複製しない。

`GroupExpense.changeBundleSplit(ChangeReceiptBundleSplit)`はCaller供給factsを自Rootへ束縛し、全登録Participant分の割合と新payerを検証する。入力にjoinOrderを含めずRootの登録値を使い、既存`GroupExpense.register`の整数最大剰余・payer→joinOrder tie-breakを再利用する。金額・日付・Group・Source Ownerを変更しない。

**Assumption**: Callerは同判断点の実Receipt Rootからfactsを取得し、Actor本人性・Group資格／Closingを確認する。DTOは公開認可capability／署名token／Source Portではない。Expenseの値チェックだけではReceiptの実存在、真偽、実現在版、初選択有無、実本人性を証明しない。古いReceipt factsや旧Rootから代替新版を計算できるため、Application／StorageがReceipt読取版fenceとExpense更新CASを同一判断点で確認し、初選択と編集を原子的に裁定して実winnerを決める。具体Port署名・保存方式は未採用の後続Gate。

## PRE／POST／INV／FAILとTest Trace

業務条件はADR179のAccepted Decision、操作入力・不変コピーはTask186の内部契約へTraceする。safe integer／有限Dateは内部技術制約で、Product上限や時刻順序Ruleではない。

| ID | 条件と責務 | Verification |
| --- | --- | --- |
| BS-P1 | Receipt facts取得にはConfirmed／現在期待版／既存Bundle／Uploader／初選択なしが必要（Root Policy）。 | 調整後部分合計、Draft／Owner／未知Bundle／旧版／不正Actor／選択済み拒否。Task184の実Case Rejected／Withdrawn／Cancelled後も永久拒否の回帰。 |
| BS-P2 | Expense期待版が自Rootと一致。Fact Receipt版は正のsafe integerで期待Receipt版と一致（入力／版検証）。実現在版は上記Assumption。 | Expense／Receipt版不正・旧版・不一致拒否、選択後の古いDTOから局所計算できる境界の明示。 |
| BS-P3 | Fact参照が非空、調整後額が非負safe integer。Expense／Group／Uploader／購入日／額が自Rootと一致し、Actor＝Uploader＝Source Owner、操作時刻が有限Date（値束縛／権限比較）。 | 参照・額・Source facts・Actor・UTC拒否。実本人性は証明しない。 |
| BS-P4 | 登録Participant全件を1回ずつ指定し追加・除外不可。payerは集合内、1〜4人、0〜100の10%刻み、合計100%（Root Invariant）。 | 追加／除外／置換／重複、外部payer、不正割合・合計を拒否。1〜4人・0%・0円・safe額上限・配列順非依存・端数優先回帰。 |
| BS-O1 | 真の変更は同Expense IDで版+1。payer／割合／負担だけ変え、初回事実、登録集合／joinOrder、総額・購入日・Sourceを維持（Root POST）。Receiptは変更しない。 | 実Receipt Pairから変更、payer端数・80/20配賦、同一性と旧Root／Receipt非変更。 |
| BS-O2 | Actor／UTC／旧新版／Bundle facts copy／before-afterを不変履歴へ追加（履歴POST）。 | 入力Date／Fact／割合配列mutation、deep freeze、連続変更。 |
| BS-I1 | initialSnapshot、既存amount-only corrections、既存bundleSplitChangesをどちらの変更でも保持（Root INV）。共通Root版で順序を追跡する。 | Split→明示同額amount訂正→Splitの履歴維持。Receipt Rejected後Item訂正経路の完成とは扱わない。 |
| BS-I2 | 全入力検証後、現在期待版で同一payer／割合なら同Rootのpure no-op。0円でもpayer／割合の実変更は履歴に残す。 | 同Root／現版、旧版拒否、no-opでもActor・Source版・時刻拒否、実変更版overflow拒否。durable replayではない。 |
| BS-F1 | 不成立は入力値を含まない固定messageと機械判定可能code。旧Root・入力・履歴を変えず部分結果を返さない。 | 各拒否と旧Snapshot／版／履歴の維持。 |

`receipt-bundle-split-change.spec.ts`を主Evidenceとし、Receipt確認／Adjustment／Pair／永久lock、Expense配賦／amount訂正、Case／Revision／取消、architectureを回帰確認する。

## 履歴・再入力

`bundleSplitChanges`はamount-onlyの`corrections`と別の不変順序付き履歴。双方が新Rootを作るとき相手の既存履歴とinitialSnapshotを引き継ぐ。新しい理由必須RuleやTimestamp順序Ruleを追加せず、Caller時刻をUTC文字列へcopyする。履歴は保護保存Schema／Audit Logとして採用しない。

同一財務値でもSource facts・Actor・版・時刻・配賦を先に検証する。旧期待版の再送は競合拒否し、応答喪失時のoperation-result replayを導入しない。Receiptはpayer／割合変更で進版しないため、将来の保存には読取版fenceが必要となる。

## 後続Gate・文書影響

Item所属移動（複数Expense変更）、Rejected後Item額／Adjustment／Category訂正とExpense・月次集計反映は別Task。所属／payer／割合の永久lockをItem訂正全般の禁止へ一般化しない。

実Source currentness／初選択真偽、本人性／Group資格・Closing、Receipt読取版fence＋Expense CAS／共通atomic commit、durable first selection／lock／再送結果、保護保存、Projection／API／UI／OCR／Retentionは未接続。新履歴の金融facts・Actorをplaintext Storage／Logへ保存しない。

ADR170/179、Inventory、design-gates、初回登録／lock契約へ実装traceを同期する。Context map／正式図は所有・境界・Entity関係を変えないため更新不要。公開Schema／Migration／保護Record／Runbookの変更はなく、API／DB／Stack／視覚証跡SkillとDB／Browser E2Eは本純Domain Sliceでは省略する。公開Operation／画面Readyを引き上げず、RollbackはPR revertでAccepted承認履歴を維持する。
