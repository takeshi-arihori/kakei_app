# 開発ガイド

このディレクトリは、GitHubの承認済み仕様を実装へ落とすための静的なルールを管理する。Project、Epic、Task、仕様、設計、ADRの正本はGitHubとする。作業手順は`.agents/skills/`に分離し、同じルール本文をSkillへ複製しない。

## 機能Taskで確認する順序

1. 利用者が指定したGitHub Taskを取得する。
2. TaskのStatusがReadyで、Requirement、Done Criteria、Dependencies、Estimate、Epic、Project、Decision Check、必要なRelated ADRが揃うことを確認する。
3. TaskからEpic、要求・要件、[08. 設計変更・意思決定](../governance/README.md)のAccepted ADR、対象設計文書を辿る。
4. `pre-investigation`で現状、Domain要素、要件との差分、SOLID・依存方向、影響範囲を確認する。
5. 変更種別に応じて必要な設計Skillを使い、未承認Decisionがあれば依存作業を止める。
6. TDDの最初の失敗Test、実装、回帰検証、最終Reviewの順に進める。

利用者が対象を指定した文書・Skill整理は、その範囲で実施する。機能Taskを選ぶ場合にTaskが指定されていなければ、AIはコードの見た目だけから次の機能を選ばない。GitHubのReady Taskを確認し、複数候補がある場合は利用者へ選択を求める。

現行モデルのConfirmed Ruleと未確定Gateを区別する。個人用家計、2人限定、日付境界、単一Payer／Payeeを前提とする旧節を現行仕様として実装しない。

## 静的ルール

- [backend.md](backend.md): BackendのLayer、依存方向、Directory配置、GraphQL Presentation境界
- [domain-design.md](domain-design.md): DDD、Value Object、Entity、Aggregate、Domain Event、CQRS／Event Sourcing
- [coding-standards.md](coding-standards.md): TypeScript、単一責任、依存、Error、Security、日本語JSDoc
- [frontend.md](frontend.md): Frontendの責務、構成、状態、Accessibility
- [testing.md](testing.md): TDD、Test Level、Done Criteria
- [delivery-workflow.md](delivery-workflow.md): Epic／Task、Git、PR、文書更新
- [diagram-governance.md](diagram-governance.md): Mermaid図の正本、Knowledge State、draw.io検討用入力との境界
- [08. 設計変更・意思決定](../governance/README.md): ADR、未確定事項、文書間Conflict、廃止履歴

## Skill構成

`feature-development`が変更内容を判定して必要な個別Skillだけを組み合わせる。各個別Skillは単独利用も可能とし、個別Skillから`feature-development`へ戻る循環参照は作らない。

| Skill | 責務 |
| --- | --- |
| [feature-development](../../.agents/skills/feature-development/SKILL.md) | 機能変更全体のRouting、順序、成果物の引継ぎ |
| [pre-investigation](../../.agents/skills/pre-investigation/SKILL.md) | 現状、Domain要素、要件差分、SOLID・依存方向、影響範囲の調査 |
| [domain-design](../../.agents/skills/domain-design/SKILL.md) | Entity／VO／Aggregate／Domain Service／Domain Event／Portの設計 |
| [api-design](../../.agents/skills/api-design/SKILL.md) | GraphQL／HTTP公開契約、Error、認証認可境界、互換性 |
| [database-change](../../.agents/skills/database-change/SKILL.md) | Schema、Migration、Index、Constraint、Data移行、復旧 |
| [implementation](../../.agents/skills/implementation/SKILL.md) | 確定設計とRed Testに基づくProduction Code実装 |
| [testing](../../.agents/skills/testing/SKILL.md) | TDD、Test Level選択、検証、回帰 |
| [code-review](../../.agents/skills/code-review/SKILL.md) | 最終Diffの要件・設計・品質Review |

既存の専門Skillは上記を補助する。

- [domain-modeling](../../.agents/skills/domain-modeling/SKILL.md): 業務概念・Rule・Invariant・境界の発見／検証
- [specification-contract](../../.agents/skills/specification-contract/SKILL.md): PRE／POST／INV／FAILとTest Trace
- [solid-ddd-pr-review](../../.agents/skills/solid-ddd-pr-review/SKILL.md): SOLID／DRY／DDD／日本語JSDocの専門Review
- [prepare-pr-evidence](../../.agents/skills/prepare-pr-evidence/SKILL.md): 必要時のPR視覚証跡
- [prepare-github-work](../../.agents/skills/prepare-github-work/SKILL.md): Epic／Taskの作成・改善・Ready判定
- [implement-github-task](../../.agents/skills/implement-github-task/SKILL.md): Ready TaskのGitHub LifecycleとDraft PR delivery

旧Notion名のSkillは互換入口であり、Notionへ接続しない。

## 変更種別から読む文書とSkill

| 変更 | 静的ルール | 主なSkill |
| --- | --- | --- |
| Domain Rule／Aggregate／Event | backend、domain-design、testing | pre-investigation、domain-design、testing、code-review |
| GraphQL／HTTP API | backend、coding-standards、testing、API設計書 | pre-investigation、api-design、testing、code-review |
| DB／Migration／Read Model | backend、domain-design、coding-standards、testing | pre-investigation、database-change、testing、code-review |
| Application／Production Code | backend／frontend、coding-standards、testing | implementation、testing、code-review |
| Mermaid図／draw.io入力 | diagram-governance、delivery-workflow | 変更理由に対応する設計Skill、必要ならprepare-pr-evidence |
| 認証／認可／削除 | backend、coding-standards、testing | pre-investigation、api-design、必要ならdomain-design／database-change |
| 文書・Skillのみ | testingの検証Command、変更対象の参照元 | 対象Skill、testing、code-review |
| CI／Cloud／運用 | delivery-workflow、testing | pre-investigation、implementation、testing、code-review |

## 正本の入口

- [正本参照先と切替記録](../governance/README.md)
- [Product Scope・業務モデル](../product/current-model.md)
- [未確定・未移行Gate](../product/design-gates.md)
- [API設計書](../api/README.md)

Notionは読み書きしない。旧ページや削除済みDatabaseを作業条件にしない。管理先の切替によって業務上の未確定事項が解消したとみなさない。
