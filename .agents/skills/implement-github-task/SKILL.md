---
name: implement-github-task
description: Ready済みGitHub TaskのDelivery Lifecycleを管理し、実作業をfeature-developmentへ委譲した後、独立Evaluatorを経てDraft PRまで届ける。
---

# GitHub Task Delivery

Ready済みTaskを、[Engineering Loop](../../../docs/engineering/engineering-loop.md)の実装フェーズに従ってDraft PRまで届ける。Notionは読み書きしない。

本SkillはGitHub Lifecycle、独立Evaluator、Draft PRを担当し、設計・TDD・Production変更・Self Reviewは`feature-development`へ委譲する。PlanningでStacked PRが必要と確定している場合、Stackの作成・同期・PR Base／Dependency検証は`stacked-pr-delivery`へ委譲する。

## 最初に読む

- [Engineering Loop](../../../docs/engineering/engineering-loop.md)
- [Skillガバナンス](../../../docs/engineering/skill-governance.md)
- [Delivery Workflow](../../../docs/engineering/delivery-workflow.md)
- [PR依存関係Gate](../../../docs/engineering/pr-dependency-gate.md)
- [正本入口](../../../docs/governance/README.md)
- 対象Task、Epic、Dependencies、Accepted ADR、関連docs

具体的なBranch、Commit、PR、公開Gate、Test Command等のRuleはRepository docsを正本とする。特定の言語、DB、Framework、API方式を仮定しない。

## I0. Taskと作業環境を固定する

1. TaskがRepositoryのReady条件を満たすか確認する。
2. Task、Requirement、Done Criteria、Dependencies、Decision、関連docsを取得する。
3. 現在Branch、作業Tree、Remote、最新`develop`、同TaskのOpen PRを確認する。
4. Dependencyがある場合、[PR依存関係Gate](../../../docs/engineering/pr-dependency-gate.md)に従って通常BranchかStacked Branchかを確認する。PlanningでStacked PRが確定済みなら`stacked-pr-delivery`へTask、直接Base、Dependency Graph、Merge順序を渡し、Branch／Stack状態を準備する。
5. 無関係または所有者不明の変更を移動、破棄、Stage、Commitしない。
6. GitHubへの書き込み前にRepositoryの公開Gateを確認する。

ReadyでないTask、未承認Decisionに依存するTask、前提Dependencyを満たさないTaskは実装へ進めない。Stack要否や直接BaseがPlanningで未確定の場合、I0で推測せず`prepare-github-work`へ戻す。

## 実作業を委譲する

`feature-development`へ次を渡す。

- Task／Requirement／Done Criteria
- Accepted ADR／関連docs
- 基準Commit
- Dependency／Stack情報
- 既知制約とOpen Question

`feature-development`が必要な調査・設計・TDD・実装・検証・Self Reviewを組み合わせる。

## I5. 4専門Reviewer Loop

Self Review後、[検証・独立評価・Draft PR](references/delivery.md)に従って最新対象を固定し、4つの専門Roleを別Threadで起動する。共通入力／結果、起動境界、修正上限と停止条件は[4専門Review](../../../docs/engineering/implementation-review.md)から取得する。

原結果を保持して集計する。failでは`feature-development`へScope内修正・再検証・Self Reviewを返し、4役すべてを新しいThreadで再評価する。blocked／上限では依存Deliveryを停止する。同じ最新対象の全員passかつFinding／不足Evidenceなしの場合だけI6へ進む。

Reviewerはread-only。旧Evaluatorを追加で起動せず、Planningの独立評価は維持する。

## I6. Draft PR

同じ最新対象の4役すべてのpass後だけ、RepositoryのDelivery Ruleに従ってCommit、Push、Draft PR、Issue追跡を完了する。

Stacked PRの場合は`stacked-pr-delivery`へ最新Diff、Task、直接Base、Dependency、Evaluator結果を渡し、[PR依存関係Gate](../../../docs/engineering/pr-dependency-gate.md)に一致するPR Base、`Depends-On`、Stack順序を維持してDraft PRを作成・検証する。Stack操作で評価対象Diffが変化した場合は、同Skillの再検証条件に従ってSelf Reviewと4役すべての新しいThreadでのReviewまで戻す。

PR Ready化・Mergeは利用者の明示依頼がある場合だけ行う。

## 出力

- Task／Requirement／Done Criteria
- 使用／省略Skill
- 実装・文書差分
- TDD／Verification結果
- Self Review結果
- Independent Evaluator結果
- Dependency／Stack状態
- Branch／Commit／Draft PR
- 未実施検証、Open Question、残Risk

## 完了条件

- Taskと最終DiffをTraceできる。
- 必要なSelf ReviewとVerificationが完了している。
- 最新評価対象に対して4役すべてが同じ最新対象へpassしている。
- 公開Gateを満たしたDraft PRがTaskへLinkされている。
- Dependencies／Stack状態がPRと一致している。
- 未実施検証、未決事項、残Riskが明示されている。
