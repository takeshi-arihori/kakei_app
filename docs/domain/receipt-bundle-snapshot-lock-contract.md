# Receipt Bundle初Snapshot選択と永久編集lock契約

Task [#184](https://github.com/takeshi-arihori/kakei_app/issues/184)の純Domain契約。[ADR #179](../adr/receipt-bundle-edit-and-snapshot-lock.md)、[ADR #170](../adr/receipt-category-consistency-boundary.md)、[初回登録契約](receipt-bundle-registration-contract.md)へTraceする。

## 所有とSource境界

Receipt Rootは初回Bundle対応を維持し、初選択として供給された不変値`ReceiptBundleSnapshotSelection`を追記する。選択値はBundle／Expense／Group／Case／Snapshot参照、Source Actor、UTC日時を持つValue Objectで、独立Lifecycleや可変Rootではない。SettlementのEntity／型をProductionへimportせず、金融factsや現在Case状態を複製しない。Case／Snapshotのcanonical UUIDは既存Settlement Rootの内部表現との整合確認であり、公開Scalar／発番方式の採用ではない。Group参照はこのVOで非空値として保持し、Receiptが初回Pairとの値一致を検証する。既存GroupExpense登録／Settlement Snapshotは既存のcanonical UUIDを要求するが、本SliceでGroupの形式を新たに採用・変更しない。

Sourceの選択事実を取り込む操作はBundle編集とは別であり、Source ActorにUploader一致を要求しない。Actorの安定参照を記録するだけで、本人性・選択資格・Group OwnerによるBundle編集権限を認めない。実Sourceの初選択であること、同Group／同Expense、Actor資格、Closing fence、競合・保存の判断点は将来Application／Storageが担う。入力のみでは実最初の選択やdurable lockを証明しない。

## PRE／POST／INV／FAIL

| ID | 契約 | Test |
| --- | --- | --- |
| SL-P1 | 記録はConfirmed、現在期待版、有効なSource Actor／日時／参照を必要とする。 | Draft、旧版、不正Actor・日時・Source参照拒否 |
| SL-P2 | SourceのBundle参照は登録済みで、Expense／Groupが初回Pairと一致する。 | 未知Bundle、異なるExpense／Group拒否 |
| SL-O1 | 初記録は同Receipt IDの新版（版+1）を返し、初選択VOとActor／UTC／before-after／旧新版履歴を追記する。 | 同一性、版・履歴、既存facts／Pair／確認履歴の維持 |
| SL-I1 | 初選択値を置換・削除・解除する入口はない。同一値の現在版再入力は同じRootを返すpure no-op。別値による置換は拒否する。 | 同一fact、旧版、別Snapshot／時刻の置換拒否 |
| SL-P3 | 編集可否検証はConfirmed／現在版／既存Bundle／Uploader一致を必要とする。 | Owner・他Actor・不正Actor・未知Bundle・Draft・旧版拒否 |
| SL-I2 | 初選択があるBundleのItem所属／payer／割合編集Policyは永久拒否する。Rejected／Withdrawn／Cancelledで再開しない。 | 実既存Caseの各Domain遷移後も共通Policy拒否 |
| SL-O2 | 複数Bundleは選択対象のみlock。後続の未割当Pair登録と全登録完了判定は従来どおりで、lockを消さない。 | 残Pair登録成功、新BundleはUploader Policy通過、旧Bundleは拒否 |
| SL-F1 | 不成立は固定messageと機械判定可能codeのReceiptInvariantViolation。部分結果／旧Root変更なし。 | 拒否時非変更・deep immutability・入力mutation |

`assertBundleEditingAllowed`は成功時voidを返す内部Policyで、Root版・履歴を変更しない。[Task #186のpayer／Split変更](receipt-bundle-split-change-contract.md)では、同じprivate guardを通る`bundleEditingFacts`で自Rootの参照・版・調整後合計を不変コピーし、Expenseが財務値だけを更新する。[Task #188のItem移動](receipt-bundle-item-movement-contract.md)も両Bundleに共通guardを適用する。同判断点の実Source／3Root共通保存は後続Gate。Policyを呼ぶだけでは本番認可や実編集との原子性を証明しない。

## 履歴と再入力

`BundleSnapshotSelected`履歴のActor／atは供給されたSource選択Actor／UTC時刻であり、配送・取り込み時刻やAudit Logではない。現在時刻取得や最小Timestamp採用を追加せず、実初選択のSource確認はApplication Gateに残す。既存Confirmed／BundleRegistered履歴とSnapshotを変更しない。

同一factのpure no-opは、現在期待版で同じ値を渡した場合だけ成立する。旧版の再送は競合として拒否し、応答喪失時のdurable operation結果replayを採用しない。Case取消・却下・関連付け解除の通知を「未選択」へ変換する入口も提供しない。

## 後続Gateと検証範囲

Item所属移動と両Expense額反映の純Domainは[Task #188の契約](receipt-bundle-item-movement-contract.md)へTrace。Rejected後Item額／Adjustment／Category訂正は別Task。payer／割合の純Domain変更と既存Expense ID／登録Participant集合／履歴を保つ再計算は[Task #186の契約](receipt-bundle-split-change-contract.md)へTraceする。現在のlockはこれらのうち所属／payer／割合だけの編集Policyで、Rejected後Item訂正を禁止する新Ruleへ一般化しない。

ReceiptとCase選択・複数Pair変更の共通commit、CAS、durable初選択・operation再送、Source真偽／本人性／認可／Group fence、Port／保護Schema／Projection／API／UIは未接続のままとする。Context map、公開Schema、Migration、Runbookは変更しない。DB／Browser E2Eは本Sliceの対象外。

`receipt-bundle-snapshot-lock.spec.ts`はSource参照整合、Uploader Policy、初選択不変性／履歴、各実Case遷移後の永久拒否、段階登録との両立を検証する。Caseを使うのはTestだけで、Production DomainはContext横断依存を持たない。Architecture testと既存Receipt／Settlement回帰、Root QAを実行する。これらは実Source連携・実保存の実証ではない。

## 登録済みItem Category訂正の純Domain trace（2026-10-05）

[Task #190](https://github.com/takeshi-arihori/kakei_app/issues/190)の[Category訂正契約](receipt-item-category-correction-contract.md)は、Uploaderまたは現在Group Ownerが登録済みConfirmed Item一件のCategoryだけを訂正し、同ID・金融値・Bundle対応・初選択・旧Snapshot・全履歴を保持する。対象Itemに対応するExpenseが未選択なら編集可能、初選択後は同判断点の関連CaseがRejectedの場合だけ許可する。他Bundleの状態を対象へ流用せず、所属／payer／割合の永久固定を解除しない。同Categoryでも条件を検証したsameRoot no-op。実Category Active／Group適合・Source現在版／本人性・Closing、訂正と初選択／再申請の保存裁定・CAS／再送、金額／Adjustment訂正、月次Projection／公開API／画面は後続Gate。Accepted Decisionと公開Readyを変更しない。


## 登録済みItem原額訂正とExpense反映の純Domain trace（2026-10-06）

[Task #192](https://github.com/takeshi-arihori/kakei_app/issues/192)の[原額訂正・財務反映契約](receipt-item-amount-correction-contract.md)は、Uploaderまたは現在Group Ownerが登録済みItem一件の原額を理由付き訂正し、既存Adjustment再配賦で影響する全Bundleの未選択／Rejected条件を検証する。各既存Expense ID・登録集合／payer／割合・初回事実・全履歴と旧精算Revisionを維持して額・負担へ反映する。Bundle永久lockを解除しない。Adjustment自体の編集、Draft／一般編集、実Source・認可／Group fence、全影響Root共通保存／CAS／再送、保護保存／Projection／API／画面は後続Gate。純Domain成功を実保存や公開Readyの証拠にしない。

## 既存Adjustment金額訂正の実装trace（2026-10-06）

[Task #194](https://github.com/takeshi-arihori/kakei_app/issues/194)の[Adjustment金額訂正契約](receipt-adjustment-amount-correction-contract.md)は、既存一件の額訂正と全再配賦、影響する登録Bundleの未選択／Rejected条件、同Expense IDの額・負担・不変履歴を純Domainで扱う。原額・Category・Pair／初選択永久lock・現在payer／割合・旧精算Snapshot・全既存履歴を維持する。既存の原額／割合／Item移動／手入力訂正も新Adjustment履歴を保持する。追加／削除・種別／適用先変更、Draft／一般編集、実Source・認可／Group fence・原子的保存／再送／保護保存、Projection／API／画面は後続Gate。Accepted本文・承認履歴・公開Ready状態を変更しない。
