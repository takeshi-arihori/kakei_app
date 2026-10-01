# 精算Caseの再申請と理由付き全体取り下げ

[Task #162](https://github.com/takeshi-arihori/kakei_app/issues/162)の純Domain契約。[現行モデル](../product/current-model.md)のApproval・Revision、Confirmed Withdraw、Issue #9の先着競合・履歴保持を根拠とする。[ADR #152](../adr/expense-settlement-consistency-boundary.md)のCase Rootと不変Revisionを維持し、[初回承認契約](settlement-case-approval-contract.md)を拡張する。

## 境界と内部事実

Caseは初回対象Expense集合・Case ID・元申請者を維持し、全RevisionとSnapshot別のApprovalを保持する。`snapshot`は最新内容、`revisions`は全不変内容、`approvals`は全判断履歴、`currentRevisionApprovals`は最新参照だけの判断を表す。旧承認や却下を削除せず、新版の全員一致判定へ流用しない。最新Revisionの状態とCaseの終端を分け、Withdrawによって内容の承認成立を作らない。

再申請と取り下げは、元申請者または現在Group Ownerだけという既存Confirmed Ruleを純比較で守る。入力の`applicant.actorSubject`と`currentOwnerSubject`は、Applicationが本人性・同一Group・同一判断点で解決するtrusted facts。元申請者のstable subjectとParticipantの寿命を区別する。元申請者がLeftでも資格は残り、Rejoinedの新Participant IDを旧承認者へ置換しない。

この内部型をClient role proof、公開Context間Port署名、採用済み認可Providerとして扱わない。currentOwner factの真実性はこの比較で証明できない。具体Owner照会／認可Port・lock・Group fence・期待Expense版・Source取得・予約解放とCase更新の共通atomic commit・operation結果再送は後続Application／各Owner Adapterで設計・検証する。他Context Entity／Repository／Table／Domain型は参照しない。

## 契約とTest Trace

| ID | 条件と責務 | 観測するTest／Verification |
| --- | --- | --- |
| SCR-PRE1 | Applicationが本人性・Actor→対象Group Participantの束縛、同時点current Owner、Source Owner／OwnerによるER訂正と履歴、正しい訂正済み配賦、fence・期待Expense版・予約状態・atomic commit・保存CAS・ID新規発番を確認 | 未接続Gate。純factory／trusted facts／期待版Guardを実Adapter証拠にしない |
| SCR-PRE2 | resubmitはRejected、withdrawはAwaitingApproval／Rejected。期待Case版・現在Snapshot一致、stable本人は元申請者またはcurrentOwner subjectと一致 | 不要Actor／旧Owner／SourceOwnerだけは拒否、元申請者Left／Owner譲渡／再参加、状態・期待版・現参照Guard |
| SCR-INV1 | Case ID・初回Group／対象ID集合・元申請者不変。旧内容・全Approval・却下理由を残す | 3版chain、Group違い・対象追加／除外／後発／全置換拒否、順不同Source同集合、nested input/output mutation |
| SCR-POST1 | 訂正済みContentの不変新版をappend。ordinal+1／previousSnapshotId／実申請者／UTC固定。新版承認は旧結果を継承せず、必要申請者だけ自己承認。全員一致／全0直接Archiveは初回契約を再利用 | 旧R1承認とR2Owner自己承認を区別、R2必要集合再固定、旧ID／新ID本人責務非混同、R2全0承認待ち→直接Archive、指示は新版ID／額 |
| SCR-POST2 | 理由・実操作者・UTC・現在Snapshotを記録しCaseをWithdrawn終端にする。全履歴保持、指示非有効、最新Revisionは元の判断状態。固定対象全件を解放すべき結果にする | 部分承認中／Rejected／新版後双方、複数対象全件、2Revisionと全判断・却下保持、自己承認成立にしない、元Root不変 |
| SCR-FAIL1 | 無効な資格・状態・版・参照・Group・固定集合・再利用ID・内容・理由・時刻をtyped拒否、元Rootは不変。Withdrawnは再開／再申請／追加判断／再Withdraw不可、Approved／PaymentActive／ArchivedのWithdraw不可 | 下記追加9分類と初回分類継承、終端／古い版・過去Snapshot判断、二重判断、不変性 |

Test正本は`apps/api/src/settlement/domain/settlement-case-revision.spec.ts`。初回53件も維持し、旧内容と判断のRuntime freezeを検証する。業務条件はcurrent-model Confirmed、Root所有はADR152 Accepted、型／UUID／UTC／immutable transitionは内部実装制約。

## 再申請

CallerがSourceから取得した訂正済みContentを渡し、Caseが同じGroup・同じ対象Expense ID集合を照合する。Content／solverを再利用して新版に必要承認者・残高・候補を固定し、現在membershipへ置換しない。元Expenseの購入日・額・payer・割合・Participant固定や訂正履歴の正しさはERと後続Source契約の責務。本Taskは元Expense訂正を実装せず、RootへのContent入力だけで訂正権限・履歴の完成を主張しない。

各新版は新canonical Snapshot IDと候補順の新指示IDを持つ。Case内の旧Snapshot参照と全指示IDの再利用を拒否する。初回と同じID・候補数・コピー検証を再利用し、IDのRandom／グローバル新規性／DB Uniqueは後続PRE。旧候補を実行可能な指示として扱わない。

旧版は不変なまま、ordinalとpreviousSnapshotIdで同じCaseの直前版へ連鎖する。Caseの元申請者は最初の実申請者を維持し、新版の実申請者がOwnerへ変わっても上書きしない。新版の申請者が旧必要承認者と同じでも、新版に属する承認を新しく記録する。

## 取り下げと解放判断

`withdraw`は部分Expense集合を受け取らず、Case全体だけを取り下げる。`withdrawal`へ理由・実操作者subject／Participant・UTC時刻・現在Snapshotをcopy/freezeする。本Taskで追加した`expenseIdsToRelease`はWithdrawn時に初回固定集合全件を返す。[Task166の取消契約](settlement-cancellation-contract.md)でCancelled時も全件へ拡張し、それ以外は不変空配列とする。これは解放すべき判断であり実予約が解放済みの証拠ではない。

Application／ER Adapterはこの全集合とCase終端をADR152の同じcommit境界で確定し、最新の訂正済みExpenseを別Caseへ解放する必要がある。中途半端な解放やRootだけの保存を許さない。予約／版／失敗・故障注入・実際の別Case選択は後続検証。

Withdrawnは終端として同じCaseを再申請・再開せず、全SnapshotとApproval／却下を残す。WithdrawalはApprovalではなく、最新RevisionのAwaitingApprovalまたはRejectedという元の判断状態を保持する。Payment Active以降は別Cancellation Rule、Attemptの純DomainはTask164、取消は[Task166](settlement-cancellation-contract.md)の別契約。

## 拒否・競合・接続前Gate

既存15分類に次の9分類を追加する。messageは固定で入力額・参照・理由を含めず、公開Errorへ直接露出させない。

| Code | 条件 |
| --- | --- |
| CASE_NOT_REJECTED / CASE_CANNOT_BE_WITHDRAWN | 操作が許可されない現在状態 |
| CURRENT_OWNER_SUBJECT_EMPTY | trusted Owner主体参照が空／空白／文字列以外 |
| ACTOR_NOT_CASE_APPLICANT_OR_OWNER | 元申請者にも現在Ownerにも一致しない安定主体 |
| REVISION_GROUP_MISMATCH / TARGET_EXPENSE_SET_MISMATCH | 初回Groupまたは固定対象ID集合が異なる新版 |
| SNAPSHOT_ID_REUSED / INSTRUCTION_ID_REUSED | Case内の旧版または指示参照の再利用 |
| WITHDRAWAL_REASON_EMPTY | 空／空白／文字列以外の取り下げ理由 |

期待版／現在Snapshotは初回のCASE_VERSION_CONFLICT／SNAPSHOT_MISMATCHを再利用する。初回／新版の各判断は現在Revisionだけを対象にし、旧版判断や旧承認の流用を拒否する。

同じCase版から再申請RootとWithdrawn Rootを生成すること自体は純Domainで可能であり、保存の先着は決めない。Case／Expense期待版確認と共通commitで先に成立した操作を採用し、後続は全rollbackとして拒否する実証拠を要する。Domainで同操作を再投入すれば状態／版／再利用ID等で拒否し、operation再送キーによる元結果返却は後続G1/G2。ローカルGuardだけで並行原子性・二重訂正なしを主張しない。

Case履歴のcopy／read費用はRevisionと判断数に比例して増える。公開保存前に実履歴規模・CPU／timeout／容量／CAS戦略を評価する。既存最少solverの指数Costとhistorical union人数も別に評価し、fixture数やJS安全整数の技術限界をProduct上限にしない。

[正式なpre-payment部分図](../diagrams/settlement-case-revision-lifecycle.mermaid.md)を追加し、[初回図](../diagrams/settlement-initial-approval.mermaid.md)の目的は維持する。既存Rule／Owner境界を実装しcurrent-model／ADR／既存Contextmapを変更しない。公開Schema／DB／Migration／UI／Key／Audit／Runbookに接続せず更新不要。ADR55の保護・Retentionは維持、Domain plaintextをDB／Logへ直接保存しない。未接続CodeのrevertでRollback、Data変更なし。

[Task164の支払Attempt契約](settlement-payment-attempt-contract.md)は新版の全員承認後も固定内容と旧判断を保持する。新版を支払段階で作り直さず、全受取ArchiveとNo Payment Requiredを区別する。[Task166の全体取消契約](settlement-cancellation-contract.md)は明示全員同意とCancelled終端を追加する。実予約解放・保存の未接続Gateは維持する。
