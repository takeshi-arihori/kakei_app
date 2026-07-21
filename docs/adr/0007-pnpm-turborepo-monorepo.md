# ADR-0007: pnpm Workspace＋Turborepoモノレポ

- Status: Accepted
- Amended by: ADR-0013（Component／Package Directoryの作成時期）
- Date: 2026-07-11
- Area: Architecture
- Related Notion Task: なし（移行済みNotion ADRを参照）
- Legacy Source: https://app.notion.com/p/39a06467984f8105896dee216337f2a5

## Context

1人開発でWeb、API、Worker、共通設定を一貫して管理する。

## Decision

- pnpm lockfileをRootで一元管理する。
- Turborepoでlint、typecheck、test、build依存を定義する。
- WebへBackend Domainコードを共有しない。
- GraphQL生成型、Config、Test Utilityだけを必要範囲で共有する。

## Alternatives

- 別Repository: 独立性は高いが契約変更と1人運用の負荷が増える。
- Workspaceのみ: 可能だがTask Cache／Pipeline定義を活かしにくい。

## Consequences

- CI Cacheと一括変更が容易になるが、依存方向とDomain共有禁止を強制する必要がある。

## Implementation

- Package boundaryと循環依存をCIで検知する。

## Review Trigger

- TeamまたはDeploy単位がRepository分離を必要とする規模になった場合。
