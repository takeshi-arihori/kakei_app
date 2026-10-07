# Receipt Draft手動確定契約

Task [#177](https://github.com/takeshi-arihori/kakei_app/issues/177)の純Domain契約。[現行Product Model](../product/current-model.md)のReceipt R01–R06、[Inventory](../product/mvp-web-expense-receipt-category-inventory.md)、[ADR #170](../adr/receipt-category-consistency-boundary.md)、[Receipt Adjustment配賦契約](receipt-adjustment-allocation-contract.md)に従う。

## 所有と事実境界

Expense Recordingの`Receipt` Rootは、同じReceipt IDのままDraftからConfirmedへ一方向に遷移する。DraftはUploader／Categoryの未確定候補を保持する。現在のCandidate値をConfirmed扱いせず、Confirm呼出しはUploaderが手動確認したItem facts、Adjustment facts、購入日、宣言Receipt合計を明示して渡す。値が変更・削除されたAdjustmentも、確認入力に含まれない限り確定されない。

Callerが渡すReceipt IDとstable Uploader Subjectは内部factsであり、ここでは発番、実本人性、Group資格、Closing fence、DB一意性を証明しない。Domain内のActorとUploaderの値一致は内部Invariantに限る。将来のApplicationが、同判断点のSourceから本人性・Group状態を確認した後に操作する。Category IDは各Itemに保持するが、同時点のActive状態やCategory版照合はApplication Gateのままとする。

## PRE／POST／INV／FAIL

| 契約 | 条件 |
| --- | --- |
| PRE | RootがDraftであり、callerのexpected versionが現在Root versionと一致する。actor Subjectが記録済みUploader Subjectと一致する。これらはDB CASや本番認証を意味しない。 |
| PRE | Confirmは明示的な手動確認済みItem／Adjustment facts、実在する`YYYY-MM-DD`購入暦日、宣言Receipt合計、有限UTC操作時刻を含む。Draft候補値だけでConfirmしない。 |
| POST | 成功すると同じReceipt IDの新RootがConfirmedとなり、内部versionを1つ進め、旧Draftと新Confirmedの不変before／after履歴を追記する。 |
| POST | #175の整数配賦で求めた調整後Item合計が宣言Receipt合計と一致する。Item記載順、Category参照、確認済みAdjustmentを保持し、各Itemに調整前後の金額を残す。 |
| INV | Root、Snapshot、Item、Adjustment、配賦結果、履歴は不変。Confirm後のRootは再遷移できず、旧Draftも変化しない。旧Draftから新版を再計算できても純Domain結果にすぎず、保存一意性はCASを含む別Gateである。 |
| FAIL | 日付、Item facts、Category参照、Adjustment、金額が不正、合計不一致、actor不一致、expected version不一致、または既にConfirmedの場合は固定codeの`ReceiptInvariantViolation`で全体を拒否し、新Root／部分結果を返さない。 |

JPYは非負safe integerとして技術的に表現し、Receipt合計と調整後Item合計はBigIntで比較する。これはProduct上限額ではない。Item名はstring factを保持し、このTaskで空白、文字数、Unicode、正規化、名称重複のRuleを追加しない。購入日は既存`OccurredOn`のGregorian暦日検証を再利用し、Upload／Confirm Timestampから推定しない。

## 履歴と版

Draft factoryは内部RootとしてCandidate factsをcopy／freezeする。Confirm成功は`Confirmed`履歴を追加し、actor Subject、UTC操作時刻、変更前後Root snapshot、遷移前後versionを保持する。初期versionやEvent表現はProduct／ADRの追加Decisionとして固定せず、Repositoryの既存Domain慣例に沿う。履歴は業務上のRoot遷移であり、Event Sourcing、Audit Log、保護済みStorage Schemaではない。

新Rootは外側の保存CASを代替しない。古いDB versionの先着検出、操作再送、永続履歴は未接続である。

## 後続Gate

この契約はConfirmed Rootを純Domainで作る条件であり、Application/APIの完了や他利用者への公開を意味しない。次の事項は別Task／Decisionに残す。

- 認証Providerからの実Actor Subject、現在Uploader資格、Group Active／Closing fenceの同時検証
- CategoryのSource Active状態・版とReceipt確定の同時点照合
- Receipt RootのPersistence、保護Record kind／Schema、CAS、operation再送と結果照会
- OCR／画像Storage、候補抽出と障害・Retry、Retention／削除
- Expense Bundleの初回Item割当と完了照会は[初回登録契約](receipt-bundle-registration-contract.md)へ具体化。1BundleとGroup Expense登録の実原子性、全登録完了前の実月次非包含は後続Gate
- 公開API／Error、確定後編集、画像閲覧、Suggestion、Projection

## Test Trace

`apps/api/src/expense-recording/domain/receipt.spec.ts`はDraft→Confirmed同一ID、版・履歴、明示されたItem／Adjustment確認値、Adjustment変更・削除、合計一致／不一致、購入日、Actor／期待版／状態失敗、深い不変性、旧Root非変更を検証する。API architecture testはDomainの依存方向を検証する。Domain成功だけでは実認可・保存・共有を主張しない。

## 登録済みItem Category訂正の純Domain trace（2026-10-05）

[Task #190](https://github.com/takeshi-arihori/kakei_app/issues/190)の[Category訂正契約](receipt-item-category-correction-contract.md)は、Uploaderまたは現在Group Ownerが登録済みConfirmed Item一件のCategoryだけを訂正し、同ID・金融値・Bundle対応・初選択・旧Snapshot・全履歴を保持する。対象Itemに対応するExpenseが未選択なら編集可能、初選択後は同判断点の関連CaseがRejectedの場合だけ許可する。他Bundleの状態を対象へ流用せず、所属／payer／割合の永久固定を解除しない。同Categoryでも条件を検証したsameRoot no-op。実Category Active／Group適合・Source現在版／本人性・Closing、訂正と初選択／再申請の保存裁定・CAS／再送、金額／Adjustment訂正、月次Projection／公開API／画面は後続Gate。Accepted Decisionと公開Readyを変更しない。


## 登録済みItem原額訂正とExpense反映の純Domain trace（2026-10-06）

[Task #192](https://github.com/takeshi-arihori/kakei_app/issues/192)の[原額訂正・財務反映契約](receipt-item-amount-correction-contract.md)は、Uploaderまたは現在Group Ownerが登録済みItem一件の原額を理由付き訂正し、既存Adjustment再配賦で影響する全Bundleの未選択／Rejected条件を検証する。各既存Expense ID・登録集合／payer／割合・初回事実・全履歴と旧精算Revisionを維持して額・負担へ反映する。Bundle永久lockを解除しない。Adjustment自体の編集、Draft／一般編集、実Source・認可／Group fence、全影響Root共通保存／CAS／再送、保護保存／Projection／API／画面は後続Gate。純Domain成功を実保存や公開Readyの証拠にしない。

## 既存Adjustment金額訂正の実装trace（2026-10-06）

[Task #194](https://github.com/takeshi-arihori/kakei_app/issues/194)の[Adjustment金額訂正契約](receipt-adjustment-amount-correction-contract.md)は、既存一件の額訂正と全再配賦、影響する登録Bundleの未選択／Rejected条件、同Expense IDの額・負担・不変履歴を純Domainで扱う。原額・Category・Pair／初選択永久lock・現在payer／割合・旧精算Snapshot・全既存履歴を維持する。既存の原額／割合／Item移動／手入力訂正も新Adjustment履歴を保持する。追加／削除・種別／適用先変更、Draft／一般編集、実Source・認可／Group fence・原子的保存／再送／保護保存、Projection／API／画面は後続Gate。Accepted本文・承認履歴・公開Ready状態を変更しない。

## Receipt Draft編集の純Domain trace（2026-10-07）

[Task #200](https://github.com/takeshi-arihori/kakei_app/issues/200)の[Draft編集契約](receipt-draft-edit-contract.md)は、Uploaderだけが確定前の購入日・宣言合計・Item／Adjustment候補を置換し、同Receipt ID・Uploader・Draftと不変前後履歴を維持する。内容・順序が変わる場合だけ版を進め、全条件を満たす同値操作と閲覧で編集時刻を増やさない。未完成候補を自動確定せず、最新期待版の明示確認と既存Validation・全編集履歴を維持する。実本人性・Group／Category Source、保存CAS／再送／保護保存、Draft30日の期限・削除実行、OCR／画像、公開API／画面／Projection、Confirmed／未割当一般編集・Adjustment構造訂正は後続Gate。Accepted本文・承認履歴・公開Ready状態を変更しない。
