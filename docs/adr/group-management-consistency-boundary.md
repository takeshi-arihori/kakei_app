# Group Managementの整合性境界とParticipantの表現

- Status: Proposed
- Decision record: [GitHub ADR #35](https://github.com/takeshi-arihori/kakei_app/issues/35)
- Related Task: [設計Task #37](https://github.com/takeshi-arihori/kakei_app/issues/37)
- Proposed Date: 2026-09-07
- Decision Owner: Project Owner
- Owner Decision / Accepted Date: 未取得
- Related ADR: [ADR #24](shared-expense-domain-boundaries.md)、[認可・再試行Proposal](group-management-command-authorization.md)
- Analysis: [最初の実装境界](../domain/group-management-first-boundary.md)
- Decision Check: 方針変更あり（未決のData Owner、Aggregate、Repository Portを具体化する）
- Relationship: ADR #24の未決詳細を補完する提案。Supersedesではない。C1は未充足のまま。

## Context

Active Groupには唯一のOwnerが必要で、譲渡先のActive在籍とOwnerの脱退禁止を同時に守る。1〜4人の人数制限は参加の競合でも維持する必要がある。ADR #24は個別Data Owner・Aggregate・Portを採用していない。

## Decision（提案A、未採用）

- Group ManagementをGroup・在籍・Owner RoleのData Ownerとし、Group Rootの同一版にActive ParticipantとOwner参照を含める。Ownerを独立Entityにしない。
- 1〜4人はActive在籍数として数え、同じ利用者の同Group内Active在籍を重複させない。ParticipantIdはGroup内の参加関係を識別する。脱退でIDを消さず、過去のExpense・Settlement参照を保つ。
- 参加順をGroup内で単調に採番し再利用しない。再参加時のID寿命・参加順は今回確定せず、再参加実装を後続に分離する。
- 最初はCreateGroup、TransferGroupOwnership、LeaveGroupを扱う。譲渡と脱退は別Command。自己譲渡はNo-op、別operationによる再脱退はAlreadyLeft。Archivedでの譲渡・脱退は初回契約外としてGroupNotActiveを返す。
- GroupRepositoryはload / commit / findOperationという分析文書の契約案とする。compare-and-swapで状態・版・必要履歴・operation結果を原子的に扱う。個別Participant／OwnerのRepositoryは公開しない。
- 招待消費・Participant追加の同時成立は後続設計が必要。内部の追加操作を認証・招待を迂回する公開Commandにしない。

## Alternatives

| Option | 利点 | 不利益 |
| --- | --- | --- |
| A: Group Root＋現在在籍＋Owner参照 | 人数・一意Owner・譲渡先在籍を1版で守る | 同Groupの書込が競合。長期の全履歴を毎回読み込まない保存設計が必要 |
| B: Participant独立Aggregate＋同期Coordinator | 在籍の独立更新に向く | 人数・OwnerのInvariantが跨り、同期的な原子性契約が増える |
| C: Ownerも独立Aggregate | Role管理を独立させやすい | Owner不在／重複を避けるため小規模Groupでも複数境界の調整が必要 |

## Consequences

最大4人の現在状態は小さいが、過去の在籍履歴は増える。State model＋必要な不変履歴を守り、Event Sourcing、ORM Model、DB製品、GraphQL Schemaは導入しない。Owner Roleの譲渡後も旧Ownerの在籍は維持する。Command認可・冪等再送の例外は別ADRと整合させる。

## Implementation / Acceptance Gate

OwnerはA/B/Cと、Active人数の解釈、重複禁止、操作分離、No-op／AlreadyLeft、Archivedと再参加の延期を明示判断する。部分承認なら承認された項目と依存Taskを個別に更新する。AcceptedまではDomain／Port実装TaskをReadyにしない。Accepted後も認可ADRの未決を推測せず、C1未充足ならPersistenceはBacklog / Blocked Yes。

正常作成、4人境界、Owner脱退、他Group・Leftへの譲渡、競合の勝者双方、応答喪失と二重送信を契約テストの受入例にする。拒否時は版・状態・履歴を変えない。

## Rollback / Review Trigger

Proposedの却下は案を取り下げ、依存Taskを現行Decisionへ戻して再評価する。実装済みDataは今回存在しない。採用後に変更が必要なら新ADRで互換性・移行を決める。再参加、4人超、Owner複数化、在籍履歴肥大化、Group終了との競合がReview Trigger。
