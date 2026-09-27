---
name: prepare-github-work
description: 検証済み要求と設計成果を、RepositoryのDelivery Ruleに従ってGitHub Epic／Task／Dependencies／Ready状態へ変換する。
---

# GitHub作業項目の準備

要求を、別の開発者やAIが推測せず実装できるGitHub作業項目へ変換する。Notionは読み書きしない。

レビューのみの依頼では提案と評価までに留め、GitHubへの書き込みは依頼された場合だけ行う。

## 最初に読む

- [Engineering Loop](../../../docs/engineering/engineering-loop.md)の設計フェーズ
- [Skillガバナンス](../../../docs/engineering/skill-governance.md)
- [Delivery Workflow](../../../docs/engineering/delivery-workflow.md)
- [PR依存関係Gate](../../../docs/engineering/pr-dependency-gate.md)
- [正本入口](../../../docs/governance/README.md)
- 要求の変更範囲に対応するProduct／Domain／Architecture等のdocsとAccepted ADR

Epic／Task粒度、Ready、ADR、Project Field、公開Gate、Branch／PR等の具体RuleはRepository docsを正本とし、このSkillへ複製しない。特定の言語、DB、Framework、API方式を前提にTaskを作らない。

## Inputを検証する

1. [Engineering Loop](../../../docs/engineering/engineering-loop.md)のD0〜D2が成立しているか確認する。
2. Problem、Goal、Requirement、Done Criteria、Scope、設計結果、Open Questionを取得する。
3. 現状Evidence、既存Epic／Task、Accepted ADRを検索し、重複・包含関係を比較する。
4. 未決DecisionはClarification、調査Task、ADR Proposal等へ分離し、依存TaskをReadyにしない。

D0〜D2のEvidenceが不足する場合、作業項目を推測で完成させず、不足する前段へ戻す。

## Work Breakdown

[Delivery Workflow](../../../docs/engineering/delivery-workflow.md)の粒度Ruleに従って、必要な場合だけEpicを作り、独立して検証可能なTaskへ分解する。

各Taskへ少なくとも次をTraceする。

- Problem／Requirement／Done Criteria
- Scope／Out of scope
- 対象Context／Use Case／Ownership等、設計で確定した境界
- Dependencies
- Decision Check／Related ADR
- Test／Verification方針
- 更新対象docs

## Dependency／PR Planning

[PR依存関係Gate](../../../docs/engineering/pr-dependency-gate.md)に従い、Task Graphを作る。

- 並行可能Task
- 先行必須Task
- Code差分上の依存有無
- Stacked PRの要否
- Stackの場合の直接Base
- Merge順序
- 前提Merge後に必要な再検証

をPlanning段階で決める。

## 独立Planning Evaluator

保存前に[独立Planning評価と保存確認](references/delivery.md)に従い、新しい`work_planning_evaluator`へproposalを渡す。

- `pass`: GitHub更新を依頼されている場合だけ保存へ進む。
- `fail`: 親AgentがPlanningを修正し、新しいEvaluatorで再評価する。
- `blocked`: Owner Decision、権限、正本Conflict等を報告して依存作業を止める。

Evaluatorはread-onlyで、GitHub更新は親Agentだけが行う。

## 保存後

GitHubへ書き込んだ場合はIssue／Projectの実体を再取得し、proposalどおり永続化されたかを**別の新しいEvaluator**で確認する。

## 出力

- 使用／既存Epicと理由
- 作成／更新するTask
- Requirement／Done Criteria
- Dependency GraphとPR順序
- Ready判定
- Decision／ADR状態
- 未解決事項
- GitHub更新を行った場合のURLとpersisted評価

## 完了条件

- 要求からEpic／TaskまでTraceできる。
- 各TaskがRepositoryのReady Ruleで評価されている。
- DependenciesとDelivery順序が明示されている。
- 必要な場合のStacked PR計画がある。
- Planning Evaluatorで重大Findingと不足Evidenceが残っていない。
