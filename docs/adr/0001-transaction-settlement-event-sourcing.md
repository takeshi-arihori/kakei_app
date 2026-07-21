# ADR-0001: Transaction・Settlement限定のEvent Sourcing

- Status: Accepted
- Date: 2026-07-11
- Area: Domain
- Related Notion Task: なし（移行済みNotion ADRを参照）
- Legacy Source: https://app.notion.com/p/39a06467984f812a9bfcf43cbdb9584f

## Context

取引と精算では編集・削除・復元・取消・監査・過去状態の再現が重要である。一方、認証、世帯、口座設定までEvent Sourcingへ広げると、1人開発のMVPとして複雑性が過大になる。

## Decision

- Transaction AggregateとSettlement AggregateだけをEvent Sourcingする。
- PostgreSQL Event Storeを正本とし、expectedVersionで楽観的ロックする。
- Snapshotは100イベント超過時、その後100イベントごとに作成する。
- Account Balance、Monthly Summary、Pairwise DebtはRead Modelとする。
- IAM、Household、Account、Categoryは状態保存する。

## Alternatives

- 全ContextをEvent Sourcing: 一貫するが複雑性・運用負荷が高すぎる。
- Event Sourcingを使わない: 実装は簡単だが、履歴・再構築・訂正Eventの要求を満たしにくい。

## Consequences

- Event Schema Version、Upcaster、Snapshot、Projection Rebuildが必要になる。
- AggregateごとのEvent列は分離し、Household全体を1 Aggregateにしない。

## Implementation

- 適用範囲を追加する場合は新しいADRを必須とする。

## Review Trigger

- Transaction／Settlementの運用負荷が価値を上回った場合。
- 別Contextで履歴正本が明確に必要になった場合。
