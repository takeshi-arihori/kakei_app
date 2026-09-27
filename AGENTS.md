# 家計アプリ 開発ルール

## 正本と入口

- 利用者の最新の明示指示を最優先する。
- Notionは読み書きしない。GitHub IssueをRequirement／Done Criteria、Private Projectを進捗、Repositoryを仕様・設計・ADRの正本とする。
- GitHubの取得先や固定Commitは[正本入口](docs/governance/README.md)で確認する。
- 設計・実装を始める前に最新`develop`を確認する。
- 設計からDraft PRまでの標準状態遷移は[Engineering Loop](docs/engineering/engineering-loop.md)を正本とする。
- 詳細Ruleの入口は[開発ガイド](docs/engineering/README.md)とする。必要な文書だけを読む。
- GitHub正本とCodeが矛盾する場合は実装で吸収せず、Conflictとして扱う。

## docsとSkillの責務

[Skillガバナンス](docs/engineering/skill-governance.md)を守る。

```text
AGENTS.md     : 入口・Gate・Routing
Engineering Loop: 状態遷移
.agents/skills: 作業Workflow
Repository docs: Project固有・技術固有Rule
```

Skillは特定のProgramming Language、DB、Framework、ORM、API Protocol、Runtime、Cloud製品を固定ルールとして持たない。変更時点のRepository docsから採用技術と具体Ruleを取得する。採用技術が変わってもWorkflowが同じならSkillは変更しない。

## 再設計時の原則

既存技術、既存設計、既存Directory、既存Codeを確定事項として扱わず、現在のRequirementとAccepted Decisionに基づいて再評価する。

初回調査では変更せず、`pre-investigation`で最低限次を整理する。

1. 現在の設計・実装・Test
2. 変更に関係するEntity／Value Object／Aggregate／Domain Service／Domain Event等
3. Requirementとの不足・矛盾
4. SOLID／DRY／依存方向／責務分離
5. 影響範囲と再設計が必要な箇所

調査結果から変更が必要と判断した後、Engineering Loopに従って設計・実装へ進む。

## Project構成

Directoryの責務と採用技術はRepository docsを正本とする。Rootでは入口だけを示す。

- `apps/web`: Web Application
- `apps/api`: Backend API
- `apps/worker`: Background／Async処理用。作成条件はAccepted Designに従う
- `packages`: 複数Applicationで共有する必要性がAcceptedされた場合だけ追加する
- `infra`: Local／Cloud環境
- `docs`: 静的な仕様・設計・Rule
- `.agents/skills`: 再利用可能な作業Workflow
- `.codex`: Project-local Codex Harness／custom agent設定

具体的なArchitecture、Layer、Directory配置、Protocol、Data Store、Coding Ruleは[開発ガイド](docs/engineering/README.md)から対象文書を読む。

## 作業の入口

```text
要求・設計・作業分解
    └─ prepare-github-work

Ready TaskのDelivery
    └─ implement-github-task
          ├─ feature-development
          └─ stacked-pr-delivery（PlanningでStacked PR確定時のみ）
```

`feature-development`は変更内容から必要なSkillだけを選ぶ。`stacked-pr-delivery`はStack要否を決めず、Planning済みDependency Graphを実際のBranch／PRへ反映する。

| 作業 | Skill |
| --- | --- |
| 現状・Gap・影響範囲の事前調査 | `pre-investigation` |
| Domain設計 | `domain-design` |
| 公開API契約設計 | `api-design` |
| Persistence変更設計 | `database-change` |
| Production変更 | `implementation` |
| TDD／検証／回帰 | `testing` |
| 最終Diffのセルフレビュー | `code-review` |
| Planning済みStacked PRの作成・同期・追従 | `stacked-pr-delivery` |

専門Skillは必要時だけ利用する。

- `domain-modeling`: 業務Concept／Rule／Invariant／境界の発見・検証
- `specification-contract`: PRE／POST／INV／FAILとTest Trace
- `solid-ddd-pr-review`: Repository docsが定めるDDD／SOLID／DRY等の専門Review
- `prepare-pr-evidence`: 必要なPR Evidence

個別Skillから`feature-development`を呼び戻さず、統括Skillだけが全体順序を決める。

## Design Gate

- 未確定のProduct／Architecture Decisionに依存するTaskをReadyまたは実装へ進めない。
- ADR必須条件、Ready条件、文書影響、公開Gateは[Delivery Workflow](docs/engineering/delivery-workflow.md)と[正本入口](docs/governance/README.md)に従う。
- 依存Task／PRとStacked PRは[PR依存関係Gate](docs/engineering/pr-dependency-gate.md)に従う。
- 採用済みDecisionを変更する場合、AIが暗黙にAccepted扱いしない。

## 独立Evaluator Harness

Project-local custom agentは`.codex/config.toml`で宣言する。

- `work_planning_evaluator`: 要求・設計・Epic／Task／Dependencies／Ready判定をread-onlyで独立評価
- `task_evaluator`: 実装後の最新Diff、Test、docs、Requirement整合をread-onlyで独立評価

親AgentだけがCode、文書、GitHub状態を変更する。Evaluatorの`fail`は親Agentが修正・再検証し、**新しいEvaluator**で再評価する。`blocked`は阻害要因を解消するまで依存作業を止める。`pass`かつFinding／不足Evidenceなしの場合だけ次のDelivery段階へ進む。

## Git・Pull Request

Branch、Commit、PR、Squash merge、公開前確認、PR Template、文書同期の具体Ruleは[Delivery Workflow](docs/engineering/delivery-workflow.md)を正本とする。

Root Gateとして次だけを守る。

- `develop`を統合Branchとし、直接Pushしない。
- 1 Task／1 Branch／1 PRを基本とする。
- Commitはレビュー可能な論理単位にする。
- PR作成前にSelf Reviewと独立`task_evaluator`を完了する。
- PR Ready化・Mergeは利用者の明示依頼がある場合だけ行う。

## 完了条件

- Requirement／Done Criteria → Design → Test／Verification → Diff → ReviewをTraceできる。
- 使用したSkillと省略したSkill、その理由を説明できる。
- 関連docs、Issue、Schema、ADR、Runbook等の更新要否を説明できる。
- 実行しなかった検証と残Riskを明示する。
- Self Reviewで重大Findingが残っていない。
- 最新評価対象に対して独立`task_evaluator`が`pass`している。

## 詳細ルール

- Engineering Loop: [engineering-loop.md](docs/engineering/engineering-loop.md)
- Skill責務: [skill-governance.md](docs/engineering/skill-governance.md)
- Backend: [backend.md](docs/engineering/backend.md)
- Domain Design: [domain-design.md](docs/engineering/domain-design.md)
- Coding: [coding-standards.md](docs/engineering/coding-standards.md)
- Frontend: [frontend.md](docs/engineering/frontend.md)
- Testing: [testing.md](docs/engineering/testing.md)
- Delivery: [delivery-workflow.md](docs/engineering/delivery-workflow.md)
- PR Dependencies: [pr-dependency-gate.md](docs/engineering/pr-dependency-gate.md)
- Diagram: [diagram-governance.md](docs/engineering/diagram-governance.md)
- Governance／ADR: [docs/governance/README.md](docs/governance/README.md)
