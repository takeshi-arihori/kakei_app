# 開発ガイド

このディレクトリは、Notionの承認済み仕様を実装へ落とすためのリポジトリ内ガイドである。Project、Epic、Task、仕様、設計の正本はNotion、Accepted／Superseded ADRの正本は[`docs/adr`](../adr/README.md)とする。

## AIが実装対象を決める順序

1. 利用者が指定したNotion Taskを取得する。
2. TaskのStatusがReadyで、Requirement、Done Criteria、Dependencies、Estimate、Epic、Projectが揃うことを確認する。
3. TaskからEpic、要求・要件、`docs/adr`のAccepted ADR、対象設計文書を辿る。
4. Bounded Context、Aggregate、画面、GraphQL、Data、Security、Operationsへの影響を整理する。
5. 仕様の不足・矛盾・未承認Decisionがあれば実装せず、Working Assumptionと影響を示して解消する。
6. TDDの最初の失敗Testと、PR前に更新する文書を決めてからコードを変更する。

Taskが指定されていない場合、AIはコードの見た目だけから次の機能を選ばない。NotionのReady Taskを確認し、複数候補がある場合は利用者へ選択を求める。

## ガイド一覧

- [domain-design.md](domain-design.md): DDD、Value Object、Entity、Aggregate、Domain Event、CQRS／Event Sourcing
- [coding-standards.md](coding-standards.md): TypeScript、単一責任、依存、Error、Security
- [frontend.md](frontend.md): Frontendの責務、構成、状態、Accessibility
- [testing.md](testing.md): TDD、Test Level、Done Criteria
- [delivery-workflow.md](delivery-workflow.md): Epic／Task、Git、Issue、PR、文書更新
- [../adr/README.md](../adr/README.md): ADRの作成・承認・置換ルールと一覧

## 変更種別から読む文書

| 変更 | 必ず読む | 追加確認 |
| --- | --- | --- |
| Domain Rule／Aggregate／Event | domain-design、testing | DDD・UML、ADR、Event Schema |
| GraphQL／Application Use Case | domain-design、coding-standards、testing | 要件定義、Architecture、Schema |
| Frontend／画面 | frontend、testing | 画面遷移、UX/UI、GraphQL Operation |
| Prisma／Migration／Read Model | domain-design、coding-standards、testing | ER図、Migration、Rebuild計画 |
| 認証／認可／削除 | coding-standards、testing | Security、ADR、Runbook |
| CI／Cloud／運用 | delivery-workflow、testing | Architecture、Security、Runbook、ADR |

## Notion参照元

- [00 プロジェクト指示書](https://app.notion.com/p/39b06467984f81808c30ed523b4c9164)
- [02 要件定義](https://app.notion.com/p/39a06467984f81089b64c0ceaeacae2a)
- [05 DDD・Context Map・ユビキタス言語](https://app.notion.com/p/39a06467984f81e98cd2d669dc900b43)
- [06 ドメインモデル・集約・UML](https://app.notion.com/p/39a06467984f81b3b495f6ee2126fac5)
- [08 アプリケーション・インフラアーキテクチャ](https://app.notion.com/p/39a06467984f811c9461c0bb6bddbdb9)
- [10 開発ルール・Notion運用](https://app.notion.com/p/39a06467984f81ceadc7c3da95dfed68)
- [11 テスト・品質保証](https://app.notion.com/p/39a06467984f819e8dc7d6f57e50ae8a)
