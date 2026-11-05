---
name: implement-github-task
description: GitHub Taskの着手時に調査、詳細記入、Ready判定を1回で行い、実作業をfeature-developmentへ委譲した後、独立Evaluatorを経てDraft PRまで届ける。
---

# GitHub Task Delivery

Taskを、[Engineering Loop](../../../docs/engineering/engineering-loop.md)の実装フェーズに従ってDraft PRまで届ける。Notionは読み書きしない。

本SkillはTask着手時の調査、詳細記入、Ready判定、GitHub Lifecycle、独立Evaluator、Draft PRを担当し、設計・TDD・Production変更・Self Reviewは`feature-development`へ委譲する。PlanningでStacked PRが必要と確定している場合、Stackの作成・同期・PR Base／Dependency検証は`stacked-pr-delivery`へ委譲する。

## 最初に読む

- [Engineering Loop](../../../docs/engineering/engineering-loop.md)
- [Skillガバナンス](../../../docs/engineering/skill-governance.md)
- [Delivery Workflow](../../../docs/engineering/delivery-workflow.md)
- [PR依存関係Gate](../../../docs/engineering/pr-dependency-gate.md)
- [正本入口](../../../docs/governance/README.md)
- 対象Task、Epic、Dependencies、Accepted ADR、関連docs

具体的なBranch、Commit、PR、公開Gate、Test Command等のRuleはRepository docsを正本とする。特定の言語、DB、Framework、API方式を仮定しない。

## I0. Taskに着手する

1. Task、親Epic、Dependencies、Decision、関連docsを取得する。
2. 現在Branch、作業Tree、Remote、最新`develop`、同TaskのOpen PRを確認する。
3. `pre-investigation`を1回行う。再利用できる調査があるかは[Engineering Loop](../../../docs/engineering/engineering-loop.md)のI0に従う。
4. GitHubへの書き込み前にRepositoryの公開Gateを確認する。
5. [Delivery Workflow](../../../docs/engineering/delivery-workflow.md)に従ってTaskの詳細をIssue本文へ書く。すでに書かれている場合は不足分だけ補う。PRサイズの目安を超えそうなら分割を検討する。
6. 同文書に従ってReady判定を行い、保存結果を再取得して比較する。
7. Dependencyがある場合、[PR依存関係Gate](../../../docs/engineering/pr-dependency-gate.md)に従って通常BranchかStacked Branchかを確認する。PlanningでStacked PRが確定済みなら`stacked-pr-delivery`へTask、直接Base、Dependency Graph、Merge順序を渡し、Branch／Stack状態を準備する。
8. 無関係または所有者不明の変更を移動、破棄、Stage、Commitしない。

Ready判定を満たさないTask、未承認Decisionに依存するTask、前提Dependencyを満たさないTaskは実装へ進めず、不足条件を報告する。Stack要否や直接BaseがPlanningで未確定の場合、I0で推測せず`prepare-github-work`へ戻す。

## 実作業を委譲する

`feature-development`へ次を渡す。

- Task／Requirement／Done Criteria
- Accepted ADR／関連docs
- 基準Commit
- I0の調査結果
- Dependency／Stack情報
- 既知制約とOpen Question

`feature-development`が必要な設計・TDD・実装・検証・Self Reviewを組み合わせる。調査はやり直さない。

## I5. 独立Reviewer Loop

Self Review後、[検証・独立評価・Draft PR](references/delivery.md)に従って最新対象を固定し、対象Roleを別のSubagentで起動する。起動条件、共通入力／結果、修正上限と停止条件は[独立Review](../../../docs/engineering/implementation-review.md)から取得する。

結果を集計する。failでは`feature-development`へScope内修正・再検証・Self Reviewを返し、failしたRoleが修正差分を再評価する。blocked／上限では依存Deliveryを停止する。最新対象を確認した対象Role全員のpassかつFinding／不足Evidenceなしの場合だけI6へ進む。

Reviewerはread-only。旧Evaluatorを追加で起動しない。

## I6. Draft PR

最新対象を確認した対象Roleすべてのpass後だけ、RepositoryのDelivery Ruleに従ってCommit、Push、Draft PR、Issue追跡を完了する。Issue・PR本文にはログを載せず、結論と要約だけを書く。

Stacked PRの場合は`stacked-pr-delivery`へ最新Diff、Task、直接Base、Dependency、Evaluator結果を渡し、[PR依存関係Gate](../../../docs/engineering/pr-dependency-gate.md)に一致するPR Base、`Depends-On`、Stack順序を維持してDraft PRを作成・検証する。Stack操作で評価対象Diffが変化した場合は、同Skillの再検証条件に従ってSelf Reviewと変わった差分のReviewまで戻す。

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
- 対象Roleすべてが最新評価対象を確認してpassしている。
- 公開Gateを満たしたDraft PRがTaskへLinkされている。
- Dependencies／Stack状態がPRと一致している。
- 未実施検証、未決事項、残Riskが明示されている。
