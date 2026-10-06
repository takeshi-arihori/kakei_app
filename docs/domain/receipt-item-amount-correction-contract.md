# 登録済みReceipt Item原額訂正と対応Expense反映

[Task #192](https://github.com/takeshi-arihori/kakei_app/issues/192)は[現行モデル](../product/current-model.md)の明細編集／理由付き訂正と[ADR #170](../adr/receipt-category-consistency-boundary.md)／[ADR #179](../adr/receipt-bundle-edit-and-snapshot-lock.md)を純Domainへ反映する。対象は登録済みConfirmed Item一件の原額だけ。Adjustment自体の変更・追加・削除、Draft／未割当対象の一般編集、他Fieldは別操作で、入口のScope外拒否をProduct全体の編集禁止へ一般化しない。

## 所有と内部契約

ReceiptがItem原額・全調整配賦・合計・Pair／初選択と不変履歴を所有し、`correctItemAmount`が新版と`ItemAmountCorrected`履歴を返す。Expenseは`reflectReceiptItemAmountCorrection`で実訂正の前後Pairを自身へ束縛し、同IDの額と負担を更新する。新Root／Service／Context／Portを作らない。

同GroupのUploaderまたは現在Group Owner、Receipt現在期待版、有限Date、非空理由を要求する。理由は既存のExpense訂正履歴Ruleによる。JPY非負safe整数は内部制約で新Product上限ではない。日時とCaseは必要値だけcopy／freezeし、固定typed Errorへ入力値を含めない。

新原額と既存全Adjustmentを既存`ReceiptAdjustmentAllocation.calculate`へ渡し、Item単位／Receipt全体配賦、非負／safe／基準0条件を再検証する。Adjustmentの種別・額・対象とItem記載順を維持する。新しい宣言Receipt合計を明示入力し、調整後全Item合計と完全一致させる。

影響Itemは、対象Itemと、前後で原額・調整後額またはいずれかAdjustment配賦円が変わるItem。これらを含む登録済みBundle集合をReceipt自身が導出する。税・値引きの配賦差が相殺してBundle合計が同額でも、金融事実が変わる場合は影響に含む。配賦で変わる未割当secondary Itemも再計算するがExpense／Caseを新設せず、全Item／全Expense登録前の月次非包含を維持する。

Callerの`affectedCaseFacts`は影響Bundle集合へ過不足なく一意に対応する。未初選択ならCase事実と期待版は両方明示null。初選択後は現在関連Caseのcanonical lowercase UUID、同Group／対応Expense、正safe Case版と期待版一致、Rejectedが必要。他BundleのRejectedを流用せず、承認待ち／支払中／Archive等の影響先へ波及する訂正を拒否する。金融値へ影響しない別Bundleの状態は対象を止めない。現在Case IDを初選択Case IDと固定一致させず、実関連・currentnessはCaller PREとする。

Category単独訂正と未選択／Rejected Policyを共有するが、金融訂正は導出された全影響Bundleで検証する。Bundle所属／payer／割合のUploader専用永久guardは解除しない。同原額でもActor・Group・理由・日時・合計・対象Case条件を検証後sameRoot no-op。変更も波及もない場合、影響集合は対象Bundle一件。版／履歴は増やさず安全版上限でも妥当な同値は成立する。実変更だけReceipt版+1と不変履歴を追加する。

## 対応Expenseへの反映

Callerは実訂正履歴と訂正前Receipt期待版、Expense現在期待版を渡す。DTOは認可capabilityではない。Expenseは同Receipt／Uploader／Group／購入日、同Bundle／Expense IDと不変Item所属、正safe旧Receipt版→+1、旧Bundle合計と自身の現在額を照合する。原額が実際に変わった対象と自身が影響集合に一件だけ属すること、当Bundleの未選択／Rejected Case条件、ActorがSource Ownerまたは訂正時Owner、理由・UTCを再検証する。

新Bundle額を既存Expense登録factoryへ渡し、現在payer／割合と歴史Participant集合／joinOrderでJPY負担を再計算する。同ID、Group、Source Owner、購入日、登録集合・順序・payer／割合、`initialSnapshot`と全旧履歴を維持する。同額Pairにも版+1と`receiptItemAmountCorrections`を追加する。履歴にはActor／UTC／元理由／起点Item／Receipt・Bundle参照／旧新版／当Caseコピー／Expense前後事実を保持する。入力のmutable Caseへ参照を残さない。

手入力額訂正・Bundle payer／割合変更・Item移動は新履歴を保持し、新反映も既存の全履歴を保持する。手入力訂正methodをReceipt明細訂正Use Caseとして代用しない。旧Settlement Revisionは変更せず、再申請が訂正後のSourceから新Revisionを作る。

## 契約とTest Trace

| ID | 分類・条件・責務 | Verification |
| --- | --- | --- |
| IA1 | PRE: Confirmed／登録済み対象／Receipt版、Uploaderまたは現在Owner、同Group、非空理由・UTC | Uploader／Owner成功、Draft／未知／未割当／旧版／非資格／空入力拒否 |
| IA2 | PRE／POST: 全再配賦、宣言合計一致、導出影響集合の各Case参照・期待版・状態 | Item限定／全体税・値引き、2 Pairと未割当secondary波及、相殺同額Pair、過不足／重複集合、各不一致・全不許可状態拒否 |
| IA3 | INV／POST: 同ID・Pair所属・初選択永久lock・歴史Participant／payer／割合、旧Snapshot・全履歴不変、金融値再計算 | 実Case Rejected→訂正→再申請、Category→財務→割合→移動、複数財務・既存額履歴保持 |
| IA4 | FAIL: 不正額／調整負額／基準0／合計／safe版overflow、Expense前後Pair・旧額・版拒否、旧Root非変更 | Receipt／Expense版上限、別Expense／異Group／異Pair／旧額／入力copy、固定typed Error |
| IA5 | POST: 同原額は全条件検証後sameRoot、旧期待版の再入力は拒否 | 妥当／非資格／不正理由・合計no-op、stale入力、Date／Case mutationとfreeze |
| IA6 | Application PRE: 実本人性・現在Owner・Active Group／Closing fence、実Source／初選択／全Case currentness・全Expense版、共通commit／rollback／durable再送／保護保存 | 今回は未接続。純計算成功／DTO／版比較を本番認可・保存先着・再送成立の証拠にしない |

主Testは`apps/api/src/expense-recording/domain/receipt-item-amount-correction.spec.ts`。実CaseはTestだけで使用し、ProductionはSettlement Entity／Repository／型へ依存しない。既存Receipt、Adjustment、Bundle、Category、Expense、Settlement、architectureを回帰する。

## 後続接続と文書

CallerはReceiptとすべての影響Expenseを同判断点で取得し、反映成功した全候補とCase版fence／初選択裁定を共通atomic commitへ束縛する。候補の一部だけを保存しない。共通保存単位・lock順・CAS／durable結果／保護Record／Key／Audit／Retention／月次Projection／公開API／UI／OCRは後続Gate。金融値・Actor・理由をplaintext Storage／Logへ書かない。歴史Snapshotのcopy容量・CPUは公開保存前に評価する。

関連契約、ADR170／179・design-gates・Inventoryへ実装Traceを同期する。Product Rule／所有／Context mapは維持しcurrent-model／正式図は更新不要。SDL／生成型／DB Schema／Migration／Runbook変更なし。対象DB／Browser業務E2Eは未接続で対象外、CI既存PostgreSQL／Web入口回帰と区別する。RollbackはPR revert。Accepted Decision・認証Provider・公開経路Readyを変更しない。
