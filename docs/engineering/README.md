# 開発ガイド

このディレクトリは、GitHubの承認済み仕様を実装へ落とすためのリポジトリ内ガイドである。Project、Epic、Task、仕様、設計、ADRの正本はGitHubとする。

## AIが実装対象を決める順序

1. 利用者が指定したGitHub Taskを取得する。
2. TaskのStatusがReadyで、Requirement、Done Criteria、Dependencies、Estimate、Epic、Project、Decision Check、必要なRelated ADRが揃うことを確認する。
3. TaskからEpic、要求・要件、[08. 設計変更・意思決定](../governance/README.md)のAccepted ADR、対象設計文書を辿る。
4. Bounded Context、Aggregate、画面、GraphQL、Data、Security、Operationsへの影響を整理する。
5. 仕様の不足・矛盾・未承認Decisionがあれば実装せず、Working Assumptionと影響を示して解消する。
6. TDDの最初の失敗Testと、PR前に更新する文書を決めてからコードを変更する。

Taskが指定されていない場合、AIはコードの見た目だけから次の機能を選ばない。GitHubのReady Taskを確認し、複数候補がある場合は利用者へ選択を求める。

現行モデルのConfirmed Ruleと未確定Gateを区別する。個人用家計、2人限定、日付境界、単一Payer／Payeeを前提とする旧節を現行仕様として実装しない。

## ガイド一覧

- [domain-design.md](domain-design.md): DDD、Value Object、Entity、Aggregate、Domain Event、CQRS／Event Sourcing
- [coding-standards.md](coding-standards.md): TypeScript、単一責任、依存、Error、Security
- [frontend.md](frontend.md): Frontendの責務、構成、状態、Accessibility
- [testing.md](testing.md): TDD、Test Level、Done Criteria
- [delivery-workflow.md](delivery-workflow.md): Epic／Task、Git、PR、文書更新
- [08. 設計変更・意思決定](../governance/README.md): ADR、未確定事項、文書間Conflict、廃止履歴

## 変更種別から読む文書

| 変更 | 必ず読む | 追加確認 |
| --- | --- | --- |
| Domain Rule／Aggregate／Event | domain-design、testing | DDD・UML、ADR、Event Schema |
| GraphQL／Application Use Case | domain-design、coding-standards、testing | 要件定義、Architecture、Schema |
| Frontend／画面 | frontend、testing | 画面遷移、UX/UI、GraphQL Operation |
| Prisma／Migration／Read Model | domain-design、coding-standards、testing | ER図、Migration、Rebuild計画 |
| 認証／認可／削除 | coding-standards、testing | Security、ADR、Runbook |
| CI／Cloud／運用 | delivery-workflow、testing | Architecture、Security、Runbook、ADR |

## 正本の入口

- [正本参照先と切替記録](../governance/README.md)
- [Product Scope・業務モデル](../product/current-model.md)
- [未確定・未移行Gate](../product/design-gates.md)

Notionは読み書きしない。旧ページや削除済みDatabaseを作業条件にしない。管理先の切替によって業務上の未確定事項が解消したとみなさない。
