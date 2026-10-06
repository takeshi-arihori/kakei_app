# Receipt Bundle間のItem移動とExpense額反映契約

Task [#188](https://github.com/takeshi-arihori/kakei_app/issues/188)は[ADR #179](../adr/receipt-bundle-edit-and-snapshot-lock.md)、[ADR #170](../adr/receipt-category-consistency-boundary.md)、[現行モデル](../product/current-model.md)の所属移動Ruleを純Domain計算へ反映する。[初回登録](receipt-bundle-registration-contract.md)、[永久lock](receipt-bundle-snapshot-lock-contract.md)、[payer／割合変更](receipt-bundle-split-change-contract.md)に続く内部契約。

## 所有・操作・Knowledge State

Receipt RootがItem所属・Bundle Pair・両Bundleの永久編集Policyを所有し、個別GroupExpense Rootが自Expenseの額・負担・不変履歴を所有する。重要RuleをDTOへ移さず、他Context型／Entity／Repository／新Root／Service／Port／保存Schemaを追加しない。Root間のCaller coordinationと保存TransactionをDomain Serviceへ混在させない。

`Receipt.moveBundleItems`はUploader、現在期待版、有限日時、異なる既登録Bundle、移動元の一意Item集合を受け取る。両側に共通編集guardを適用し、どちらか初選択済みなら永久拒否する。移動元を非空に保ち、Item原額・Adjustment・調整後額・Category・購入日・Receipt合計、両Bundle ID／対応Expense ID／Groupを維持する。Receipt記載順に現在所属を再構成し、同Receipt IDで版+1と`BundleItemsMoved`履歴を追加する。初回所属は旧`BundleRegistered`履歴に残り、現在`bundles`はその版の所属を表す。他Bundle、選択records、未割当Itemを変更しない。

Callerは移動前後の各Receipt Rootから、影響する両Bundleについて`bundleEditingFacts`を取得する。`GroupExpense.reflectBundleItemMovement`は現在Expense版、移動前Receipt期待版、前後facts、Uploader、有限日時を受け取る。before factsのExpense／Group／Uploader／購入日／額を自Rootと束縛し、after factsの全Pair参照・日付・Sourceをbeforeと一致させ、Receipt版が正確に+1であることを検証する。現在payer／割合／登録Participant集合とjoinOrderで既存整数配賦を再利用し、同Expense IDの額・負担だけを変更する。

**Accepted**: ADR179のUploader専用、両側初選択前、一意所属／非空、同Expense ID・履歴維持。内部操作・コピー・期待版・同Bundle拒否はTask188の操作契約。safe integer・有限Dateは内部技術制約でありProduct上限／時刻順序Ruleではない。

**Assumption**: Callerは同一判断点の実Receipt移動前後候補と実両Expenseを束縛する。DTOは認可capability／署名token／実Source Portではなく、参照・額・期待版一致だけでは実現在版／実移動原因／本人性／初選択真偽／Group資格・Closingを証明しない。旧Root／古いfactsから代替新版を計算できる。after factsを持つだけでItem移動以外の額訂正許可を得るわけではない。

## PRE／POST／INV／FAILとTest Trace

| ID | 契約／責務 | Verification |
| --- | --- | --- |
| BM-P1 | ReceiptはConfirmed、現在版、Uploader、有限日時、両側既登録・未初選択、異なるBundle、移動元の一意非空Item集合が必要（Root Policy／入力）。 | Draft、Owner／他Actor／blank、旧版、未知／同一Bundle、空／重複／未知／他所属／未割当Item、最後Item移動、両側lock、UTC／版overflow拒否。実Case Rejected／Withdrawn／Cancelled永久Policyも回帰。 |
| BM-O1 | Receipt所属を一意・非空に移し版+1、Actor／UTC／旧新版／from-to／Receipt順Item参照／before-afterを不変履歴へ追加（Root POST）。 | 調整後額・Bundle／Expense ID維持、他Bundle／Item／合計／未割当／全登録完了判定維持、入力順非依存、逆移動。 |
| BM-P2 | Expense現版・before Receipt版一致とbefore factsの自Root整合。afterは同Pair／日付／SourceでReceipt版+1、非負safe額、Uploader／有限UTC（値束縛）。実移動真偽はAssumption。 | 各参照／額／版／Actor／UTC／overflow拒否、旧版再入力拒否。 |
| BM-O2 | 各Expenseは同ID・登録集合／joinOrder・payer／割合／購入日／Sourceで新額・整数負担を計算し版+1、前後facts copy／ActorUTC／before-afterを追記（Root POST）。 | 両Root実計算、異なるpayer・割合、値引き後額、端数とJPY上限。 |
| BM-I1 | 初回事実と既存amount corrections／bundleSplitChanges／bundleItemMovementsをすべて維持（Root INV）。0円Item移動でも両Expense版・履歴を進める。 | 0円移動、移動→payer変更→明示同額amount訂正→逆移動の履歴維持。 |
| BM-F1/F2 | Domain拒否は固定messageと機械判定可能codeで、旧Root／入力／前履歴を変更せず部分結果を返さない。 | 配列／Date／facts mutation、deep freeze、片方Expense反映失敗でも旧3Root不変。 |

`receipt-bundle-item-movement.spec.ts`が主Evidence。既存Receipt確認／Adjustment／Pair／永久lock、Expense配賦／amount訂正／Split、Case／Revision／取消、architectureを回帰検証する。両額と負担の合計はBigIntで確認し、再配賦は`GroupExpense.register`へ委譲する。

## 履歴・候補と保存の意味

`bundleItemMovements`はamount-onlyの`corrections`、payer／割合の`bundleSplitChanges`と別の不変履歴。3操作すべてが相手の履歴とinitialSnapshotを保持し、共通Root版で順序を追跡する。理由必須やTimestamp順序Ruleを追加しない。0円Itemでは財務値が同じでも所属の影響履歴が必要なためpure no-opへ落とさない。手入力amount-only訂正の既存権限・理由契約を変更しない。

Receipt移動、両Expense反映は候補Rootの計算であり実保存ではない。途中計算失敗時はCallerが全候補をdiscardし、旧3Rootを保持する。実保存にはReceipt変更CAS＋両Expense CASの共通atomic commit、初選択と所属／payer編集の同時裁定、一件失敗時の全非反映が必要。Domainテストは旧値非変更を検証し、Storageの原子性や実winnerを証明しない。

現在版から同じ入力を繰り返して代替候補を計算できるが、新Rootへの旧期待版再送は拒否する。durable operation-result replay、共通Port署名、保存方式・lock順をこのSliceで採用しない。

## 後続Gate・文書影響

Rejected後Item金額／Adjustment／Category訂正と月次反映は別契約。永久lockをItem値訂正全般の禁止へ一般化せず、この未選択Item移動の額反映をRejected後訂正の完成と扱わない。履歴維持のamount訂正Testは明示同額の既存操作だけで、実Case資格／Receipt訂正を証明しない。

実Source currentness／最初の選択、本人性／Group fence・Closing、3Rootの保存atomicity／CAS、durable lock／再送、保護保存・Retention、Projection／API／UI／OCRは後続Gate。新履歴の金融facts・Actorをplaintext Storage／Logへ保存しない。

初回登録・永久lock・payerSplit契約、ADR170/179、Inventory、design-gatesへtraceを同期する。Context map／正式図は所有・境界・Entity関係不変で更新不要。公開Schema／Migration／保護Record／Runbook変更なし。Bundle経路のDB／Browser E2Eは未接続のため省略し、既存API／PostgreSQL・Web入口E2EはCIで確認する。RollbackはPR revert、Accepted承認履歴・公開Readyを維持する。

## 登録済みItem Category訂正の純Domain trace（2026-10-05）

[Task #190](https://github.com/takeshi-arihori/kakei_app/issues/190)の[Category訂正契約](receipt-item-category-correction-contract.md)は、Uploaderまたは現在Group Ownerが登録済みConfirmed Item一件のCategoryだけを訂正し、同ID・金融値・Bundle対応・初選択・旧Snapshot・全履歴を保持する。対象Itemに対応するExpenseが未選択なら編集可能、初選択後は同判断点の関連CaseがRejectedの場合だけ許可する。他Bundleの状態を対象へ流用せず、所属／payer／割合の永久固定を解除しない。同Categoryでも条件を検証したsameRoot no-op。実Category Active／Group適合・Source現在版／本人性・Closing、訂正と初選択／再申請の保存裁定・CAS／再送、金額／Adjustment訂正、月次Projection／公開API／画面は後続Gate。Accepted Decisionと公開Readyを変更しない。


## 登録済みItem原額訂正とExpense反映の純Domain trace（2026-10-06）

[Task #192](https://github.com/takeshi-arihori/kakei_app/issues/192)の[原額訂正・財務反映契約](receipt-item-amount-correction-contract.md)は、Uploaderまたは現在Group Ownerが登録済みItem一件の原額を理由付き訂正し、既存Adjustment再配賦で影響する全Bundleの未選択／Rejected条件を検証する。各既存Expense ID・登録集合／payer／割合・初回事実・全履歴と旧精算Revisionを維持して額・負担へ反映する。Bundle永久lockを解除しない。Adjustment自体の編集、Draft／一般編集、実Source・認可／Group fence、全影響Root共通保存／CAS／再送、保護保存／Projection／API／画面は後続Gate。純Domain成功を実保存や公開Readyの証拠にしない。

## 既存Adjustment金額訂正の実装trace（2026-10-06）

[Task #194](https://github.com/takeshi-arihori/kakei_app/issues/194)の[Adjustment金額訂正契約](receipt-adjustment-amount-correction-contract.md)は、既存一件の額訂正と全再配賦、影響する登録Bundleの未選択／Rejected条件、同Expense IDの額・負担・不変履歴を純Domainで扱う。原額・Category・Pair／初選択永久lock・現在payer／割合・旧精算Snapshot・全既存履歴を維持する。既存の原額／割合／Item移動／手入力訂正も新Adjustment履歴を保持する。追加／削除・種別／適用先変更、Draft／一般編集、実Source・認可／Group fence・原子的保存／再送／保護保存、Projection／API／画面は後続Gate。Accepted本文・承認履歴・公開Ready状態を変更しない。
