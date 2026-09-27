# 開発ガイド

このディレクトリは、GitHubの承認済みRequirement／Decisionを実装へ落とすための静的ルールを管理する。作業手順は`.agents/skills/`、設計からDeliveryまでの状態遷移は[Engineering Loop](engineering-loop.md)で管理し、同じRule本文をSkillへ複製しない。

## まず読むもの

1. [Engineering Loop](engineering-loop.md): 要求検証 → 要件化 → 設計 → Epic／Task → TDD → Self Review → 独立Evaluator → Draft PR
2. [Skillガバナンス](skill-governance.md): `docs`とSkillの責務分離
3. [Delivery Workflow](delivery-workflow.md): Epic／Task、Ready、Branch、Commit、PR、文書更新
4. [PR依存関係Gate](pr-dependency-gate.md): Task／PR依存、Stacked PR、Merge順序
5. 変更範囲に対応する静的ルールだけを追加で読む

## 正本の原則

- Requirement／Done Criteria: GitHub Issue
- 重要Decision: Accepted ADR
- Project固有・技術固有Rule: `docs/`
- Workflow: `.agents/skills/`
- Engineering Loop: `docs/engineering/engineering-loop.md`

Skillは特定の言語、DB、Framework、ORM、API Protocol、Runtimeを固定しない。採用技術と具体Ruleはこのディレクトリおよび関連`docs/`から取得する。詳細は[Skillガバナンス](skill-governance.md)を参照する。

## 静的ルール

- [backend.md](backend.md): Backendの責務、Layer、依存方向、Repository固有構成
- [domain-modeling.md](domain-modeling.md): Domain Modeling、Evidence、Knowledge State、Concept／Boundary候補の判断Rule
- [domain-design.md](domain-design.md): DDD、Domain要素、Transaction／Event等の設計Rule
- [specification-contract.md](specification-contract.md): PRE／POST／INV／FAIL、責務分類、Test Trace
- [coding-standards.md](coding-standards.md): 採用言語のCoding、単一責任、Error、Security、Documentation Rule
- [frontend.md](frontend.md): Frontendの責務、構成、状態、Accessibility
- [testing.md](testing.md): TDD、Test Level、検証Command、Done Criteria
- [delivery-workflow.md](delivery-workflow.md): Epic／Task、Ready、Git、PR、文書更新
- [worktree-management.md](worktree-management.md): Project root内の追加Worktree配置・作成・後片付け
- [codex-configuration.md](codex-configuration.md): Codex設定の責務、監査、trust・実効権限の確認
- [pr-dependency-gate.md](pr-dependency-gate.md): Task／PR依存とStacked PR
- [stacked-pr-delivery.md](stacked-pr-delivery.md): gh-stackとRepository RuleのIntegration境界
- [diagram-governance.md](diagram-governance.md): 正式図、Knowledge State、検討用入力との境界
- [08. 設計変更・意思決定](../governance/README.md): ADR、未確定事項、文書Conflict
- [API設計書](../api/README.md): 現行の公開契約方式とその正本

## Skill構成

`feature-development`はReadyな変更の実作業を統括し、必要なSkillだけを選択する。`implement-github-task`はGitHub Lifecycleと独立Evaluator、Draft PRまでを担当する。設計前のEpic／Task作成は`prepare-github-work`を入口にする。PlanningでStacked PRが必要と確定した場合だけ、実Deliveryを`stacked-pr-delivery`へ委譲する。

| Skill | Workflow上の責務 |
| --- | --- |
| `prepare-github-work` | 要求・設計成果をEpic／Task／Dependencies／Ready状態へ変換 |
| `implement-github-task` | Ready TaskのBranch開始、実作業委譲、独立評価、Draft PR |
| `stacked-pr-delivery` | Planning済みStacked PRの作成・同期・PR Base／Dependency検証・親Merge後の追従 |
| `feature-development` | 変更種別のRouting、TDD、実装、Self Reviewの修正Loop |
| `pre-investigation` | 現状、Gap、Domain要素、設計品質、影響範囲の調査 |
| `domain-design` | 確認済み業務RuleをDomain設計へ変換 |
| `api-design` | 確認済みUse Caseを公開契約へ変換 |
| `database-change` | 確認済みDomain／Application契約をPersistence変更へ変換 |
| `testing` | Requirement／契約からTest／検証を設計・実行 |
| `implementation` | 確定設計とRed Testから最小差分を実装 |
| `code-review` | 最終DiffをRequirement、Design、docs、Testへ照合 |

専門Skill:

- `domain-modeling`: 業務Concept、Rule、Invariant、境界の発見／検証
- `specification-contract`: 個別操作をPRE／POST／INV／FAILとTestへTrace
- `solid-ddd-pr-review`: DDD／SOLID／DRY等、Repository docsが定める設計品質の専門Review
- `prepare-pr-evidence`: 必要な視覚証跡等の準備

具体技術名は上表のSkill責務ではなく、変更時点の`docs/`から解決する。

## 変更種別から読むRule

| 変更の概念 | 先に確認する正本 |
| --- | --- |
| Domain理解／Modeling | `domain-modeling.md`、関連Product／Domain docs、Accepted ADR |
| Domain Rule／Aggregate／Event | `domain-design.md`、関連Product／Domain docs、Accepted ADR |
| Use Case契約 | `specification-contract.md`、`domain-design.md`、`testing.md` |
| 公開API契約 | `docs/api/`、`backend.md`、Security／Testing関連docs |
| Persistence／Migration | `backend.md`、`domain-design.md`、Data／Testing関連docs |
| Production Code | 対象Layerのdocs、`coding-standards.md`、`testing.md` |
| Frontend | `frontend.md`、`coding-standards.md`、`testing.md` |
| Security／Privacy | 対象Security／Architecture docs、Accepted ADR |
| CI／Cloud／Operations | 対応するArchitecture／Operations docs、`delivery-workflow.md`、`testing.md` |
| 文書・Skillのみ | 対象正本、`skill-governance.md`、`testing.md` |

## 正本の入口

- [正本参照先と切替記録](../governance/README.md)
- [Product Scope・業務モデル](../product/current-model.md)
- [未確定・未移行Gate](../product/design-gates.md)
- [API設計書](../api/README.md)

Notionは読み書きしない。旧URL等は出典識別子としてのみ扱い、現行判断の正本にしない。
