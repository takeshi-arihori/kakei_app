# ADR-0011: Accepted ADRをリポジトリで管理

- Status: Accepted
- Date: 2026-07-19
- Area: Architecture
- Related Notion Task: なし（利用者の明示指示）
- Supersedes: Notion ADRデータベースをAccepted ADRの正本とする運用

## Context

採用済みのアーキテクチャ判断を実装差分と同時にレビューし、変更履歴、検索、参照をコードと同じVersionで管理する必要がある。

## Decision

- Accepted／Superseded ADRの正本を`docs/adr`とする。
- Notionは判断候補と関連Taskの整理に限定する。
- ADRの追加・置換は実装と同じPull Requestでレビューする。

## Alternatives

- Notionだけで管理する: 実装CommitとのVersion対応とCode Reviewが弱くなる。
- NotionとRepositoryを両方正本にする: 同期漏れと判断の不一致が起きる。

## Consequences

- ADRが実装と同じ履歴で追跡できる。
- Notionの仕様・TaskからRepository ADRへの参照を維持する必要がある。

## Implementation

- 既存のAccepted 8件とSuperseded 1件を`docs/adr`へ移行する。
- AI／開発ルールのADR参照先を`docs/adr`へ変更する。

## Review Trigger

- Repositoryを分割し、単一の`docs/adr`ではDecisionの所有権を表せなくなった場合。
