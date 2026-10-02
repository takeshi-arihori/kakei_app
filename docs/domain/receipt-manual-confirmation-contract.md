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
- Expense BundleのItem割当、1BundleとGroup Expense登録の原子性、全登録完了前の月次非包含
- 公開API／Error、確定後編集、画像閲覧、Suggestion、Projection

## Test Trace

`apps/api/src/expense-recording/domain/receipt.spec.ts`はDraft→Confirmed同一ID、版・履歴、明示されたItem／Adjustment確認値、Adjustment変更・削除、合計一致／不一致、購入日、Actor／期待版／状態失敗、深い不変性、旧Root非変更を検証する。API architecture testはDomainの依存方向を検証する。Domain成功だけでは実認可・保存・共有を主張しない。
