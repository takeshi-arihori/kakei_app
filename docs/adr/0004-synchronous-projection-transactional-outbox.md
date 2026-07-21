# ADR-0004: 同期Projection＋Transactional Outbox

- Status: Accepted
- Date: 2026-07-11
- Area: Architecture
- Related Notion Task: なし（移行済みNotion ADRを参照）
- Legacy Source: https://app.notion.com/p/39a06467984f810e9319c6adafb1b5db

## Context

更新直後の残高・未精算表示と、重い処理の確実な非同期実行を両立する。

## Decision

- 取引一覧、口座残高、二者間未精算額、精算一覧は同期更新する。
- 重い月次再集計、将来の通知・外部連携は非同期化する。
- Event、同期Projection、Outbox登録は同一PostgreSQL Transactionで行う。
- Workerは少なくとも1回配送を前提に冪等化する。

## Alternatives

- 全非同期: 更新直後の画面が一時的に古くなる。
- 全同期: 重い集計と外部障害がCommand Latencyへ影響する。

## Consequences

- 即時性と配送信頼性を得るが、同期Projection失敗時のRollbackと冪等Workerが必要になる。

## Implementation

- Outbox backlog、oldest age、retry、Projection lagを監視する。

## Review Trigger

- 同期更新がCommandのLatencyまたは可用性を損なう場合。
