# ドメイン設計ルール

Domain Modelなどの正式な図は[図の管理ルール](diagram-governance.md)に従い、`docs/diagrams/*.mermaid.md`へ記録する。文章のAccepted DecisionとInvariantを図より優先し、未承認の概念や境界を確定表現で追加しない。

## 目的とKnowledge State

DDDは、共有割り勘の業務RuleをDB、Prisma、GraphQL、Honoの都合ではなく、ユビキタス言語とDomain Modelで表現するために使う。EntityやRepositoryを置くこと自体を目的にしない。

この文書は実装時の設計ルールであり、業務仕様の正本ではない。業務概念と不変条件は[現行Product Scope・業務モデル](../product/current-model.md)のConfirmed Decisionsを正本とする。

- Confirmed: 共有GroupのProduct Scope、主要Concept、GitHubで確認済みのBusiness Rule／Invariant
- Accepted Architecture: [ADR #24](../adr/shared-expense-domain-boundaries.md)の3 Context、MVP Modular Monolith、State model＋不変業務履歴、Command／Query責務分離
- Pending Decision: Aggregate境界、個別Data Owner、Port契約、Persistence詳細、非同期Projection。条件C1は未充足で依存実装Ready不可
- Deprecated: 個人用Household、Account、収入Transaction、日付境界Archive、2人限定の単一Payer／Payeeモデル

Pending Decisionを採用済みとみなしてDirectory、Schema、Event、Repositoryを作らない。関連ADRがAcceptedとなり、仕様とRepository実装が整合するまで実装Readyへ進めない。

## 現行ScopeとCore Domain

- Productは1〜4人のParticipantで構成するGroup内の共有割り勘を扱う。
- 個人だけの収入・支出管理、金融口座、アプリ内送金は扱わない。
- Core Domainは、Group ExpenseへParticipant別の負担割合を定め、Group全体で残高を相殺し、誰が誰へいくら支払うかと支払確認を追跡すること。
- Receipt ItemのCategory分類と購入月の集計、Settlement Archiveの完了月表示、Group終了後のRetentionを扱う。

## ユビキタス言語

実装、Test、Schema、PRではGitHubの[用語定義](../product/current-model.md)に合わせる。

| Term | 意味 |
| --- | --- |
| Group | 共有割り勘Dataの境界。1〜4人で構成し、個人収支を持たない |
| Participant | Groupへ参加して共有支出・精算を扱う主体 |
| Group Owner | ActiveなGroupに必ず1人いる管理者 |
| Group Expense | 実支払者とSplit Allocationを持つ共有支出 |
| Split Allocation | Participant別の10%単位の負担割合。0%可、合計100% |
| Participant Balance | 実支払額合計から負担額合計を引いた値。Group合計は0円 |
| Settlement Case | 同じ対象Expense ID集合を却下・訂正・再申請にわたり追跡する単位 |
| Snapshot Revision | Expense内容、Balance、Payment Instruction候補、必要承認者を固定した不変の版 |
| Payment Instruction | 全必要承認者の承認後に有効になる支払指示 |
| Payment Attempt | 支払報告、受取確認・差し戻し、再試行の履歴 |
| Settlement Archive | 全受取確認後に月別参照可能かつ編集不可になったSnapshot |
| Receipt Draft | Uploaderだけが確認・編集でき、確定前は共有・集計・精算へ含めないReceipt候補 |
| Withdrawn | Awaiting ApprovalまたはRejectedの精算前Caseを理由付きで取り下げ、Expense全件を解放した終端状態 |
| Cancellation Pending | Payment Attempt開始前の取消について必要承認者の同意を待つ状態 |
| Cancelled | 必要承認者全員の取消同意によりExpense全件を解放した終端状態 |
| No Payment Required | Balanceが全員0円で、全員承認後に支払なしでArchiveする結果 |

`Household`、`Transaction`、`Member`を現行概念の同義語として機械的に使わない。Migrationや旧履歴を説明する場合は、Deprecatedな旧語であることを明示する。

## 確認済みのRuleとInvariant

- ActiveなGroupは1〜4人で、Ownerを常に1人だけ持つ。
- Group ExpenseのSplit Allocationは10%単位、0%可、合計100%とする。
- JPY負担額は最大剰余方式で配賦し、同率時は実支払者、対象外ならGroup参加順で一意に決める。
- Group Expense登録時のParticipant、実支払者、Split Allocation、負担額を過去事実として保持する。途中参加・脱退で書き換えない。
- Settlement Caseの対象Expense ID集合は初回申請で固定し、新Revisionで追加・除外しない。
- Snapshot Revisionは変更・削除しない。必要承認者全員の承認前にPayment Instructionを有効化しない。
- 必要承認者は選択Expenseの実支払者またはSplit Allocationが0%より大きいParticipantからRevision作成時に導出して固定し、Awaiting Approval中に選び直さない。
- Rejected時だけ、Source OwnerまたはGroup Ownerが同じExpense IDを変更履歴付きで訂正できる。旧Revisionは訂正前の値を保持する。
- 新Revisionは元申請者またはGroup Ownerだけが申請し、必要承認者全員が改めて承認する。
- Awaiting ApprovalまたはRejected Caseの取り下げは元申請者またはGroup Ownerが理由付きでCase全体へ行う。Withdrawは承認成立を意味せず、Payment Instructionを有効化しない。Withdrawn後は同じCaseを再開・再申請せず、Expense全件を別Caseへ解放する。
- 訂正と再申請は期待するCase／Expenseの版が一致する場合だけ成立させ、先に成立した操作を優先し、後続操作を部分反映しない。
- Balanceが全員0円ならPayment Instructionを作らず、通常の必要承認者全員の承認後にPayment Activeを経由せずArchiveする。
- Payment Instructionは全額の支払報告と受取確認を追跡し、差し戻し理由と再試行を履歴として残す。部分支払は許可しない。
- Payment Activeの取消はPayment Attemptが1件もない場合だけ開始でき、必要承認者全員の同意まで支払報告を禁止する。取消成立時はCaseをCancelledとしExpense全件を解放する。
- 全Payment Instructionの受取確認後だけSnapshotをArchiveできる。Archive成立後は取消、再開、訂正を許可せず、MVPでは補正機能を提供しない。
- Receipt Draftは最終編集から30日後、またはGroup終了後の次回Batchで、Draft、OCR結果、Item候補、画像を冪等に削除する。閲覧だけでは期限を延長しない。
- 月別Category集計はAsia/Tokyoの`occurredOn`、Settlement Archiveの所属月はAsia/Tokyoの`archivedAt`で判定する。

Issue #9のDomain Ruleは2026-08-24に確定し、Awaiting ApprovalからのWithdraw Ruleは2026-08-29に追加確認した。3 Contextと保存の基本方針はADR #24で採用した。個別Data Owner、Aggregate、PersistenceとProjection詳細、条件C1は引き続き[設計Gate](../product/design-gates.md)で追跡し、必要なDecisionと条件が揃うまで依存実装Readyへ進めない。

## Modelの選択

### Value Object候補

次を満たす値をValue Object候補として検討する。

- 同一性ではなく値の等価性で比較する。
- Money、OccurredOn、Allocation Rate、Idempotency Keyのように業務上の名前と制約を持つ。
- Immutableとして扱え、生成時に常に妥当な状態だけを作れる。
- Primitiveへ戻す処理は永続化やPresentationなど境界へ限定できる。

MoneyはJPYの1円単位整数で扱う。割合計算へfloating pointを使わず、最大剰余方式とTie-breakを決定的に実装する。

### Entity候補

- Lifecycleを通じた同一性を追跡する業務概念へ使う。
- IDだけのData Holderにせず、状態変更を業務語彙の振る舞いとして表す。
- Prisma ModelやGraphQL TypeをEntityとして再利用しない。
- 現行仕様にConceptがあることだけでEntityまたはAggregateへ確定しない。

### Aggregate候補

Aggregateは同一TransactionでInvariantを守る必要がある最小境界として、次が揃ってから判断する。

- 対象Invariantと整合性要求
- Lifecycleと変更単位
- 同時更新、競合、取消、再試行のRule
- Failure時に一緒にRollbackすべき範囲
- 他Conceptとの参照・所有関係

画面、GraphQL Mutation、Table、既存Classを理由にAggregate境界を決めない。現時点で採用済みAggregate一覧はない。

### Bounded Context

採用するContextはGroup Management、Expense Recording、Settlementである。追加・変更する場合は新しいADRを要する。

同一語の意味、Business Capability、Ruleの所有者、変更理由、Data Ownershipが異なる場合に境界候補を検討する。旧Repositoryにある`Household`、`Account`、`Transaction`、`Settlement`等のContext名をそのまま現行モデルへ持ち込まない。MicroserviceやDirectoryを先に作らず、Accepted ADRでContext Mapと連携契約が確定してから反映する。

## Domain ServiceとPolicy

- 1つのEntity／Value Objectへ自然に属さないStatelessなDomain RuleだけをDomain Service候補とする。
- Aggregateを跨ぐRule、認可、Read Model導出、Application Coordinationを1つのDomain Serviceへ集約しない。
- Group全体の相殺とPayment Instruction導出は、具体例、決定性、計算量、整合性境界を確認して配置を決める。
- Participant、Category、Receipt、Settlement間の所有権は未確定であり、Application層やPortへ仮置きして既成事実化しない。

## Eventと永続化

ADR #24ではState model＋必要な不変業務履歴とCommand／Query責務分離を採用し、全面Event Sourcingは初期採用しない。個別のProjection、Outbox、Snapshot保存設計は未決で、条件C1を維持する。旧ADRの「TransactionとSettlementだけ」を現行モデルへ適用しない。

Accepted ADRでEvent Sourcingを採用する場合も、次を守る。

- Domain Event、Stored Event、Integration Event、Audit Log、Outbox Messageを別概念として扱う。
- Eventは既に起きた業務上の事実を過去形で表し、Immutableな非機密Dataだけを持つ。
- `decide`はI/Oを行わず、Event適用は決定的にする。
- Event Schema変更へVersionと互換性方針を持たせる。
- 技術的Snapshotを、業務上のSnapshot Revisionと混同しない。
- Event、Snapshot、Outbox、Logへ機密平文を保存しない。

## 設計レビュー

実装前に次を答えられること。

- 対象RuleがRepository仕様のどの現行節に根拠を持つか。
- 旧語・旧Scope・未確定Decisionを現行仕様として混入させていないか。
- Data Owner、Aggregate、Context、永続化方式はAccepted ADRで確定しているか。
- RuleはAggregate内Invariant、Aggregate間Policy、認可、Application Coordination、Read Model、Presentationのどれか。
- 同時更新、二重送信、却下、再申請、差し戻し、再試行、Archive、RetentionでInvariantが守られるか。
- Security、Audit、物理削除、再構築へどんな影響があるか。

## 参照元

- [Requirement・Scope](../product/current-model.md)
- [業務内容・業務ルール](../product/current-model.md)
- [用語定義](../product/current-model.md)
- [ドメイン設計](../product/current-model.md)
- [Accepted Product Decision](../governance/README.md)
- [未確定事項・Documentation Conflict](../product/design-gates.md)
