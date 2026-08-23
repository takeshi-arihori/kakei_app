# 開発ガイド

このディレクトリは、Notionの承認済み仕様を実装へ落とすためのリポジトリ内ガイドである。Project、Epic、Task、仕様、設計、ADRの正本はNotionとする。

## AIが実装対象を決める順序

1. 利用者が指定したNotion Taskを取得する。
2. TaskのStatusがReadyで、Requirement、Done Criteria、Dependencies、Estimate、Epic、Project、Decision Check、必要なRelated ADRが揃うことを確認する。
3. TaskからEpic、要求・要件、[08. 設計変更・意思決定](https://app.notion.com/p/3a906467984f810b8ac7d4d416cc5296)のAccepted ADR、対象設計文書を辿る。
4. Bounded Context、Aggregate、画面、GraphQL、Data、Security、Operationsへの影響を整理する。
5. 仕様の不足・矛盾・未承認Decisionがあれば実装せず、Working Assumptionと影響を示して解消する。
6. TDDの最初の失敗Testと、PR前に更新する文書を決めてからコードを変更する。

Taskが指定されていない場合、AIはコードの見た目だけから次の機能を選ばない。NotionのReady Taskを確認し、複数候補がある場合は利用者へ選択を求める。

Notionの各ページに新旧の節が併存する場合は、日付が新しいだけでなく「現時点の確定仕様」「現在の業務ルール」など現行であることを明示した先頭節を優先する。個人用家計、2人限定、日付境界、単一Payer／Payeeを前提とする旧節を現行仕様として実装しない。

## ガイド一覧

- [domain-design.md](domain-design.md): DDD、Value Object、Entity、Aggregate、Domain Event、CQRS／Event Sourcing
- [coding-standards.md](coding-standards.md): TypeScript、単一責任、依存、Error、Security
- [frontend.md](frontend.md): Frontendの責務、構成、状態、Accessibility
- [testing.md](testing.md): TDD、Test Level、Done Criteria
- [delivery-workflow.md](delivery-workflow.md): Epic／Task、Git、PR、文書更新
- [08. 設計変更・意思決定](https://app.notion.com/p/3a906467984f810b8ac7d4d416cc5296): ADR、未確定事項、文書間Conflict、廃止履歴

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

- [家計アプリ](https://app.notion.com/p/39b06467984f80c3ac94d78ef95ad49f): 現行8分類の入口
- [Requirement・Scope](https://app.notion.com/p/3a906467984f8180a7f3e4220eeaa47a)
- [業務内容・業務ルール](https://app.notion.com/p/3a906467984f8015b763fe95859ea6ec)
- [用語定義](https://app.notion.com/p/3a906467984f818b8a84d0b559cb6676)
- [ユーザージャーニー・ユースケース](https://app.notion.com/p/3a906467984f817a9a5ac19b4be025bd)
- [ドメイン設計](https://app.notion.com/p/3a906467984f80728058c839a403e6f0)
- [04. アーキテクチャ・非機能](https://app.notion.com/p/3a906467984f809f8332c8a274e0bcc6)
- [07. 品質・デリバリー・運用](https://app.notion.com/p/3a906467984f801a8e9bc92116c5cdf6)
- [08. 設計変更・意思決定](https://app.notion.com/p/3a906467984f810b8ac7d4d416cc5296)
- [未確定事項・Documentation Conflict](https://app.notion.com/p/3a906467984f814ba736c627901ead38)

Property付きProject／Epic／Task／ADR管理先は再構築中であり、現時点ではReady判定を満たせない。移行元の削除済みDatabaseや旧Statusを現在の進捗として扱わず、管理先が確定するまでReadyを捏造しない。
