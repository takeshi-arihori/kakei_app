# 支払開始前の全体取消と明示的な全員同意

[Task #166](https://github.com/takeshi-arihori/kakei_app/issues/166)は[現行モデル](../product/current-model.md)の全体取消を純Domainへ反映する。[ADR #152](../adr/expense-settlement-consistency-boundary.md)のCase Rootが[初回承認](settlement-case-approval-contract.md)、[再申請・取り下げ](settlement-case-revision-contract.md)、[支払Attempt](settlement-payment-attempt-contract.md)に続いて取消全体のInvariantを所有する。

## 所有と不変履歴

Caseは全Revision／Approval／固定指示／PaymentAttemptと取消要求履歴を保持する。`SettlementCancellationRequest`はCase配下のChild Entityで、要求ID・現在Snapshot・要求順・実要求者・理由・UTC・固定必要承認者集合と本人判断を保持する。独立Root／Context／公開DTO／保存Schemaを追加しない。Rootが状態・版・資格・Attempt不在・現在参照・全体対象を検証し、Childが一度だけの本人判断と全員同意を守る。

成功操作は新Rootと新Childを返し、古いRootとnested履歴はcopy/freezeで不変にする。同じ要求への判断はそのEntityの新しい不変状態となり、拒否後の新要求はfresh IDとordinalでappendする。通常Approvalの自己承認を取消の暗黙同意に流用しない。

## 契約とTest Trace

| ID | 条件と責務 | Test／Verification |
| --- | --- | --- |
| SC-PRE1 | Applicationが本人性と同Group過去Participant束縛、同判断点の現在Owner・Group lifecycle／fence、期待Case／Expense版、ID発番、予約解放とCase共通atomic commit／CAS、operation結果再送を検証 | 未接続Gate。内部Actor／Owner factや期待版を認可・保存先着の証拠にしない |
| SC-PRE2 | PaymentActiveのみ、全Attempt履歴0件、元申請者または現在Owner、現在版とSnapshot、非空理由・新canonical要求ID・UTC | 初期状態／未承認／Rejected／Withdrawn／Archived拒否、Left元申請者／Owner交代、Reported／Returned／一部Receivedがあれば拒否 |
| SC-INV1 | 対象・全Revision／Approval・指示ID／相手／額・過去要求と判断不変。必要集合は現在Revision全件、要求者も明示同意が必要 | net 0の必要者を含む全員、Owner代理／再参加新ID拒否、入力とnested出力mutation、通常自己承認と取消の分離 |
| SC-POST1 | 理由付き要求をappend、CancellationPendingで支払禁止、指示内容保持・active指示なし | 要求facts、ordinal、明示同意0件、Approval／Snapshot同一、Pending中報告・追加要求拒否 |
| SC-POST2 | 現在版／Snapshot／要求一致、必要本人未判断のみ。同意は全員前Pending、1人拒否でPaymentActiveへ戻り同じ指示を有効化 | 部分同意、拒否理由必須なし、拒否後支払、新要求に旧同意持越なし、古い要求／二重判断拒否、旧履歴保持 |
| SC-POST3 | 全員同意時のみCancelled終端、cancelledAtは最終同意UTC、全固定Expense ID解放のDomain判断。Archivedではない | 複数対象全件、最終UTCコピー、Approved内容保持、全変更入口拒否、部分解放なし、Group自動終了なし |
| SC-FAIL1 | 状態・資格・Attempt・版・参照・本人・理由・ID・ordinal・集合・Dateはtyped固定messageで拒否、元Root不変 | 下記分類、無効入力、Child直接Invariant、同版の支払／取消代替Rootと実保存競合の区別 |

Testは`apps/api/src/settlement/domain/settlement-cancellation.spec.ts`。既存初回・新版・支払152件を維持する。内部canonical ID、ordinal、Case版、UTCと状態は公開FieldやProduct上限の採用ではない。

## 取消要求と本人判断

`requestCancellation`は元申請者のstable subject、またはApplicationがSourceから取得した現在Ownerとの一致を照合する。要求者が必要承認者以外のOwnerでも要求できるが、必要本人の代わりに同意できない。Leftの旧Participant責務を残し、再参加の新IDへ差し替えない。ClientのOwner申告や任意Participantを信用する認可を実装したものではない。

理由は空／空白／文字列以外を拒否し、元の内容を保持する。要求は全体のみで部分対象入力を受けない。Returnedも含め`paymentAttempts`に1件でもあれば要求を拒否する。差し戻しでAttemptを消したり、支払済みCaseを取消可能にしない。

要求者の同意を自動記録しない。`agreeCancellation`と`declineCancellation`は現在の固定必要本人について一度だけの判断を記録する。拒否理由必須、時刻順、期限、自動取消のRuleは追加しない。現在版・Snapshot・要求IDはRoot、本人と重複はChildが検証する。

## 状態・対象解放・保存境界

Pendingでは支払報告が拒否され、`activePaymentInstructions`は空になる。`paymentInstructions`は保持する承認済み内容の履歴Viewであり、Unpaid表示を実行許可と扱わない。1人の拒否で元の固定指示を同じID／額／相手で再有効にする。次の要求は新IDで旧要求と判断を残し、同意を引き継がない。

全員同意はCaseをCancelledにし、最新RevisionはApprovedのまま保持する。`cancelledAt`は最後の同意操作UTC、`archivedAt`と`archiveReason`はnull。`expenseIdsToRelease`はWithdrawnまたはCancelledで初回固定集合全件を返す。Cancelled後は同じCaseの再開・支払・再申請・取り下げ・追加判断・再取消を拒否し、別Caseでの再選択を必要とする。全0のNoPaymentRequired Archiveは終端のままで取消要求できない。Groupの自動終了はない。[正式部分図](../diagrams/settlement-cancellation-lifecycle.mermaid.md)は取消のみを表す。

この結果は解放すべきDomain判断であり、実予約の解放済み証拠ではない。Application／ER Adapterは全対象の解放とCase終端をADR152の同じatomic commitで保存し、故障時全rollbackとCase／Expense期待版を検証する必要がある。同版から支払RootとPending Rootを個別生成できても、保存の先着や二重成立なしは証明できない。具体Port／lock／公開API／operationキーは今回採用しない。

## 拒否分類と接続前Gate

既存Case分類へ11分類を追加する。固定messageに主体・額・理由・参照を含めず、公開Errorへ直接露出させない。

| Code | 条件 |
| --- | --- |
| CANCELLATION_HAS_ATTEMPTS | Returnedを含むAttempt履歴が1件以上 |
| CANCELLATION_ID_INVALID / CANCELLATION_ID_REUSED | 非canonicalまたはCase内要求ID再利用 |
| CANCELLATION_REASON_EMPTY | 空／空白／文字列以外の要求理由 |
| CANCELLATION_ORDINAL_INVALID / CANCELLATION_APPROVERS_INVALID | Child内部順または非空一意必要集合が不正 |
| CASE_NOT_CANCELLATION_PENDING / CANCELLATION_MISMATCH | 判断不可状態または現在要求外 |
| CANCELLATION_PARTICIPANT_NOT_REQUIRED / CANCELLATION_ALREADY_DECIDED | 固定必要本人以外または同本人の再判断 |
| CANCELLATION_NOT_PENDING | 成立／拒否済みChildへの追加判断 |

要求時のCase状態・版・Snapshot・資格・Dateは既存分類を再利用する。再送した同操作は純Domainでは拒否し、元成功結果の返却は後続operation契約とする。実本人性／Source照会／Group fence／CAS／atomic commit／故障注入／予約解放／保護保存／本番Provider／公開GraphQL／Read Model／UIは未接続。

履歴copy／検索Costは要求数と判断数に応じて増える。公開保存前に実規模・容量・CPU／timeout・CASと既存solver指数Cost Gateを検証する。fixtureと安全整数をProduct上限にしない。ADR55／73の保護・Retentionを維持し、主体・理由・額のplaintextをLog／DBへ直接出さない。

Confirmed RuleとAccepted境界を維持するためcurrent-model／ADR／Contextmapは変更不要。I/O・公開Schema・DB・Migration・UI・運用変更がないため対応文書は更新不要。Data変更はなく、未接続CodeのrevertでRollbackする。
