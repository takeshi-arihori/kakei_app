# 固定支払指示への本人報告・受取確認・差し戻し

[Task #164](https://github.com/takeshi-arihori/kakei_app/issues/164)は[現行モデル](../product/current-model.md)の支払確認・差し戻し・再試行と不変Archiveを純Domainへ反映する。[ADR #152](../adr/expense-settlement-consistency-boundary.md)のCase Rootが全指示の完了条件を所有し、[初回承認](settlement-case-approval-contract.md)と[再申請・取り下げ](settlement-case-revision-contract.md)を拡張する。

## 所有と履歴

Case Rootが不変な全Revision／Approval／固定指示と`paymentAttempts`を保持する。`PaymentAttempt`はCase配下のChild Entityで、独立Rootや別Contextではない。報告factは固定し、`confirmReceipt`／`returnPayment`が一度だけの受取側判断を加えた新Entityを返す。過去RootとそのEntityは変更しない。差し戻し後は同じInstructionへの新Attemptをappendし、旧Returned報告と理由を残す。全面Event Sourcing、Outbox、保存Schemaは採用しない。

Rootだけが外部の操作入口となり、現在Case版・Revision・固定指示・最新Attemptを確認し、Childが報告本人・全額・一度だけの受取判断・理由・UTCのInvariantを守る。Child factoryへ渡す指示はRootの固定内容であり、Clientの指示や額を正本にしない。ID／UTC検証はSettlement内の小さいhelperを共用し、他Context共通型へ一般化しない。

## 契約とTest Trace

| ID | 条件と責務 | Test／Verification |
| --- | --- | --- |
| SP-PRE1 | Applicationが本人性とActor→同Group過去Participant束縛、同判断点Group lifecycle／fence、IDRandom新規性、保存CAS／atomic commit／operation再送を検証 | 未接続Gate。内部Participant、Caller時計、期待版Guardを実本人性／保存先着の証拠にしない |
| SP-PRE2 | PaymentActiveのみ、期待Case版・現在Snapshot一致、固定指示所属。報告はpayer、受取判断はpayee本人のみ | 未承認／Rejected／Withdrawn／Archived拒否、Owner／元申請者／他承認者／再参加ID代理拒否、旧Participant責務保持 |
| SP-INV1 | 全Revision／対象／Balance／候補／指示ID・額・相手／Approvalは不変。全額JPY整数以外は拒否 | 0／負／一部／超過／型違い、参照同一性と入力・nested出力mutation、再申請後の新版支払 |
| SP-POST1 | 未報告または最新Returnedの指示へfresh canonical UUIDで新報告、指示内ordinal+1、Revision／指示／本人／全額／reportedAt UTCを固定。Reportedのみでは未完了 | 固定報告factsとUnpaid→Reported、重複報告・ID再利用拒否、複数指示内独立履歴 |
| SP-POST2 | latestReported参照一致とpayee本人の一度だけの判断。Received、または空でない元理由付きReturned。Returned後は同指示へ新Attempt、Snapshotは作り直さない | 本人確認／理由保持、3報告chain、旧／別指示Attempt・再判断・未報告拒否、再参加新ID非混同 |
| SP-POST3 | 全固定指示の最新報告がReceivedのときだけArchived、archivedAtは最後の受取確認UTC。NoPaymentRequiredは承認だけの別結果 | 2指示の段階完了、最終UTCコピー、全0の報告なし、終端全操作拒否、対象は解放しない、Group自動終了なし |
| SP-FAIL1 | 不正状態・版・参照・本人・額・ID・順序・指示・空理由・Dateはtyped固定message、成功失敗とも元Root／履歴不変 | 下記分類、全許可／拒否経路、freeze、同版から生成する代替Rootと実保存先着の区別 |

Testは`apps/api/src/settlement/domain/settlement-payment.spec.ts`。既存初回／再申請99件を維持する。型・canonical UUID・内部ordinal・UTC・不変transitionは実装制約であり、新しいProduct上限・公開Scalarを定義しない。

## 報告と受取判断

`reportPayment`は固定指示の全額を照合し、Case内で未使用のAttempt IDを検証する。報告者は固定payerParticipant、受取判断者は固定payeeParticipantだけ。Leftでも既存旧IDの責務を残し、Rejoinedの新IDを旧指示へ置換しない。Ownerの履歴参照権を本人報告・受取確認の代理権へ拡張しない。ActorとParticipantの実束縛はApplicationのPREである。

報告入力の`amount`は部分支払を拒否する内部assertionで、公開Inputへの採用ではない。`reportedAt`は報告操作のCaller UTC時計、`decidedAt`は受取判断のUTC時計をコピーする。外部送金のpaidAt、証憑、支払手段、通知を追加しない。時刻順の新業務制約も設けない。

受取確認と差し戻しは最新Reported Attemptだけを対象とし、Caseが旧Snapshot・他指示・過去Attemptを拒否する。差し戻しでApprovalをRejectedにしたり、元指示の金額・相手を変更したりしない。旧Returnedは新報告後も理由・時刻を保持する。同じ報告の再送は純Domainでは状態・版等で拒否し、元成功結果を返すoperation契約は後続G1／G2。

## 状態と完了

`paymentInstructions`は承認済み固定指示に現在状態と最新Attempt IDを添えた不変結果を返す。未報告または最新ReturnedならUnpaid、最新ReportedならReported、ReceivedならReceived。Returnedは履歴Entityの状態として残る。未承認Revisionでは空配列で候補を有効な支払義務として扱わない。

1指示の受取だけでは、他の指示が未確認ならPaymentActiveを維持する。全指示の受取でRootがArchivedとなり、`archiveReason`はAllPaymentsReceived、`archivedAt`は最後の受取UTCになる。全0のNoPaymentRequired Archiveは従来どおり、支払報告／受取記録を捏造しない。Archive後は全変更入口が拒否され、候補・履歴は参照できるが指示は再実行不可。Expenseを別Caseへ解放せず、Groupも自動終了しない。

Asia/Tokyoの完了月表示は既存Ruleを維持するが、月別Query／Read Model／UIはこのTaskに含めない。[正式部分図](../diagrams/settlement-payment-lifecycle.mermaid.md)はPaymentだけを表す。[Task166の取消契約](settlement-cancellation-contract.md)が取消要求・同意・拒否を追加し、本履歴から「Attemptが1件もない」を判定する。Returnedを削除して取消可能にすることはできない。

## 拒否分類・接続前Gate

既存Case分類へ13分類を追加する。固定messageに主体・参照・額・理由を含めず、公開Errorへ直接露出させない。

| Code | 条件 |
| --- | --- |
| CASE_NOT_PAYMENT_ACTIVE / INSTRUCTION_NOT_FOUND | 支払不可のCaseまたは固定指示外 |
| ACTOR_NOT_PAYMENT_PAYER / ACTOR_NOT_PAYMENT_PAYEE | 報告／受取判断の固定本人と不一致 |
| PAYMENT_AMOUNT_MISMATCH | 固定指示の正の全額JPY整数に不一致 |
| ATTEMPT_ID_INVALID / ATTEMPT_ID_REUSED | 不正表現またはCase内の報告ID再利用 |
| ATTEMPT_ORDINAL_INVALID / INSTRUCTION_PARTICIPANTS_INVALID | Childの内部順序または固定相手が不正 |
| INSTRUCTION_NOT_UNPAID | 最新Reported／Receivedへの重複報告 |
| ATTEMPT_MISMATCH / ATTEMPT_NOT_REPORTED | 最新報告外、未報告、受取判断済み |
| PAYMENT_RETURN_REASON_EMPTY | 空／空白／文字列以外の差し戻し理由 |

期待版・現在Snapshot・Dateは既存分類を再利用する。同じCase版からReceived RootとReturned Rootを別々に生成できても、実保存は後続CAS／atomic commitで先行成立だけを採用する必要がある。故障注入、operationキーと結果再送、一般支払競合、Group close fence、実認可／Adapter／Source照会、保護Record／Key／Audit／Retention・Backup、公開GraphQL、本番Providerは今回未接続。内部factoryと期待版Guardを本番機能完成の証拠にしない。

Rootの履歴copy／検索はAttempt数に応じて増える。公開保存前に実規模・CPU／timeout／容量／CASを評価し、既存solver指数Cost Gateも維持する。fixtureや安全整数をProduct上限にしない。

Confirmed RuleとAccepted境界を維持し、current-model／ADR／既存Contextmapは変更不要。公開Schema／DB／Migration／UI／Runbookは接続・保存・運用変更がなく更新不要。ADR55／73の保護・Retentionを維持し、Domain plaintextをLog／DBへ直接出さない。未接続CodeのrevertでRollback、Data変更なし。
