# 共有割り勘モデルの設計境界検討

- Knowledge State: 比較検討の履歴（2026-09-06にA／E1の基本方針を条件付き採用。個別境界は候補）
- Related Task: [GitHub Issue #9](https://github.com/takeshi-arihori/kakei_app/issues/9)
- Decision: [共有割り勘の設計境界と永続化方針](../adr/shared-expense-domain-boundaries.md)
- Confirmed source: [現行Product Scope・業務モデル](../product/current-model.md)
- Last reviewed: 2026-09-06

この文書は提案時の比較検討を保持する。採用内容の正本はADR #24で、3 ContextとE1の基本方針のみ条件付きAcceptedとなった。表の個別Data Owner、Aggregate、Port等は採用済みではない。`Confirmed`は現行仕様からの転記、`Proposed`は比較対象、`Open Question`は判断が必要な事項を表す。

## System Context

### Confirmed

共有割り勘Systemは、1〜4人のParticipantが属するGroupについて、共有支出の記録、割合配賦、Group全体の精算、支払報告と受取確認、Receipt分類、月別参照、CSV出力、Group終了後の保持期限を扱う。利用者はSystem外で実際の送金を行う。OCR Service、Object Storage、定期Batchの製品・配置・契約は未確定である。

| Actor／外部要素 | Systemとの関係 | 現在の制約 |
| --- | --- | --- |
| Participant | Group Expense登録、精算申請、承認・却下 | ActiveなGroupは1〜4人。権限はGroup内の役割と過去時点の関係で判定する |
| Group Owner | 招待、Owner譲渡、Group終了、CSV出力、特定の訂正・取消 | ActiveなGroupに常に1人だけ |
| 支払側Participant | Payment Instructionの全額支払を報告 | アプリ内送金は行わない。部分支払はMVP対象外 |
| 受取側Participant | 受取確認または理由付き差し戻し | 差し戻し後は同じInstructionへ新しいAttemptを追加する |
| OCR Service候補 | Receipt画像からItem候補を返す | Service、契約、再試行方式は未決。Draft確定前は共有Dataにしない |
| Retention Batch候補 | Draft、Group Data、Tombstoneの期限削除 | 冪等、再実行可能、一部失敗を次回再試行する |

## Confirmed RuleのTrace

| Concept | Confirmed Rule／Invariant | 設計判断への入力 |
| --- | --- | --- |
| Group／Participant | ActiveなGroupは1〜4人でOwnerが常に1人。Membershipの参加・脱退履歴を残す | MembershipとOwner譲渡は同じ整合性境界の候補。過去のExpense事実はMembership変更で書き換えない |
| Group Expense／Split Allocation | JPY整数、割合は10%単位で合計100%。負担額は最大剰余方式とTie-breakで一意 | Expense登録時にAllocation全体を検証する。計算は決定的でなければならない |
| Receipt／Category | DraftはUploaderだけが扱い、確定前は共有・集計・精算へ含めない。Categoryの履歴とGroup内学習Ruleを持つ | Receipt Draftの一時Dataと確定ExpenseはLifecycleが異なる。Category変更は過去明細を消さない |
| Settlement Case | 初回申請時のExpense ID集合を固定し、Withdrawn／Cancelled後までCaseを追跡 | CaseのLifecycleと対象集合は同時に守る候補。Expense本体はCaseに複製せずIDとRevision内の事実を固定する候補 |
| Snapshot Revision | Expense内容、Balance、Instruction候補、必要承認者を不変に固定。Rejected後は新Revision | 業務上の不変記録であり、Event Storeの技術Snapshotとは別概念。保存必須情報とSnapshotへの機密平文禁止の解釈は下記Conflictとして判断が必要 |
| Payment Instruction／Attempt | 全承認後だけInstructionを有効化。Attemptは差し戻しと再試行履歴を残し、部分支払を許可しない | InstructionとAttemptの状態遷移はSettlementの整合性境界候補。外部送金のData Ownerではない |
| Settlement Archive | 全受取確認後またはNo Payment Required成立時だけArchiveし、以後編集しない | ArchiveはSettlement Lifecycleの終端。月別参照は派生Query候補 |
| Retention／Export | Archive済みGroupを1暦年保持後に冪等削除。CSVは要求時生成し永続保存しない | 削除のSource Data OwnerとProjection削除を調整するPortが必要。Tombstoneに識別情報を含めない |

## 代表Use Caseと具体例

すべて架空のActorと金額を用いる。

| 種別 | 具体例 | 守るInvariant／観測結果 |
| --- | --- | --- |
| 正常 | Aが1,001円を支払い、A 50%、B 50%で登録する | A 501円、B 500円となる。割合合計100%、負担額合計1,001円 |
| 正常 | A、B、CのExpenseを選択してCase R1を申請し、全必要承認者が承認する | 選択Expense ID集合とRevision内容が固定され、決定的なInstructionだけが有効になる |
| 境界 | AとBが各1,000円を立て替え、双方50%を負担する | Balanceが全員0円。Instructionを作らず、全承認後に直接Archiveする |
| 境界 | BがGroup参加後、参加前のExpenseを参照する | Bを既存Allocationへ自動追加しない。登録時Participantと負担額を維持する |
| 失敗 | 割合合計が90%のExpense登録を送る | Group Expenseを作らず、部分的なAllocationも残さない |
| 失敗 | Payment AttemptがあるCaseの取消を要求する | 取消を拒否し、CaseとInstructionの現行状態を維持する |
| 競合 | Rejected Expenseの訂正と旧版からの再申請が並行する | 期待するCase／Expense版が一致した先行操作だけ成立し、後続は部分反映せず競合となる |
| 競合 | 最後の受取確認と二重送信が並行する | 同一操作を冪等に扱い、ArchiveとAttemptを重複作成しない |
| 再試行 | 差し戻されたInstructionへ支払者が再報告する | 同じInstructionへ新しいAttemptを追加し、以前のAttemptと理由を保持する |
| 再試行 | Retention Batchが一部削除後に失敗する | 再実行で削除済み対象を安全に無視し、未削除対象を処理する |

## Bounded Context候補

### Option A: 3つのBusiness Capabilityへ分ける（Proposed recommendation）

| Context候補 | Data Owner候補 | Aggregate候補 | 公開するID／Port／契約候補 |
| --- | --- | --- | --- |
| Group Management | Group、Membership、Invitation、Group Category定義、終了・保持期限 | Group（Owner、Membership、Lifecycle）、CategoryまたはGroup配下のCategory Registry | `GroupId`、`ParticipantId`、active membership照会、権限照会、Group終了通知候補 |
| Expense Recording | Group Expense、Split Allocation、Receipt Draft、Receipt Item、訂正履歴、Category suggestion | GroupExpense（Allocationを含む）、ReceiptDraft、Category Suggestion Rule候補 | `ExpenseId`、Expense fact取得Port、精算への選択可否、確定Expense通知候補 |
| Settlement | Settlement Case、Snapshot Revision、Approval、Payment Instruction、Payment Attempt、Settlement Archive | SettlementCase（Revision・Approval・Instruction・AttemptのLifecycleを調整） | `SettlementCaseId`、`SnapshotRevisionId`、選択Expense予約／解放Port、Archive fact候補 |

月別Category支出、Archive一覧、CSV Exportは上記OwnerのDataをQuery用に組み立てるApplication／Projection候補とし、最初から第4のData Ownerにはしない。物理配置は同一Process・同一Databaseを許容し、論理境界の採用とMicroservice化を結び付けない。

利点は、Membership、Expense、Settlementの変更理由を分離しつつ、MVPで境界数を抑えられること。欠点は、CategoryのOwner、ExpenseのCase予約、Group一括削除についてContext間契約を設計する必要があること。

### Option B: 単一Shared Expense Context

GroupからSettlement、Receiptまでを1つのContextで管理する。初期のApplication CoordinationとTransactionは単純だが、Group Lifecycle、OCR Draft、精算承認、Retentionという異なる変更理由が同じModelへ集まりやすい。将来分割時のData Ownerと公開契約が曖昧になる。

### Option C: 5つ以上の細粒度Context

Group、Expense、Receipt、Settlement、Reporting／Retentionを別Contextとする。Data Ownerと独立Scalingは明確になるが、1〜4人向けMVPに対して契約、失敗処理、運用、整合性確認のCostが大きい。OCRやReportingの独立した変更頻度・Team・非機能要件が確認できるまで過剰となる可能性が高い。

## Aggregateと整合性境界の比較

| Invariant | 同一Transaction候補 | Context間の調整候補 | 失敗・競合の扱い |
| --- | --- | --- | --- |
| Active GroupのOwnerは1人 | Group + active Membership | なし | Owner譲渡と旧Owner脱退を1操作として版競合検査 |
| Allocation合計100%、金額合計一致 | GroupExpense + Split Allocation | active membershipは登録時に照会しIDを固定 | 生成前検証。途中保存を公開Expenseにしない |
| CaseのExpense集合固定と二重選択防止 | SettlementCase内のID集合 | Expense側の予約／解放Portまたは一意制約 | idempotency keyと期待版。部分予約は補償または同一DB transaction候補 |
| Revision不変、承認者固定 | SettlementCase + SnapshotRevision + Approval | Expense factをRevision作成時にCopy | 新Revisionを追加し、旧Revisionを更新しない |
| 全承認前に支払を有効化しない | SettlementCase内のApproval／Instruction | なし | 最後の承認と有効化を原子的に処理 |
| 全受取確認後だけArchive | SettlementCase内のInstruction／Attempt | Query ProjectionへArchive factを伝達 | 重複確認を冪等化し、終端遷移を1回だけ成立 |
| Group全体の期限削除 | 各ContextのOwner Data | Retention Coordinator Port候補 | Context単位の冪等削除結果を追跡し、識別情報のないTombstoneだけ保持 |

`SettlementCase`へ全履歴を物理的に内包するか、同一Context内の別Aggregate／append-only recordとして参照するかは、件数、Transaction、Repository実装を測定して決める余地がある。表は業務上の整合性単位を示し、ORMのObject graphを指定しない。

## Event Sourcing、CQRS、Projection候補

| Option | 適用対象／非対象 | 再構築・監査 | 運用CostとRisk |
| --- | --- | --- | --- |
| E1: State model + 必要な履歴Record（Proposed recommendation） | 全Contextを通常の状態永続化。Snapshot Revision、Approval、訂正、Attempt、Tombstoneは仕様どおりimmutable record。Domain Event／Outboxは連携が必要になった箇所だけ | Source stateとimmutable業務履歴を監査。ProjectionはOwner Dataから再作成する契約を個別定義 | Event schema/upcaster不要で初期Costが低い。任意時点再生は限定的。Audit Logと業務履歴を混同しない設計が必要 |
| E2: SettlementだけEvent Sourcing | SettlementCaseの状態遷移をStored Eventから復元。Group、Expense、Receiptはstate model | SettlementはEvent再生、ほかはOwner Dataから再構築。技術Snapshotのversion管理が必要 | 却下・再申請・支払再試行を表現しやすいが、schema version、upcaster、replay test、削除・機密除去が増える |
| E3: 全ContextでEvent Sourcing + CQRS | Group、Expense、Receipt、SettlementをStored Event化しQueryをProjectionへ分離 | 全Read ModelをEventから再構築 | 最も強い履歴性と引き換えに、Projection遅延、削除、schema進化、障害復旧、監視のCostがMVP規模に対して大きい |

E1でもDomain Event、Stored Event、Integration Event、Audit Log、Outbox Messageを区別する。CQRSはCommand/Queryの責務分離をコード上で行うことと、別Store・非同期Projectionを採用することを分けて判断する。月別集計やArchive一覧に専用Projectionを使う場合、Source Owner、更新遅延、checkpoint、再構築開始点、重複適用、削除伝播、監視を契約へ含める。

## 権限、Security、削除への影響

- 認可はPresentationの入力だけで決めず、Group内の現在または過去時点の役割をApplicationがOwner ContextのPortで確認する。
- Receipt DraftとOCR結果はUploader以外へ公開せず、確定後に必要なItemだけを共有Expenseへ変換する。
- Event、技術Snapshot、Outbox、Projection、LogへReceipt画像、OCR全文、氏名、支出説明などの機密平文を複製しない。必要最小限のIDと非機密factを契約ごとに定義する。
- 業務上のSnapshot RevisionにはConfirmed Ruleにより、対象Expense ID、金額、実支払者、割合、負担額、Balance、Instruction候補、必要承認者を固定する必要がある。この必須Dataを無制限に複製せず、Group内の権限確認、Archive後の読み取り専用化、GroupのRetentionと物理削除へ従わせる。暗号化、保管形態、参照契約は後続Security／Persistence設計で決める。
- Group物理削除は全Data OwnerとProjectionへ伝播し、部分失敗を再試行する。Tombstoneへ利用者・金額・支出内容を残さない。
- Public Repositoryには架空例と一般的な設計候補だけを記録する。実在する利用者・金融情報・Secretを含めない。

## Open Questions

1. Group専用CategoryのLifecycleはGroup ManagementとExpense Recordingのどちらが主な変更理由を持つか。
2. ExpenseのSettlement選択予約を同一Database transactionで守るか、Ownerを跨ぐ明示Portと一意制約／補償で守るか。
3. SettlementCase内部でRevision、Approval、Instruction、Attemptを1 Aggregateに保持できる上限と性能要件は何か。
4. OCR Serviceの契約、timeout、再試行、冪等性、画像削除保証をどのTaskで決めるか。
5. 月別Category集計、Settlement Archive一覧、CSV Exportに同期Queryで十分か、非同期Projectionが必要となる量・応答時間は何か。
6. Retention Coordinatorの実行頻度、削除順序、失敗可視化、手動再実行権限をどう定めるか。
7. Architecture不変条件の「Snapshotへ機密平文を保存しない」における`Snapshot`はEvent Store等の技術Snapshotだけを指すか。業務上のSnapshot RevisionがConfirmed Ruleで必要とする金額・Participant情報は、どの最小化、暗号化、認可、保持・削除契約で保存するか。

## Conflict

- 旧個人用Household、Account、収入Transaction、2人限定Payer／Payee、日付境界Archiveは現行Scopeと矛盾するため候補に使用しない。
- `Snapshot Revision`は業務上の不変記録であり、Event Sourcingの技術Snapshotと同義にしない。
- 現行Product Ruleは業務上のSnapshot Revisionへ金額、実支払者、割合、負担額、Balance等を固定する。一方、Architecture不変条件は「Event、Snapshot、Logへ機密平文を保存しない」とする。`Snapshot`の範囲が曖昧なため、必要な業務Dataまで保存禁止とは解釈せず、上記Open Questionを解消してからPersistence実装をReadyにする。
- 既存draw.ioはOwnerの検討用入力であり、この分析の根拠または正本ではない。AIは変更していない。
- ADR #24で採用された基本方針だけを根拠として使用する。個別境界候補と条件C1は未決・未充足のままであり、依存する実装をReadyにしない。
