# ADR-0010: 外部明細取込方針（廃止）

- Status: Superseded
- Date: 2026-07-12
- Area: Architecture
- Related Notion Task: なし（移行済みNotion ADRを参照）
- Legacy Source: https://app.notion.com/p/39a06467984f8108b319f9417df39554

## Context

外部明細取込を現行要件から削除した。

## Decision

- 外部明細取込に関する要求を現行スコープへ含めない。
- 関連する設計・実装Taskを作成しない。
- 将来必要になった場合は、要求分析と新しいADRから開始する。

## Alternatives

- 既存方針を維持する: 現行MVPの要求と一致しないため採用しない。

## Consequences

- 現行のTransactionは利用者がアプリ内で入力したDataだけを扱う。

## Implementation

- 外部明細取込に関する設計・Taskを現行スコープへ追加しない。

## Review Trigger

- 外部明細取込が新しい要求として承認された場合。
