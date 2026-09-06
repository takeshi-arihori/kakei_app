# 共有割り勘の設計境界と永続化方針

- Status: Accepted
- Acceptance: 条件付き（C1は未充足）
- Accepted Date: 2026-09-06
- Decision Owner: Project Owner
- Proposed Date: 2026-09-06
- Owner Decision: 案Aを条件付きで採用
- Related Task: [GitHub Issue #9](https://github.com/takeshi-arihori/kakei_app/issues/9)
- Decision record: [GitHub ADR Issue #24](https://github.com/takeshi-arihori/kakei_app/issues/24)
- Analysis: [共有割り勘モデルの設計境界検討](../domain/shared-expense-design-boundaries.md)

## Context

提案時点では、共有割り勘の業務Ruleは[現行Product Scope・業務モデル](../product/current-model.md)でConfirmedになっている。一方、Bounded Context、Aggregate、Data Owner、Context間契約、Event Sourcing／CQRS／Projectionの適用範囲は未確定である。このままDB、API、Directory、Event Schemaを実装すると、実装都合で境界が事実上決まる。

2026-09-06にProject Ownerが案Aの条件付き採用を明示した。以下のDecisionを採用し、未決の詳細と条件C1は後続設計のGateとして維持する。現行のHono／Application／Domainの依存方向、JPY整数、Event、Snapshot、Logへ機密平文を保存しない制約を変更しない。業務上のSnapshot Revisionが保存必須とする金額・Participant情報との解釈差は[分析文書のConflict](../domain/shared-expense-design-boundaries.md#conflict)として残し、Persistence実装前に解消する。

## Decision

案Aとして次の組合せを採用する。

1. Bounded ContextはOption Aの`Group Management`、`Expense Recording`、`Settlement`という3つのBusiness Capabilityで論理的に分ける。
2. 物理配置はMVPでModular Monolithを許容し、Bounded ContextをMicroservice境界と同一視しない。
3. 個別Data OwnerとAggregateは[分析文書](../domain/shared-expense-design-boundaries.md)の候補を検討入力として残し、一括採用しない。Context間はID、Application Port、version付き公開契約だけで連携する。
4. 永続化の基本方針はE1のState model + 仕様で必要なimmutable業務履歴とする。全面的なEvent Sourcingは初期採用しない。個別の保存設計は条件C1を満たしてから実装する。
5. CommandとQueryの責務は分けるが、別Storeや非同期Projectionは月別集計、Archive一覧、CSVの測定された要件が必要とする箇所だけ、後続ADRまたは実装Taskで判断する。
6. Snapshot Revision、Approval、Expense訂正、Payment Attempt、Tombstoneは業務仕様どおり履歴を保持する。これらをStored EventやAudit Logと同一概念にしない。
7. 技術Snapshotへ機密平文を複製しない。業務上のSnapshot RevisionはConfirmed Ruleの必須項目だけをGroup内認可とRetentionの下で保持する候補とし、暗号化、保管形態、参照契約はConflictを解消する後続Security／Persistence設計のGateとする。

## Alternatives

### A. 3 Context + State model（採用）

Membership、Expense、Settlementの異なるInvariantと変更理由を分離しながら、MVPの契約・運用Costを抑える。Category Ownership、Expense予約、RetentionのContext間契約を追加で設計する必要がある。

### B. 単一Shared Expense Context + State model

TransactionとApplication Coordinationは単純になる。Group Lifecycle、OCR Draft、精算承認、Retentionの変更理由が集中し、将来のData Owner分離が難しくなる。

### C. 細粒度Context + 選択的Event Sourcing

Receipt、Reporting／Retentionまで分け、SettlementだけEvent Sourcingを使う。独立性と履歴再生は強いが、公開契約、Event schema、upcaster、Projection再構築、削除伝播、監視のCostが増える。

### D. 全Context Event Sourcing + CQRS

任意時点の再生とRead Model分離を最大化できる。MVPの規模に対してschema進化、機密除去、物理削除、Projection遅延、障害復旧のCostとRiskが最も大きい。

## Trade-offと影響

- Domain: AggregateをORM ModelやGraphQL Typeから独立して設計できる一方、Context間Invariantは同期Port、期待版、一意制約、補償のどれで守るかを明記する必要がある。
- Data: Data Ownerを明確にできる一方、Group削除とProjection再構築にはOwnerごとの冪等契約が必要になる。
- Security／Privacy: Data複製を抑えやすい一方、公開契約と履歴Recordごとに機密Dataの禁止項目を定義する必要がある。
- Snapshot: 技術Snapshotと業務上のSnapshot Revisionを区別する必要がある。業務必須Dataの最小化、暗号化、Group内認可、Retention、物理削除を決めるまでPersistence実装をReadyにできない。
- Operations: State modelは初期運用が軽い一方、全面的なEvent replayによる復元は提供しない。必要なimmutable業務履歴とbackup／restoreを個別に検証する。
- Delivery: Accepted後もContext Map、Repository／Port、Persistence、認可、Retention、Projectionを小さなTaskへ分割する。Acceptedだけで実装Readyにはならない。

## Owner Decision

- Decision: 案Aを条件付きでAccepted
- Decided by: Project Owner（takeshi-arihori）
- Decided at: 2026-09-06（Asia/Tokyo、承認時刻は未記録）
- Evidence: [GitHub ADR Issue #24](https://github.com/takeshi-arihori/kakei_app/issues/24)に会話の明示承認をAIが代理記録する。
- Owner statement: 「案Aを条件付きでAcceptedにする でお願いしたいと思います。再度確認し、問題なければ続けて。」
- Rationale: 案Aは責任分離を保ちながら、MVPの契約・運用Costを抑える。履歴は必要な業務記録として保持し、全面Event Sourcingと非同期Projectionの追加Costを初期から負担しない、という提案理由を前提にOwnerが採用を承認した。

提案作成・比較の履歴は[PR #25](https://github.com/takeshi-arihori/kakei_app/pull/25)に残す。PR #25のMergeはProposal文書の統合であり、採用承認は上記の会話による。

## 承認条件 C1: Snapshot Revisionの保護と保存

- State: 未充足
- Accountable Owner: Project Owner
- Due: 依存するPersistence実装TaskのReady判定前
- Evidence: 未提出。以下の設計文書、Security Decision、評価結果をリンクして追跡する。

1. 必須項目と保存しない項目を列挙し、Confirmed Ruleを満たす最小保存内容を定義する。
2. 暗号化の対象、方式、鍵の管理、Backupと復元時の保護を決定する。この承認で暗号方式やCloud Serviceを選定しない。
3. 現役参加者、脱退者、Owner等について、Group内の参照・操作権限と拒否時の振る舞いを明文化する。
4. Groupの保持期限、業務Data・Backup・Projectionの削除または失効、冪等な再試行と削除証跡を定義する。
5. 技術Snapshotと業務Snapshot Revisionの区別を含め、既存の「Event、Snapshot、Logへ機密平文を保存しない」と保存必須情報のConflictを解消する。既存禁止条件をこのADRで緩和しない。
6. 上記のSecurity／Privacy方式は別のADRとOwnerの明示承認で確定し、独立Security Reviewで条件充足を確認する。

条件を満たす証拠が揃うまで、依存するPersistence実装TaskはBacklog／Blocked YesとしReadyへ進めない。設計調査、条件を解消するProposal作成、承認済み3 Contextだけの可視化は、各TaskのReady評価を経て進められる。

Categoryの所属、個別Data Owner、Aggregate境界、Expense予約と競合のTransaction方式、Port契約、非同期Projectionは未決である。案AのAcceptedはこれらの採用、物理配置の製品選定、既存GraphQLやHonoの変更を含まない。

## Implementation after Acceptance

以下は後続Taskとして個別に起票・Ready評価する。条件C1の存在だけで、すべての設計TaskをBlockedにするわけではない。

1. Accepted境界のContext Mapと正式Mermaid図を作る。
2. AggregateごとのCommand、Invariant、期待版、Repository Portを具体化する。
3. Context間契約、認可、idempotency、失敗・補償を定義する。
4. Persistence、Migration、Retention、backup／restoreを設計する。
5. 必要性が測定されたQueryだけProjection、checkpoint、rebuild、削除伝播を設計する。
6. Snapshot Revisionの必須DataとArchitecture不変条件のConflictを解消し、最小化、暗号化、認可、保持・削除をSecurity Reviewする。

## Rollback

Proposed中はRepository ADRとGitHub ADR IssueをClose／Rejectedとして記録し、実装へ反映しなければ取り下げられる。Accepted後に問題が判明した場合はこのADRを直接書き換えず、新しいADRで変更案、Data移行、互換性、Rollbackまたはforward-fixを決める。実装前なら後続TaskをBacklogへ戻し、現行の未確定Gateを維持する。

## Review Trigger

- Project Ownerが選択肢または修正案を決定したとき
- Category、Receipt、SettlementのData Ownerを一意に定められない事例が出たとき
- Expense予約やGroup削除をContext間で安全に完了できないと判明したとき
- Settlement履歴の監査・再生要件がState modelで満たせないと判明したとき
- 非同期Projectionが必要な量、応答時間、可用性要件が確認されたとき
- Security／Privacy、保持期限、削除要件が変わったとき
