# Receipt Adjustment金額訂正と影響Expense反映

[Task #194](https://github.com/takeshi-arihori/kakei_app/issues/194)は[現行モデル](../product/current-model.md)のReceipt編集・Adjustment Ruleと[ADR #170](../adr/receipt-category-consistency-boundary.md)／[ADR #179](../adr/receipt-bundle-edit-and-snapshot-lock.md)を純Domainへ反映する。既存Adjustment一件の金額訂正が対象。種別／適用先変更・追加／削除、Draft／未割当の一般編集、公開登録・保存・画面は後続個別契約とする。

## 所有と訂正

Receiptが順序付きAdjustment、全Item配賦・合計、Bundle対応と初選択・版・履歴を所有する。専用Adjustment IDは現在存在せず、`correctAdjustmentAmount`はReceipt期待版と0-based `adjustmentIndex`で既存一件を特定する。新Entity／ID／Root／Context／Portを採用しない。Item原額訂正と意味が同じ財務配賦・影響先検証をRoot内で共通化する。公開された任意編集操作は作らない。

Confirmed、Receipt版一致、Uploaderまたは現在Group Ownerの非空参照、同Group、有限操作Date、非空理由が必要。本人性・現在OwnerのSourceはApplication PREで、Client申告を信用しない。理由は既存Expense訂正の履歴Ruleを維持する。固定typed Errorへ入力値を含めない。

既存Adjustmentの種別・適用先・順序／数、Item原額・品名・Category・購入日・記載順、Bundle所属／Pair／初選択を維持する。Tax／Shippingは正、Discount／Pointは負の非0 safe JPY整数。全Itemと全Adjustmentを既存`ReceiptAdjustmentAllocation.calculate`へ渡し、元金額を重みとする独立配賦・最大剰余・Item順tie-break・非負最終額・safe整数を再検証する。新宣言Receipt合計を明示入力し、再配賦後全Item合計へ完全一致させる。Product上限を新設しない。

## 影響範囲とCase条件

実変更では、前後で調整後Item額またはいずれかAdjustmentの配賦円が変わるItemを導出し、そのItemが属する登録Bundle集合を検証する。最大剰余の丸め直しでは、一件の配賦増加が別Itemの配賦減少と相殺してBundle合計が同額になる場合もある。合計だけで影響判定しない。非影響Bundleの精算状態は訂正を止めない。

未割当secondary Itemも再配賦するが、Expense／Caseを作らない。全Item／全Expense登録前の月次非包含は維持する。登録Bundleへの影響がない操作は`ADJUSTMENT_NOT_BUNDLED`でこの登録済みSliceのScope外とする。これは一般の未割当編集禁止を追加するものではない。

Callerの`affectedCaseFacts`は導出集合に過不足なく一意に対応する。各Pairは入力Groupと一致する。未初選択はCase fact／期待版を明示null。初選択済みはcanonical lowercase Case UUID、同Group／対応Expense、正safe Case版と期待版一致、Rejectedだけを要求する。Awaiting Approval／Approved／Payment Active／Archive等の影響先が一つでもあると全候補を拒否する。現在関連Case IDを初選択Case IDと固定一致させず、実関連・currentnessはCaller PRE。所属／payer／割合のUploader専用永久lockを解除しない。

同額入力は既存Adjustmentの非0配賦が及ぶ登録Bundle集合を検証範囲とし、Actor・理由・日時・Group・合計・各Case条件の検証後だけsameRoot no-op。版／履歴は増えず、版上限でも妥当な同額は成立する。実変更はsafe Receipt版+1と不変`AdjustmentAmountCorrected`履歴を追加し、Actor／訂正時Owner／Group／UTC／理由／位置／前後Receipt／全影響Caseコピーを保持する。旧Rootやmutable入力へ参照を残さない。

## 対応Expense

`reflectReceiptAdjustmentAmountCorrection`は実Receipt訂正履歴と両Root期待版を受け、同Receipt ID・Uploader／Group／購入日、同Bundle／Expense ID・Item所属、旧Receipt版→+1、旧Bundle合計と自身の現在額を束縛する。既存一件の額が実変更され、種別／適用先／他Adjustment額・原Item factsが保たれること、当Pairの影響entryと未選択／Rejected条件、Actor・理由・canonical UTCを再検証する。DTOは認可capabilityではなく、Callerは実Sourceから前後を取得する。

新Bundle額を既存Expense登録factoryへ渡し、現在payer／割合、歴史Participant集合／joinOrderで整数負担を再計算する。同Expense ID、Source／購入日、登録集合／順序、payer／割合、`initialSnapshot`、金額訂正／Bundle割合変更／Item移動／原額訂正／Adjustment訂正の全旧履歴を保持する。金融内訳が変わる同額PairにもExpense版+1と`receiptAdjustmentAmountCorrections`を追加する。新履歴はActor／UTC／理由／Adjustment位置／Receipt・Bundle参照／旧新版／当Caseコピー／Expense前後を不変値で保持する。既存の他訂正操作も新履歴を保持する。

旧Settlement Revisionは変えず、再申請が訂正後Sourceから新Revisionを作る。手入力金額訂正methodをReceipt操作として代用しない。

## 契約とVerification Trace

| ID | 条件・責務 | Domain Verification |
| --- | --- | --- |
| AJ1 | PRE: Confirmed／現在版、Actor／Group／理由／UTC、既存位置／signed safe整数／宣言合計 | 正常Uploader／Owner、4種、Item／Receipt対象、各入力拒否 |
| AJ2 | PRE／POST: 全再配賦・全影響集合と各Case | 複数Pair・未割当secondary・同額Pair・非影響Case、過不足／重複、Case参照／版・全不許可状態 |
| AJ3 | INV／POST: 全ID／原facts／Pair／永久lock／歴史Participant／現在payer割合／旧Snapshot・全履歴 | 実Rejected→訂正→再申請、新旧Revision、原額・split・移動・手入力履歴相互保持 |
| AJ4 | FAIL: 各不正値・Pair旧額／両版／safe版overflow、旧Root不変 | 固定typed Error、負額・上限・stale、偽の前後facts／Case拒否 |
| AJ5 | POST: 同額は全guard後sameRoot、immutable copies | 同額理由／Case／集合検証、版上限no-op、Date／Case mutationとfreeze |
| AJ6 | Application PRE: 本人性／Owner／Group Active＋Closing、Source・全Case currentness、全Expense版／共通commit・rollback・再送・保護保存 | 未接続。Domain成功・DTO・読取版比較を実保存／先着裁定／認可の証拠にしない |

主Testは`apps/api/src/expense-recording/domain/receipt-adjustment-amount-correction.spec.ts`。実Settlement EntityはTestだけで使用し、Productionは他ContextのEntity／Repositoryへ依存しない。既存Receipt／Adjustment／Bundle／Category／Expense／Settlement／architectureを回帰する。

## 後続・文書・Rollback

ApplicationはReceiptと全影響Expense、全Case版・初選択を同判断点で取得し、共通atomic commitへ束縛する。一部の候補だけを保存しない。具体Port／lock順／CAS／durable replay、実本人性・Group fence、Protection／Key／Audit／Retention、月次Projection／GraphQL／UI／OCRは後続Gate。金融値・Actor・理由を平文Storage／Logへ書かない。履歴Snapshotのcopy容量・CPUは実保存前に評価する。

関連契約・ADR Forward Trace・design-gates・Inventoryへ同期する。Product Rule／Context所有・正式図、SDL／生成型、DB Schema／Migration／Runbook／AGENTS／Skill変更なし。対象Storage・API・Browser業務E2Eは未接続で対象外とし、CI既存DB／Web入口回帰と区別する。RollbackはPR revert、Data移行なし。認証方式／Providerと公開経路Readyを変更しない。
